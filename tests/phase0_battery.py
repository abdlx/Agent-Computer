#!/usr/bin/env python3
"""
Phase 0 test battery — 18 tests against a live guest (guest1) driven through
the guest supervisor's Unix socket, the lifecycle engine CLI, and docker.

Usage: python3 tests/phase0_battery.py [--keep]
Writes a JSON report to tests/evidence/phase0-battery-report.json and prints
one line per test. Environment: dev VM (see TEST_RESULTS.md caveats).
"""
import json
import subprocess
import sys
import threading
import time

SOCK = "/home/hatch/docker-data/volumes/guest1-home/_data/.supervisor/api.sock"
VOL = "/home/hatch/docker-data/volumes/guest1-home/_data"
CLI = ["node", "apps/control-plane/src/cli.ts"]
ENV = {"ACP_STATE_FILE": "/tmp/acp-battery-state.json", "ACP_IDLE_TIMEOUT_S": "8",
       "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
REPO = "/home/hatch/workspace/agent-computer"

RESULTS = []


def record(n, name, ok, evidence):
    RESULTS.append({"test": n, "name": name, "pass": bool(ok), "evidence": str(evidence)[:600]})
    print(f"[{'PASS' if ok else 'FAIL'}] {n:02d} {name} — {str(evidence)[:160]}", flush=True)


def guest(method, path, body=None, timeout=30):
    cmd = ["curl", "-s", "-m", str(timeout), "--unix-socket", SOCK]
    if method == "POST":
        cmd += ["-X", "POST", "-d", json.dumps(body or {})]
    cmd.append(f"http://localhost{path}")
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    try:
        return json.loads(out.stdout)
    except Exception:
        return {"raw": out.stdout, "stderr": out.stderr}


def guest_raw(path, dest, timeout=30):
    subprocess.run(["curl", "-s", "-m", str(timeout), "--unix-socket", SOCK,
                    "-o", dest, f"http://localhost{path}"],
                   check=True, timeout=timeout + 10)


def docker(*args, timeout=120):
    r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout + r.stderr).strip()


def cli(*args, timeout=180):
    import os
    env = dict(os.environ); env.update(ENV)
    r = subprocess.run(CLI + list(args), capture_output=True, text=True,
                       cwd=REPO, env=env, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"cli {args} failed: {r.stderr.strip()[:300]}")
    return json.loads(r.stdout)


def wait_health(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            h = guest("GET", "/health", timeout=6)
            if h.get("ok"):
                return h
        except Exception:
            pass
        time.sleep(2)
    raise TimeoutError("guest did not become healthy")


def windows():
    return guest("GET", "/windows").get("windows", [])


def win(title):
    return next((w for w in windows() if w["title"] == title), None)


def focus(title):
    w = win(title)
    assert w, f"window {title} not found in {windows()}"
    return guest("POST", "/windows/focus", {"id": w["id"]})


def type_cmd(text, timeout=40):
    guest("POST", "/input/type", {"text": text}, timeout=timeout)
    guest("POST", "/input/key", {"keys": ["Return"]})
    time.sleep(1.2)


def vol_read(name):
    try:
        with open(f"{VOL}/{name}") as f:
            return f.read()
    except Exception:
        return None


def main():
    keep = "--keep" in sys.argv
    # ---------- setup: fresh container = test 1 (boots) ----------
    docker("rm", "-f", "guest1")
    rc, _ = docker("run", "-d", "--name", "guest1", "-v", "guest1-home:/home/agent",
                   "agentcomputer/guest:phase0")
    assert rc == 0
    t0 = time.time()
    h = wait_health()
    record(1, "container boots", h.get("ok") is True,
           f"health ok {time.time()-t0:.0f}s after create; display={h.get('display')} engine={h.get('browser_engine')}")
    subprocess.run(["rm", "-f", "/tmp/acp-battery-state.json"])
    cli("register", "guest1", "guest1", SOCK)

    # ---------- test 2: viewer connects ----------
    st = guest("GET", "/selftest/desktop", timeout=30)
    record(2, "viewer connects (noVNC path)",
           st.get("x") == "ok" and st.get("websockify_http") == 200
           and "101" in str(st.get("ws_status", "")) and str(st.get("rfb_banner", "")).startswith("RFB"),
           json.dumps(st))

    # ---------- terminal + http server for later tests ----------
    guest("POST", "/launch", {"app": "terminal"})
    time.sleep(2)
    focus("xterm")
    type_cmd("python3 -m http.server 8123 --directory /home/agent > /tmp/http.log 2>&1 &")

    # ---------- test 3: terminal + file manager open ----------
    guest("POST", "/launch", {"app": "files"})
    time.sleep(2)
    ws = windows()
    record(3, "terminal and file manager open",
           win("xterm") is not None and win("/") is not None,
           json.dumps([(w["title"], w["width"], w["height"]) for w in ws]))

    # ---------- test 9: typing + shortcuts ----------
    focus("xterm")
    type_cmd("echo TYPED-LINE > /home/agent/t9.txt")
    guest("POST", "/input/key", {"keys": ["ctrl", "l"]})   # shortcut: clear
    type_cmd("echo AFTER-SHORTCUT >> /home/agent/t9.txt")
    content = vol_read("t9.txt") or ""
    record(9, "typing and shortcuts",
           "TYPED-LINE" in content and "AFTER-SHORTCUT" in content,
           f"t9.txt={content.strip()!r}; ctrl+l accepted")

    # ---------- test 11 (part A): write a guest file ----------
    type_cmd("echo guest-persistence > /home/agent/t11.txt")

    # ---------- test 16: human takeover interrupts agent ----------
    type_cmd("xdotool mousemove 500 500")
    time.sleep(0.8)
    h = guest("GET", "/health")
    owner1 = h["control"]["owner"]
    blocked = guest("POST", "/input/click", {"x": 100, "y": 100})
    time.sleep(4)
    h2 = guest("GET", "/health")
    ok_after = guest("POST", "/input/click", {"x": 100, "y": 100})
    record(16, "human takeover interrupts agent input",
           owner1 == "human" and blocked.get("error") == "human_control"
           and h2["control"]["owner"] == "agent" and ok_after.get("clicked") == 1,
           f"owner during={owner1}, agent click -> {blocked.get('error')}, after idle owner={h2['control']['owner']}, click -> {ok_after}")

    # ---------- test 18 (guest side): no docker socket ----------
    focus("xterm")
    type_cmd("test -e /var/run/docker.sock && echo PRESENT > /home/agent/t18.txt || echo ABSENT > /home/agent/t18.txt")
    rc, insp = docker("inspect", "-f", "{{.HostConfig.Privileged}} {{.HostConfig.CapAdd}}", "guest1")
    sock_absent = (vol_read("t18.txt") or "").strip() == "ABSENT"
    record(18, "guest cannot reach host Docker socket",
           sock_absent and insp.startswith("false"),
           f"in-guest socket check={vol_read('t18.txt')!r}; privileged/capadd={insp}")

    # ---------- test 12 (part A): home tool + layer marker ----------
    type_cmd("mkdir -p /home/agent/bin && printf '#!/bin/sh\\necho mytool-ok\\n' > /home/agent/bin/mytool && chmod +x /home/agent/bin/mytool")
    with open("/tmp/layer-marker.txt", "w") as f:
        f.write("layer-marker\n")
    docker("cp", "/tmp/layer-marker.txt", "guest1:/usr/local/share/layer-marker.txt")

    # ---------- test 4: browser opens visibly ----------
    bs = guest("POST", "/browser/start", {"engine": "camoufox"}, timeout=180)
    nav = guest("POST", "/browser/navigate",
                {"url": "http://127.0.0.1:8123/browser-test.html"}, timeout=90)
    guest_raw("/screenshot", "/tmp/battery-browser.png")
    from PIL import Image
    im = Image.open("/tmp/battery-browser.png").convert("RGB")
    colors = im.getcolors(3_000_000)
    big = [w for w in windows() if w["width"] > 800 and w["title"] not in ("tint2", "pcmanfm")]
    record(4, "browser opens visibly",
           bs.get("engine") == "camoufox" and nav.get("title") == "Agent Computer Browser Test"
           and len(big) >= 1 and colors is not None and len(colors) > 2000,
           f"start={bs}; nav title={nav.get('title')}; big windows={len(big)}; screenshot colors={len(colors) if colors else '>3M'}")

    # ---------- test 6: agent controls the browser ----------
    snap = guest("GET", "/browser/snapshot")
    refs = {e["name"]: e["ref"] for e in snap.get("elements", [])}
    guest("POST", "/browser/fill", {"ref": refs["Your name"], "text": "Grace Hopper"}, timeout=60)
    guest("POST", "/browser/click", {"ref": refs["Submit form"]}, timeout=60)
    c = guest("GET", "/browser/content")
    record(6, "agent (API) controls the browser",
           "submitted:Grace Hopper" in c.get("text", ""),
           f"refs={refs}; content shows submitted name: {'submitted:Grace Hopper' in c.get('text','')}")

    # ---------- test 10 (part A): set profile marker ----------
    snap = guest("GET", "/browser/snapshot")
    setref = next(e["ref"] for e in snap["elements"] if e["name"] == "Set marker")
    guest("POST", "/browser/click", {"ref": setref}, timeout=60)
    c = guest("GET", "/browser/content")
    assert "marker:persist-42" in c.get("text", ""), "marker not set"

    # ---------- test 5: human controls the same browser ----------
    guest("POST", "/browser/navigate",
          {"url": "http://127.0.0.1:8123/browser-test.html"}, timeout=90)  # reset page state
    bw = next(w for w in windows() if w["width"] > 800 and w["title"] not in ("tint2", "pcmanfm"))
    guest("POST", "/windows/focus", {"id": bw["id"]})
    time.sleep(1)
    # Aim the way a human does: visually. Find the link's blue text in a
    # screenshot of the browser window (content area only, below chrome).
    guest_raw("/screenshot", "/tmp/battery-aim.png")
    from PIL import Image as PILImage
    im = PILImage.open("/tmp/battery-aim.png").convert("RGB")
    px = im.load()
    xs, ys = [], []
    for yy in range(bw["y"] + 130, min(bw["y"] + bw["height"], im.height)):
        for xx in range(bw["x"], min(bw["x"] + bw["width"], im.width)):
            r, g, b = px[xx, yy]
            if b > 140 and r < 110 and g < 110:
                xs.append(xx); ys.append(yy)
    assert xs, "link-blue pixels not found in browser window"
    lx, ly = sum(xs) // len(xs), sum(ys) // len(ys)
    guest("POST", "/input/move", {"x": lx, "y": ly, "mode": "natural"}, timeout=40)
    clk = guest("POST", "/input/click", {"x": lx, "y": ly})
    time.sleep(1)
    c = guest("GET", "/browser/content")
    record(5, "human controls the same browser (visible window)",
           clk.get("clicked") == 1 and "link-clicked" in c.get("text", ""),
           f"visually aimed at link ({lx},{ly}) from {len(xs)} blue px; raw click -> {clk}; page shows link-clicked: {'link-clicked' in c.get('text','')}")

    # ---------- test 7: smooth cursor movement ----------
    positions = []
    stop_flag = threading.Event()

    def poll_cursor():
        while not stop_flag.is_set():
            try:
                cur = guest("GET", "/cursor", timeout=5)
                positions.append((cur["x"], cur["y"]))
            except Exception:
                pass
            time.sleep(0.03)

    th = threading.Thread(target=poll_cursor, daemon=True)
    th.start()
    time.sleep(0.3)
    guest("POST", "/input/move", {"x": 1100, "y": 650, "mode": "natural"}, timeout=60)
    stop_flag.set()
    fin = guest("GET", "/cursor", timeout=5)   # authoritative final position
    positions.append((fin["x"], fin["y"]))
    distinct = []
    for p in positions:
        if not distinct or distinct[-1] != p:
            distinct.append(p)
    import math
    dists = [math.hypot(1100 - x, 650 - y) for x, y in distinct]
    progressive = sum(1 for a, b in zip(dists, dists[1:]) if b <= a + 40) >= max(1, len(dists) - 2)
    record(7, "agent moves the real cursor smoothly",
           len(distinct) >= 8 and distinct[-1] == (1100, 650) and progressive,
           f"{len(distinct)} distinct positions sampled, final={distinct[-1] if distinct else None}, progressive={progressive}")

    # ---------- test 8: drag (move the xterm window by its title bar) ----------
    focus("xterm")  # raise it above the browser window first
    time.sleep(1)
    xt = win("xterm")
    before = (xt["x"], xt["y"])
    # The title bar is the Openbox frame strip ABOVE the client window
    # (client (1,20) means the frame occupies y 0..19); pressing inside
    # the client would only select text.
    guest("POST", "/input/drag",
          {"from": [before[0] + 200, before[1] - 10], "to": [before[0] + 350, before[1] + 90]},
          timeout=60)
    time.sleep(1)
    xt2 = win("xterm")
    moved = abs(xt2["x"] - before[0]) > 100 and abs(xt2["y"] - before[1]) > 50
    record(8, "drag-and-drop (window drag)",
           moved, f"xterm moved {before} -> {(xt2['x'], xt2['y'])}")

    # ---------- tests 10/11/12 (part B): stop/start persistence ----------
    guest("POST", "/browser/close", {}, timeout=60)
    docker("stop", "-t", "20", "guest1")
    docker("start", "guest1")
    wait_health()
    # guest-side proof the file is visible after restart
    guest("POST", "/launch", {"app": "terminal"})
    time.sleep(2)
    focus("xterm")
    type_cmd("cat /home/agent/t11.txt > /home/agent/t11-seen.txt; /home/agent/bin/mytool > /home/agent/t12-seen.txt")
    seen11 = (vol_read("t11-seen.txt") or "").strip()
    seen12 = (vol_read("t12-seen.txt") or "").strip()
    rc, layer = docker("cp", "guest1:/usr/local/share/layer-marker.txt", "/tmp/layer-out.txt")
    record(11, "files survive stop/start",
           seen11 == "guest-persistence",
           f"guest-side cat after restart -> {seen11!r}")
    t12 = {"pass_b": seen12 == "mytool-ok" and rc == 0,
           "evidence": f"~/bin/mytool runs after restart -> {seen12!r}; container-layer file present after stop/start (rc={rc})"}
    # browser profile after stop/start
    guest("POST", "/browser/start", {"engine": "camoufox"}, timeout=180)
    # the http server died with the container; restart it
    focus("xterm")
    type_cmd("python3 -m http.server 8123 --directory /home/agent > /tmp/http.log 2>&1 &")
    guest("POST", "/browser/navigate",
          {"url": "http://127.0.0.1:8123/browser-test.html"}, timeout=90)
    c = guest("GET", "/browser/content")
    record(10, "browser profile survives stop/start",
           "marker:persist-42" in c.get("text", ""),
           f"localStorage marker after restart: {'marker:persist-42' in c.get('text','')}")

    # ---------- test 17: active operations block premature sleep ----------
    op = cli("begin-op", "guest1", "download", "battery-download")
    r = cli("tick", "guest1")
    blocked_by_op = r.get("action") == "blocked"
    cli("end-op", op["id"])
    record(17, "active jobs block premature sleep", blocked_by_op, json.dumps(r))

    # ---------- test 13: automatic sleep ----------
    time.sleep(9)  # exceed the 8s idle timeout with no new input
    r = cli("tick", "guest1")
    rc, status = docker("ps", "-a", "--filter", "name=guest1", "--format", "{{.Status}}")
    record(13, "automatic sleep after idle timeout",
           r.get("action") == "slept" and status.startswith("Exited"),
           f"tick={r}; container={status}")

    # ---------- test 14: wake on MCP-style call ----------
    h = cli("call-health", "guest1")
    record(14, "wake on call", h.get("ok") is True, f"call-health ok={h.get('ok')}")

    # ---------- test 15: concurrent wake safety ----------
    cli("sleep", "guest1")
    r = cli("wake-parallel", "guest1", "8")
    rc, count = docker("ps", "--filter", "name=guest1", "--format", "{{.Names}}")
    record(15, "concurrent wake is single-flight",
           all(s == "ready" for s in r.get("states", [])) and count.strip() == "guest1",
           f"8 callers -> {r.get('states')}; running containers: {count.strip()!r}; {r.get('elapsedMs')}ms")

    # ---------- test 12 (part C): recreation keeps only /home/agent ----------
    docker("rm", "-f", "guest1")
    docker("run", "-d", "--name", "guest1", "-v", "guest1-home:/home/agent",
           "agentcomputer/guest:phase0")
    wait_health()
    rc_layer, _ = docker("cp", "guest1:/usr/local/share/layer-marker.txt", "/tmp/layer-out2.txt")
    home_kept = vol_read("t11.txt") is not None and vol_read("bin/mytool") is not None
    record(12, "installed tools survive per persistence contract",
           t12["pass_b"] and rc_layer != 0 and home_kept,
           t12["evidence"] + f"; after recreation: layer file gone (rc={rc_layer}), home files kept={home_kept}")

    RESULTS.sort(key=lambda r: r["test"])
    passed = sum(1 for r in RESULTS if r["pass"])
    report = {"passed": passed, "total": 18, "results": RESULTS}
    with open(f"{REPO}/tests/evidence/phase0-battery-report.json", "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nBATTERY: {passed}/18 passed. Report: tests/evidence/phase0-battery-report.json")
    if not keep:
        pass
    return 0 if passed == 18 else 1


if __name__ == "__main__":
    sys.exit(main())
