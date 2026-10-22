#!/usr/bin/env python3
"""
Guest supervisor for an Agent Computer.

Runs inside the guest container. One long-lived process owns:
  - a single persistent X11 connection (python-xlib) — input is injected with the
    XTest extension (real input at the display level) and screenshots read the
    real root window, so agents and humans share exactly one desktop;
  - control arbitration: an explicit owner (agent/human) with human activity
    detection (pointer motion not issued by this supervisor implies a human);
  - held-state tracking: every key/button this process presses is tracked and
    can be released via /release-all; a watchdog auto-releases stale holds;
  - activity timestamps for the platform's sleep engine.

HTTP API on 127.0.0.1:8731 inside the container network. If GUEST_TOKEN is set,
every request must carry `X-Guest-Token`. The port is never published by the
platform; the control plane proxies it.

Typing strategy: ASCII printable text goes through XTest key events. Text with
non-ASCII or control complexity is typed via the installed `xdotool type`
fallback (still real XTest input at the display level) — noted honestly because
robust Unicode keymap injection needs a temporary keymap remap; the fallback
avoids corrupting the user's keymap.
"""
import base64
import io
import json
import os
import shutil
import subprocess
import urllib.request
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket

import Xlib.threaded  # noqa: F401  (enables per-thread locking on the shared Display)
from Xlib import X, XK, display
from Xlib.ext import xtest
from PIL import Image

import trajectory
from confined_fs import ConfinedFS
from human_input import HumanInputObserver

_browser = None  # BrowserOwner instance, created lazily on first /browser/start


HOME_DIR = os.environ.get("HOME", "/home/agent")


def _safe_home_path(raw):
    """Resolve a caller path inside the home directory; refuse escapes."""
    raw = str(raw or ".")
    candidate = raw if raw.startswith("/") else os.path.join(HOME_DIR, raw)
    resolved = os.path.realpath(candidate)
    if resolved != HOME_DIR and not resolved.startswith(HOME_DIR + "/"):
        raise ValueError(f"path is outside the home directory: {raw}")
    return resolved


def guest_exec_fs(p, b):
    """Terminal + filesystem operations for the MCP gateway / API.
    fs paths are confined to the home directory; /exec runs as the
    computer's own user in a login shell (it IS the terminal)."""
    if p == "/exec":
        timeout = min(120, max(1, int(b.get("timeout_s", 30))))
        try:
            r = subprocess.run(
                ["/bin/bash", "-lc", str(b["command"])],
                capture_output=True, text=True, timeout=timeout,
                cwd=HOME_DIR,
                env={**os.environ, "HOME": HOME_DIR, "DISPLAY": DISPLAY_NAME})
            cap = 20000
            return {"code": r.returncode,
                    "stdout": r.stdout[-cap:], "stderr": r.stderr[-cap:],
                    "truncated": len(r.stdout) > cap or len(r.stderr) > cap}
        except subprocess.TimeoutExpired as e:
            return {"code": -1, "timeout": True,
                    "stdout": (e.stdout or "")[-20000:] if isinstance(e.stdout, str) else "",
                    "stderr": (e.stderr or "")[-20000:] if isinstance(e.stderr, str) else ""}
    if p.startswith("/fs/"):
        return ConfinedFS(HOME_DIR).call(p[4:], b)
    raise ValueError(f"unknown exec/fs path: {p}")


def get_browser():
    global _browser
    if _browser is None:
        from browser_owner import BrowserOwner
        _browser = BrowserOwner()
    return _browser

DISPLAY_NAME = os.environ.get("DISPLAY", ":0")
PORT = int(os.environ.get("GUEST_SUPERVISOR_PORT", "8731"))
TOKEN = os.environ.get("GUEST_TOKEN", "")
HOLD_WATCHDOG_S = 20.0          # auto-release holds older than this
HUMAN_TAKEOVER_IDLE_S = 3.0     # human stays owner this long after last human motion

dpy = display.Display(DISPLAY_NAME)
root = dpy.screen().root
SCREEN_W = root.get_geometry().width
SCREEN_H = root.get_geometry().height

state_lock = threading.Lock()
held = {"keys": set(), "buttons": set()}          # keycodes / button numbers currently down
held_since = {"keys": {}, "buttons": {}}
control = {"owner": "agent", "since": time.time(), "reason": "boot"}
activity = {"last_any": time.time(), "last_agent": 0.0, "last_human": 0.0}
last_issued_pos = {"x": -1, "y": -1, "t": 0.0}
# Explicit agent-motion window: while now() <= until, pointer motion is
# attributed to the agent. Position matching alone raced under CPU load
# (a descheduled trajectory thread made agent motion look human and the
# agent's next click got a spurious 409).
agent_motion = {"until": 0.0, "x": -1, "y": -1}
counters = {"moves": 0, "clicks": 0, "keys": 0, "screenshots": 0}


def now():
    return time.time()


def pointer_pos():
    p = root.query_pointer()
    return p.root_x, p.root_y


def mark_issued(x, y):
    last_issued_pos.update(x=x, y=y, t=now())
    agent_motion.update(x=x, y=y, until=now() + 0.6)


def human_takeover():
    with state_lock:
        activity["last_human"] = now()
        activity["last_any"] = now()
        control.update(owner="human", since=now(), reason="viewer-input")
    release_all()
    if _browser is not None:
        _browser.cancel_input()


def guard_continuing_input():
    with state_lock:
        if control["owner"] == "human":
            raise InterruptedError("human_control")


def human_watch():
    """Detect human pointer motion: pointer moved while no agent move is in flight."""
    last_x, last_y = pointer_pos()
    while True:
        time.sleep(0.15)
        try:
            x, y = pointer_pos()
        except Exception:
            continue
        if (x, y) != (last_x, last_y):
            agent_active = (
                now() <= agent_motion["until"]
                or (abs(x - agent_motion["x"]) <= 2
                    and abs(y - agent_motion["y"]) <= 2
                    and now() - last_issued_pos["t"] < 1.5))
            if not agent_active:
                with state_lock:
                    activity["last_human"] = now()
                    activity["last_any"] = now()
                    if control["owner"] != "human":
                        control.update(owner="human", since=now(), reason="pointer-activity")
            if not agent_active:
                release_all()
            last_x, last_y = x, y


def human_expire():
    """Human ownership lapses after HUMAN_TAKEOVER_IDLE_S of no human activity."""
    while True:
        time.sleep(0.5)
        with state_lock:
            if control["owner"] == "human" and now() - activity["last_human"] > HUMAN_TAKEOVER_IDLE_S:
                control.update(owner="agent", since=now(), reason="human-idle")


def release_all():
    with state_lock:
        for kc in list(held["keys"]):
            xtest.fake_input(dpy, X.KeyRelease, kc)
            held["keys"].discard(kc)
        for b in list(held["buttons"]):
            xtest.fake_input(dpy, X.ButtonRelease, b)
            held["buttons"].discard(b)
        held_since["keys"].clear()
        held_since["buttons"].clear()
        dpy.sync()


def hold_watchdog():
    while True:
        time.sleep(2.0)
        t = now()
        stale = False
        with state_lock:
            stale = any(t - ts > HOLD_WATCHDOG_S for ts in held_since["keys"].values()) or \
                    any(t - ts > HOLD_WATCHDOG_S for ts in held_since["buttons"].values())
        if stale:
            release_all()


def warp(x, y):
    mark_issued(int(x), int(y))  # mark BEFORE the request is flushed
    xtest.fake_input(dpy, X.MotionNotify, x=int(x), y=int(y))


def move_to(x, y, mode="natural", duration_ms=None):
    cx, cy = pointer_pos()
    pts = trajectory.plan_move((cx, cy), (int(x), int(y)), duration_ms=duration_ms,
                               mode=mode, screen=(SCREEN_W, SCREEN_H))
    if pts:
        agent_motion["until"] = now() + pts[-1][0] / 1000.0 + 0.6
    t0 = time.perf_counter()
    for ts, px, py in pts:
        delay = ts / 1000.0 - (time.perf_counter() - t0)
        if delay > 0:
            time.sleep(delay)
        guard_continuing_input()
        warp(px, py)
    dpy.sync()
    counters["moves"] += 1


def button(btn, down):
    xtest.fake_input(dpy, X.ButtonPress if down else X.ButtonRelease, btn)
    with state_lock:
        if down:
            held["buttons"].add(btn); held_since["buttons"][btn] = now()
        else:
            held["buttons"].discard(btn); held_since["buttons"].pop(btn, None)
    dpy.sync()


def keycode_for(keysym_name):
    ks = XK.string_to_keysym(keysym_name)
    if ks == 0:
        return None
    return dpy.keysym_to_keycode(ks)


SPECIAL = {
    "enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape",
    "tab": "Tab", "space": "space", "backspace": "BackSpace", "delete": "Delete",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
    "ctrl": "Control_L", "control": "Control_L", "alt": "Alt_L", "shift": "Shift_L",
    "super": "Super_L", "meta": "Meta_L",
}


def press_key_combo(keys):
    """keys like ['ctrl','l'] or ['Return']."""
    names = []
    for k in keys:
        low = k.lower()
        if low in SPECIAL:
            names.append(SPECIAL[low])
        elif len(k) == 1:
            names.append(k)
        else:
            names.append(k)
    codes = []
    for n in names:
        kc = keycode_for(n)
        if kc is None:
            raise ValueError(f"unknown key: {n}")
        codes.append(kc)
    for kc in codes:
        xtest.fake_input(dpy, X.KeyPress, kc)
        with state_lock:
            held["keys"].add(kc); held_since["keys"][kc] = now()
    for kc in reversed(codes):
        xtest.fake_input(dpy, X.KeyRelease, kc)
        with state_lock:
            held["keys"].discard(kc); held_since["keys"].pop(kc, None)
    dpy.sync()
    counters["keys"] += 1


# Printable-ASCII -> (keysym name, needs shift). Letters/digits map to their
# own keysym names; punctuation needs the real X keysym names below.
_CHAR_KEYSYMS = {
    " ": ("space", False), "!": ("exclam", True), '"': ("quotedbl", True),
    "#": ("numbersign", True), "$": ("dollar", True), "%": ("percent", True),
    "&": ("ampersand", True), "'": ("apostrophe", False),
    "(": ("parenleft", True), ")": ("parenright", True),
    "*": ("asterisk", True), "+": ("plus", True), ",": ("comma", False),
    "-": ("minus", False), ".": ("period", False), "/": ("slash", False),
    ":": ("colon", True), ";": ("semicolon", False), "<": ("less", True),
    "=": ("equal", False), ">": ("greater", True), "?": ("question", True),
    "@": ("at", True), "[": ("bracketleft", False),
    "\\": ("backslash", False), "]": ("bracketright", False),
    "^": ("asciicircum", True), "_": ("underscore", True),
    "`": ("grave", False), "{": ("braceleft", True), "|": ("bar", True),
    "}": ("braceright", True), "~": ("asciitilde", True),
    "\n": ("Return", False), "\t": ("Tab", False),
}


def _char_keysym(ch):
    if ch in _CHAR_KEYSYMS:
        return _CHAR_KEYSYMS[ch]
    if ch.isalpha():
        return (ch.lower(), ch.isupper())
    if ch.isdigit():
        return (ch, False)
    return (None, False)


def _xdotool_type(text):
    proc = subprocess.Popen(["xdotool", "type", "--clearmodifiers", "--", text],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env={**os.environ, "DISPLAY": DISPLAY_NAME})
    deadline = time.monotonic() + 30
    try:
        while proc.poll() is None:
            guard_continuing_input()
            if time.monotonic() > deadline:
                raise TimeoutError("typing timed out")
            time.sleep(0.01)
        if proc.returncode:
            raise ValueError("typing failed")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        release_all()



def type_text(text):
    if all(32 <= ord(c) < 127 or c in "\n\t" for c in text) and len(text) <= 200:
        try:
            for ch in text:
                guard_continuing_input()
                ks_name, shift = _char_keysym(ch)
                kc = keycode_for(ks_name) if ks_name else None
                if kc is None:
                    raise ValueError(f"cannot map char: {ch!r}")
                skc = keycode_for("Shift_L") if shift else None
                if skc:
                    xtest.fake_input(dpy, X.KeyPress, skc)
                xtest.fake_input(dpy, X.KeyPress, kc)
                xtest.fake_input(dpy, X.KeyRelease, kc)
                if skc:
                    xtest.fake_input(dpy, X.KeyRelease, skc)
            dpy.sync()
        except ValueError:
            _xdotool_type(text)  # wholesale fallback for unmappable text
    else:
        # Unicode/long text: xdotool type (XTest-based) — see module docstring.
        _xdotool_type(text)
    counters["keys"] += 1


def screenshot_png():
    geom = root.get_geometry()
    raw = root.get_image(0, 0, geom.width, geom.height, X.ZPixmap, 0xffffffff)
    img = Image.frombytes("RGB", (geom.width, geom.height), raw.data, "raw", "BGRX")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    counters["screenshots"] += 1
    return buf.getvalue()


def window_root_pos(w):
    """Root coordinates of a window's origin, by summing geometry up the
    parent chain (translate_coords proved unreliable under Xvnc: it
    returned sign-flipped values for reparented clients)."""
    x = y = 0
    cur = w
    for _ in range(8):
        g = cur.get_geometry()
        x += g.x
        y += g.y
        parent = cur.query_tree().parent
        if parent is None or parent.id == root.id:
            break
        cur = parent
    return x, y


def list_windows():
    wins = []
    try:
        atom = dpy.intern_atom("_NET_CLIENT_LIST")
        prop = root.get_full_property(atom, X.AnyPropertyType)
        ids = list(prop.value) if prop else []
    except Exception:
        ids = [w.id for w in root.query_tree().children]
    try:
        aatom = dpy.intern_atom("_NET_ACTIVE_WINDOW")
        aprop = root.get_full_property(aatom, X.AnyPropertyType)
        active_id = int(aprop.value[0]) if aprop and len(aprop.value) else None
    except Exception:
        active_id = None
    for wid in ids:
        try:
            w = dpy.create_resource_object("window", wid)
            g = w.get_geometry()
            title = w.get_full_property(dpy.intern_atom("_NET_WM_NAME"), dpy.intern_atom("UTF8_STRING"))
            name = title.value.decode("utf-8", errors="replace") if title is not None else (w.get_wm_name() or "")
            wm_class = list(w.get_wm_class() or ())
            # get_geometry() is PARENT-relative: for a decorated window
            # that is client-in-frame (e.g. 1,20), not the position on
            # screen. Report root coordinates so callers can aim input
            # from these values.
            rx, ry = window_root_pos(w)
            wins.append({"id": wid, "title": name, "x": rx, "y": ry,
                         "width": g.width, "height": g.height,
                         "active": wid == active_id, "wmClass": wm_class})
        except Exception:
            continue
    return wins


def focus_window(wid):
    """Raise + focus a window via EWMH (_NET_ACTIVE_WINDOW client message)."""
    from Xlib.protocol import event as xevent
    w = dpy.create_resource_object("window", int(wid))
    atom = dpy.intern_atom("_NET_ACTIVE_WINDOW")
    msg = xevent.ClientMessage(window=w, client_type=atom,
                               data=(32, [1, X.CurrentTime, 0, 0, 0]))
    root.send_event(msg, event_mask=X.SubstructureRedirectMask
                    | X.SubstructureNotifyMask)
    w.set_input_focus(X.RevertToParent, X.CurrentTime)
    dpy.sync()
    return {"focused": int(wid)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", "0"))
        if n > 8_000_000:
            raise ValueError("request body too large (8 MB max)")
        return json.loads(self.rfile.read(n) or b"{}")

    def _auth(self):
        return not TOKEN or self.headers.get("X-Guest-Token") == TOKEN

    def _authorized(self):
        # /health is public by design: it carries only liveness and is
        # what the image's Docker HEALTHCHECK (a plain curl, no token)
        # polls. Everything else requires the guest token.
        return self.path == "/health" or self._auth()

    def _guard_input(self, actor):
        """Agent input is rejected while a human owns control (takeover interrupt)."""
        with state_lock:
            if actor == "agent" and control["owner"] == "human":
                return False
            activity["last_any"] = now()
            if actor == "agent":
                activity["last_agent"] = now()
            return True

    def do_GET(self):
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        try:
            if self.path == "/health":
                x, y = pointer_pos()
                self._send(200, {
                    "ok": True, "display": DISPLAY_NAME,
                    "screen": {"width": SCREEN_W, "height": SCREEN_H},
                    "cursor": {"x": x, "y": y},
                    "control": dict(control),
                    "held": {"keys": sorted(held["keys"]), "buttons": sorted(held["buttons"])},
                    "activity": dict(activity), "counters": dict(counters),
                    "browser_engine": browser_engine(),
                })
            elif self.path == "/screenshot":
                self._send(200, screenshot_png(), "image/png")
            elif self.path == "/cursor":
                x, y = pointer_pos()
                self._send(200, {"x": x, "y": y})
            elif self.path == "/windows":
                self._send(200, {"windows": list_windows()})
            elif self.path == "/selftest/desktop":
                self._send(200, desktop_selftest())
            elif self.path == "/vnc":
                return self._vnc_bridge()
            elif self.path == "/browser/state":
                b = get_browser()
                if b._thread and b._thread.is_alive():
                    self._send(200, b.state())
                else:
                    self._send(200, {"engine": None, "running": False})
            elif self.path == "/browser/content":
                self._send(200, get_browser().content())
            elif self.path == "/browser/snapshot":
                self._send(200, get_browser().snapshot())
            else:
                self._send(404, {"error": "not found"})
        except InterruptedError:
            self._send(409, {"error": "human_control"})
        except FileNotFoundError as e:
            self._send(404, {"error": str(e)})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            self._send(409 if "human_control" in str(e) else 500, {"error": str(e)})

    def _vnc_bridge(self):
        """Bridge this (authenticated) connection to in-guest websockify.

        The browser's WebSocket handshake is answered here; a second
        handshake is performed to websockify as a client; afterwards raw
        frames are piped both ways (client frames stay masked, server
        frames unmasked — framing is end-to-end compatible, the RFB
        payload is opaque). This is what lets the control plane offer a
        live desktop without publishing any guest port."""
        import hashlib
        if (self.headers.get("Upgrade") or "").lower() != "websocket":
            return self._send(400, {"error": "websocket upgrade required"})
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._send(400, {"error": "missing Sec-WebSocket-Key"})
        try:
            upstream = socket.create_connection(("127.0.0.1", 6080), timeout=10)
            ukey = base64.b64encode(os.urandom(16)).decode()
            upstream.sendall((
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:6080\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {ukey}\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                "Sec-WebSocket-Protocol: binary\r\n\r\n").encode())
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = upstream.recv(4096)
                if not chunk:
                    raise ConnectionError("websockify closed during handshake")
                buf += chunk
            head, _, rest = buf.partition(b"\r\n\r\n")
            if b"101" not in head.split(b"\r\n")[0]:
                raise ConnectionError("websockify refused the upgrade")
        except Exception as e:
            try:
                upstream.close()
            except Exception:
                pass
            return self._send(502, {"error": f"vnc upstream unavailable: {e}"})
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        proto = self.headers.get("Sec-WebSocket-Protocol")
        proto_line = f"Sec-WebSocket-Protocol: {proto}\r\n" if proto else ""
        self.connection.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            f"{proto_line}\r\n").encode())
        self.close_connection = True
        if rest:
            self.connection.sendall(rest)

        # Remove the 10-second connect timeout now that the handshake has succeeded.
        # Otherwise, upstream.recv() will raise socket.timeout whenever the screen is idle for 10 seconds.
        upstream.settimeout(None)
        try:
            self.connection.settimeout(None)
        except Exception:
            pass

        try:
            upstream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass

        observer = HumanInputObserver(human_takeover)

        def pump(src, dst, observe=False):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    if observe:
                        try:
                            observer.feed(data)
                        except Exception:
                            pass
                    dst.sendall(data)
            except Exception:
                pass
            try:
                dst.shutdown(socket.SHUT_WR)
            except Exception:
                pass

        t = threading.Thread(target=pump, args=(self.connection, upstream, True), daemon=True)
        t.start()
        pump(upstream, self.connection)
        try:
            upstream.close()
        except Exception:
            pass

    def do_POST(self):
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        try:
            b = self._body()
            actor = b.get("actor", "agent")
            p = self.path
            if p == "/windows/focus":
                return self._send(200, focus_window(b.get("id")))
            if p == "/launch":
                cmd = LAUNCHABLES.get(b.get("app", ""))
                if cmd is None:
                    return self._send(400, {"error": "app not launchable",
                                            "allowed": sorted(LAUNCHABLES)})
                proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL,
                                        start_new_session=True,
                                        env={**os.environ, "DISPLAY": DISPLAY_NAME})
                return self._send(200, {"launched": b.get("app"), "pid": proc.pid})
            if p == "/release-all":
                release_all()
                return self._send(200, {"released": True})
            if p == "/browser/close":
                b = get_browser()
                b.close()
                return self._send(200, {"closed": True})
            if p == "/control/acquire":
                with state_lock:
                    control.update(owner=actor, since=now(), reason="explicit-acquire")
                return self._send(200, {"control": dict(control)})
            if p == "/control/release":
                with state_lock:
                    control.update(owner="agent", since=now(), reason="explicit-release")
                return self._send(200, {"control": dict(control)})
            if p == "/activity/ping":
                with state_lock:
                    activity["last_any"] = now()
                return self._send(200, {"ok": True})
            if p == "/exec" or p.startswith("/fs/"):
                # Not desktop input: not arbitrated, but it IS activity.
                with state_lock:
                    activity["last_any"] = now()
                    activity["last_agent"] = now()
                return self._send(200, guest_exec_fs(p, b))
            # Everything below is input and is arbitrated.
            if not self._guard_input(actor):
                return self._send(409, {"error": "human_control",
                                        "detail": "A human is currently controlling this computer."})
            if p == "/browser/start":
                eng = b.get("engine") or browser_engine()
                if eng == "none":
                    return self._send(503, {"error": "no browser engine installed"})
                return self._send(200, get_browser().start(eng))
            if p == "/browser/navigate":
                return self._send(200, get_browser().goto(b["url"]))
            if p == "/browser/click":
                return self._send(200, get_browser().click_ref(b["ref"]))
            if p == "/browser/fill":
                return self._send(200, get_browser().fill_ref(b["ref"], b["text"]))
            if p == "/browser/press":
                return self._send(200, get_browser().press(b["key"]))
            if p == "/input/move":
                move_to(b["x"], b["y"], b.get("mode", "natural"), b.get("duration_ms"))
                x, y = pointer_pos()
                self._send(200, {"x": x, "y": y})
            elif p == "/input/click":
                if "x" in b and "y" in b:
                    move_to(b["x"], b["y"], b.get("mode", "natural"))
                btn = int(b.get("button", 1))
                for _ in range(int(b.get("clicks", 1))):
                    button(btn, True); time.sleep(0.03); button(btn, False)
                    time.sleep(0.04)
                counters["clicks"] += 1
                self._send(200, {"clicked": btn})
            elif p == "/input/drag":
                fx, fy = b["from"]; tx, ty = b["to"]
                btn = int(b.get("button", 1))
                move_to(fx, fy, b.get("mode", "natural"))
                button(btn, True)
                try:
                    pts = trajectory.plan_drag((fx, fy), (tx, ty),
                                               duration_ms=b.get("duration_ms"),
                                               mode=b.get("mode", "natural"),
                                               screen=(SCREEN_W, SCREEN_H))
                    t0 = time.perf_counter()
                    for ts, px, py in pts:
                        delay = ts / 1000.0 - (time.perf_counter() - t0)
                        if delay > 0:
                            time.sleep(delay)
                        guard_continuing_input()
                        warp(px, py)
                    dpy.sync()
                finally:
                    button(btn, False)
                self._send(200, {"dragged": [fx, fy, tx, ty]})
            elif p == "/input/type":
                type_text(b["text"])
                self._send(200, {"typed": len(b["text"])})
            elif p == "/input/key":
                press_key_combo(b["keys"])
                self._send(200, {"keys": b["keys"]})
            elif p == "/input/scroll":
                dy = int(b.get("dy", 0)); dx = int(b.get("dx", 0))
                for _ in range(abs(dy)):
                    button(4 if dy < 0 else 5, True); button(4 if dy < 0 else 5, False)
                for _ in range(abs(dx)):
                    button(6 if dx < 0 else 7, True); button(6 if dx < 0 else 7, False)
                self._send(200, {"scrolled": [dx, dy]})
            else:
                self._send(404, {"error": "not found"})
        except InterruptedError:
            self._send(409, {"error": "human_control"})
        except FileNotFoundError as e:
            self._send(404, {"error": str(e)})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            self._send(409 if "human_control" in str(e) else 500, {"error": str(e)})


def browser_engine():
    if os.path.exists(os.path.expanduser("~/.cache/camoufox")):
        return "camoufox"
    if os.path.exists("/usr/bin/chromium"):
        return "chromium"
    return "none"


LAUNCHABLES = {
    "terminal": ["/usr/bin/xterm", "-fa", "DejaVu Sans Mono", "-fs", "11"],
    "files": ["/usr/bin/pcmanfm"],
}


def desktop_selftest():
    """In-guest viewer-path proof: X display, websockify HTTP, and a real
    WebSocket -> VNC handshake that reads the RFB banner."""
    out = {"x": None, "websockify_http": None, "rfb_banner": None}
    try:
        subprocess.run(["xdpyinfo", "-display", DISPLAY_NAME],
                       check=True, capture_output=True, timeout=5)
        out["x"] = "ok"
    except Exception as e:
        out["x"] = f"fail: {e}"
    try:
        with urllib.request.urlopen("http://127.0.0.1:6080/", timeout=5) as r:
            out["websockify_http"] = r.status
    except Exception as e:
        out["websockify_http"] = f"fail: {e}"
    try:
        import base64 as _b64
        key = _b64.b64encode(os.urandom(16)).decode()
        sock = socket.create_connection(("127.0.0.1", 6080), timeout=5)
        sock.sendall((f"GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:6080\r\n"
                      f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                      f"Sec-WebSocket-Protocol: binary\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        out["ws_status"] = head.splitlines()[0].decode("latin-1") if head else None
        frame = rest
        while len(frame) < 14:  # ws header (2) + RFB banner (12)
            chunk = sock.recv(4096)
            if not chunk:
                break
            frame += chunk
        if len(frame) >= 14 and frame[0] & 0x0F == 2:
            out["rfb_banner"] = frame[2:14].decode("latin-1")
        sock.close()
    except Exception as e:
        out["rfb_banner"] = f"fail: {e}"
    return out


class UnixHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_UNIX

    def server_bind(self):
        if os.path.exists(self.server_address):
            os.unlink(self.server_address)
        super().server_bind()
        os.chmod(self.server_address, 0o600)


def main():
    import atexit
    import signal

    def _shutdown(*_a):
        try:
            if _browser is not None:
                _browser.close()   # flush profile state before exit
        finally:
            release_all()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    atexit.register(lambda: _browser.close() if _browser is not None else None)
    threading.Thread(target=human_watch, daemon=True).start()
    threading.Thread(target=human_expire, daemon=True).start()
    threading.Thread(target=hold_watchdog, daemon=True).start()
    sock_path = os.environ.get(
        "GUEST_SUPERVISOR_SOCK",
        os.path.expanduser("~/.supervisor/api.sock"))
    os.makedirs(os.path.dirname(sock_path), exist_ok=True)
    usrv = UnixHTTPServer(sock_path, Handler)
    try:
        os.chmod(sock_path, 0o660)
    except Exception:
        pass
    threading.Thread(target=usrv.serve_forever, daemon=True).start()
    print(f"[guest-supervisor] unix socket: {sock_path}", flush=True)
    # TCP is loopback-only inside the guest: it exists for the image's
    # Docker HEALTHCHECK. The platform itself always uses the unix
    # socket, and the guest network must not become a path between
    # computers.
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[guest-supervisor] listening on :{PORT} display={DISPLAY_NAME} "
          f"screen={SCREEN_W}x{SCREEN_H} engine={browser_engine()}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
