#!/usr/bin/env python3
"""
Browser owner for an Agent Computer guest.

Owns exactly ONE visible browser instance on the guest display (:0), driven by
Playwright's ASYNC API from a dedicated thread running its own event loop.
(Why async: Camoufox's sync wrapper internally runs an asyncio loop and
breaks when combined with a separate sync_playwright start — "Sync API
inside the asyncio loop". The async API is Camoufox's first-class path.)

Both the human (via the desktop) and the agent (via this API) use the same
window and the same persistent profile:

  - Camoufox engine -> profile dir ~/.camoufox-profile
  - Chromium engine -> profile dir ~/.config/agent-browser-profile

Element interaction uses Playwright's ARIA snapshot: snapshot() returns a
numbered element list (refs like "e1"); click_ref/fill_ref resolve a ref back
to a role+name locator. Refs are valid until the next snapshot or navigation.

Graceful close: close() shuts the context down cleanly so profile state
(cookies, local storage, session restore) is flushed before container stop.
"""
import asyncio
import concurrent.futures
import os
import re
import threading

# One ARIA snapshot line:  role "name" [flags]   (leaf nodes have no colon)
_EL_RE = re.compile(r'^([a-z]+)(?:\s+"([^"]*)")?')

PROFILE_DIRS = {
    "camoufox": os.path.expanduser("~/.camoufox-profile"),
    "chromium": os.path.expanduser("~/.config/agent-browser-profile"),
}


class BrowserOwner:
    def __init__(self):
        self._thread = None
        self._loop = None
        self._pw = None
        self._cfx = None          # AsyncCamoufox context manager (camoufox only)
        self._ctx = None
        self._page = None
        self.engine = None
        self._refs = {}           # ref -> (role, name)
        self._pending = set()
        self._pending_lock = threading.Lock()
        self._started = threading.Event()
        self._start_error = None
        self._shutdown = None     # asyncio.Event, created on the owner loop

    # ---- lifecycle (called from any thread; work runs on owner thread) ----
    def start(self, engine):
        if self._thread and self._thread.is_alive():
            return {"engine": self.engine, "already_running": True}
        self.engine = engine
        self._started.clear()
        self._start_error = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        if not self._started.wait(timeout=120):
            raise TimeoutError("browser start timed out")
        if self._start_error:
            raise RuntimeError(self._start_error)
        return {"engine": self.engine, "profile": PROFILE_DIRS[engine]}

    def _run(self):
        try:
            asyncio.run(self._amain())
        except Exception as e:  # loop-level failure
            if not self._started.is_set():
                self._start_error = f"{type(e).__name__}: {e}"
                self._started.set()

    async def _amain(self):
        self._loop = asyncio.get_running_loop()
        self._shutdown = asyncio.Event()
        try:
            from playwright.async_api import async_playwright
            profile = PROFILE_DIRS[self.engine]
            os.makedirs(profile, exist_ok=True)
            if self.engine == "camoufox":
                from camoufox.async_api import AsyncCamoufox
                self._cfx = AsyncCamoufox(
                    persistent_context=True, user_data_dir=profile,
                    headless=False,
                    **({"proxy": {"server": os.environ["ACP_BROWSER_PROXY"], "bypass": "localhost,127.0.0.1"}} if os.environ.get("ACP_BROWSER_PROXY") else {}))
                self._ctx = await self._cfx.__aenter__()
            else:
                self._pw = await async_playwright().start()
                self._ctx = await self._pw.chromium.launch_persistent_context(
                    profile, headless=False,
                    executable_path="/usr/bin/chromium",
                    **({"proxy": {"server": os.environ["ACP_BROWSER_PROXY"], "bypass": "localhost,127.0.0.1"}} if os.environ.get("ACP_BROWSER_PROXY") else {}),
                    args=["--no-first-run", "--disable-dev-shm-usage"])
            self._page = (self._ctx.pages[0] if self._ctx.pages
                          else await self._ctx.new_page())
            self._started.set()
        except Exception as e:  # surfaced to start() caller
            self._start_error = f"{type(e).__name__}: {e}"
            self._started.set()
            return
        await self._shutdown.wait()
        # graceful shutdown on the owner loop
        try:
            if self._cfx is not None:
                await self._cfx.__aexit__(None, None, None)
            elif self._ctx:
                await self._ctx.close()
            if self._pw:
                await self._pw.stop()
        except Exception:
            pass

    def call(self, coro_fn, *args, timeout=60):
        if not self._thread or not self._thread.is_alive() or not self._loop:
            raise RuntimeError("browser not running")
        fut = asyncio.run_coroutine_threadsafe(coro_fn(*args), self._loop)
        with self._pending_lock:
            self._pending.add(fut)
        try:
            return fut.result(timeout=timeout)
        except TimeoutError:
            fut.cancel()
            raise TimeoutError("browser call timed out")
        except concurrent.futures.CancelledError as error:
            raise InterruptedError("human_control") from error
        finally:
            with self._pending_lock:
                self._pending.discard(fut)

    def cancel_input(self):
        with self._pending_lock:
            for future in list(self._pending):
                future.cancel()

    def close(self):
        if self._thread and self._thread.is_alive() and self._loop:
            self._loop.call_soon_threadsafe(self._shutdown.set)
            self._thread.join(timeout=30)

    # ---- operations (coroutines, executed on the owner loop) ----
    async def _state(self):
        return {
            "engine": self.engine,
            "url": self._page.url if self._page else None,
            "title": (await self._page.title() if self._page else None),
            "pages": len(self._ctx.pages) if self._ctx else 0,
        }

    def state(self):
        return self.call(self._state)

    async def _goto(self, url):
        await self._page.goto(url, wait_until="domcontentloaded",
                              timeout=45000)
        self._refs = {}
        return await self._state()

    def goto(self, url):
        return self.call(self._goto, url, timeout=90)

    async def _snapshot(self):
        aria = await self._page.locator("body").aria_snapshot()
        refs = []
        self._refs = {}
        n = 0
        for raw_line in aria.splitlines():
            line = raw_line.strip().lstrip("- ").strip()
            m = _EL_RE.match(line)
            if not m:
                continue
            role, name = m.group(1), m.group(2) or ""
            if role in ("link", "button", "textbox", "checkbox", "radio",
                        "combobox", "tab", "menuitem", "option", "searchbox",
                        "spinbutton", "slider", "switch", "listbox"):
                n += 1
                ref = f"e{n}"
                self._refs[ref] = (role, name)
                refs.append({"ref": ref, "role": role, "name": name})
        return {"url": self._page.url, "title": await self._page.title(),
                "elements": refs, "aria": aria[:8000]}

    def snapshot(self):
        return self.call(self._snapshot, timeout=30)

    def _locator(self, ref):
        if ref not in self._refs:
            raise ValueError(f"unknown ref {ref}; take a snapshot first")
        role, name = self._refs[ref]
        return self._page.get_by_role(role, name=name, exact=False).first

    async def _click(self, ref):
        await self._locator(ref).click(timeout=15000)
        return await self._state()

    def click_ref(self, ref):
        return self.call(self._click, ref, timeout=30)

    async def _fill(self, ref, text):
        loc = self._locator(ref)
        await loc.fill(text, timeout=15000)
        return await self._state()

    def fill_ref(self, ref, text):
        return self.call(self._fill, ref, text, timeout=30)

    async def _press(self, key):
        await self._page.keyboard.press(key)
        return await self._state()

    def press(self, key):
        return self.call(self._press, key)

    async def _content(self):
        return {"url": self._page.url, "title": await self._page.title(),
                "text": (await self._page.locator("body").inner_text())[:20000]}

    def content(self):
        return self.call(self._content, timeout=30)
