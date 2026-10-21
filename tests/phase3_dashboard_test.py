#!/usr/bin/env python3
"""
Phase 3 dashboard test: static app serving + SPA fallback + the
authenticated noVNC WebSocket proxy end to end (session cookie required,
wake-on-connect, real RFB bytes through CP -> guest unix socket ->
guest /vnc bridge -> websockify -> Xvnc).
"""
import base64
import json
import os
import signal
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phase1_api_test as p1  # noqa: E402
from phase1_api_test import curl, curl_status, wait_port, REPO  # noqa: E402

TMP = "/tmp/acp-test3"
PORT = 18789
BASE = f"http://127.0.0.1:{PORT}"
SOCK = f"{TMP}/supervisor.sock"
SECRET = "test-secret-789"
JAR = f"{TMP}/cookies.txt"
p1.JAR = JAR

RESULTS = []


def record(name, ok, evidence=""):
    RESULTS.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} — {str(evidence)[:160]}", flush=True)


def raw_get(path, cookie=None):
    import urllib.request
    req = urllib.request.Request(f"{BASE}{path}")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", ""), e.read()


def ws_connect(path, cookie=None):
    """Hand-rolled WS client: returns (status_line, first_frame_payload)."""
    s = socket.create_connection(("127.0.0.1", PORT), timeout=30)
    key = base64.b64encode(os.urandom(16)).decode()
    headers = [
        f"GET {path} HTTP/1.1", f"Host: 127.0.0.1:{PORT}",
        "Upgrade: websocket", "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Protocol: binary",
    ]
    if cookie:
        headers.append(f"Cookie: {cookie}")
    s.sendall(("\r\n".join(headers) + "\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    if b"\r\n\r\n" not in buf:
        s.close()
        return buf.decode("utf-8", "replace").split("\r\n")[0] if buf else "no response", None
    head, rest = buf.split(b"\r\n\r\n", 1)
    status = head.split(b"\r\n")[0].decode()
    if "101" not in status:
        s.close()
        return status, None
    data = rest
    deadline = time.time() + 15
    while len(data) < 14 and time.time() < deadline:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    payload = None
    if len(data) >= 2:
        ln = data[1] & 0x7F
        payload = data[2:2 + ln]
    s.close()
    return status, payload


def session_cookie():
    with open(JAR) as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 7 and parts[5] == "acp_session":
                return f"acp_session={parts[6]}"
    return None


def main():
    subprocess.run(["rm", "-rf", TMP], check=False)
    os.makedirs(TMP, exist_ok=True)
    env = dict(os.environ)
    sup = subprocess.Popen(
        ["node", "supervisor/src/server.ts"], cwd=REPO,
        env={**env, "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET},
        stdout=open(f"{TMP}/supervisor.log", "w"), stderr=subprocess.STDOUT)
    cp = subprocess.Popen(
        ["node", "apps/control-plane/src/server.ts"], cwd=REPO,
        env={**env, "ACP_PORT": str(PORT), "ACP_DB": f"{TMP}/cp.db",
             "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET,
             "ACP_IDLE_TIMEOUT_S": "3600",
             "ACP_DASHBOARD_DIR": f"{REPO}/apps/dashboard/dist"},
        stdout=open(f"{TMP}/control-plane.log", "w"), stderr=subprocess.STDOUT)
    cid = None
    try:
        assert wait_port(f"{BASE}/api/health"), "control plane did not start"

        code, ctype, body = raw_get("/")
        record("dashboard index served at /", code == 200 and b'id="root"' in body
               and b"/assets/" in body, f"{code} {ctype} {len(body)}B")
        code2, _, body2 = raw_get("/computers")
        record("SPA fallback serves index for deep links", code2 == 200 and b'id="root"' in body2, code2)
        import re
        m = re.search(rb'/assets/[\w.-]+\.js', body)
        if m:
            code3, ctype3, js = raw_get(m.group(0).decode())
            record("JS bundle served with app code inside",
                   code3 == 200 and "javascript" in ctype3
                   and b"Agent Computers" in js and b"Connect an agent" in js,
                   f"{code3} {ctype3} {len(js)}B")
        else:
            record("JS bundle served with app code inside", False, "no bundle ref in index")

        def api(method, path, body=None):
            h = ["x-acp-request: 1"] if method != "GET" else []
            return curl(method, f"{BASE}{path}", body, jar=True, headers=h)

        api("POST", "/api/setup", {"username": "owner", "password": "correct horse battery"})
        r = api("POST", "/api/computers", {"name": "Dash Box", "cpuMillis": 1000, "memoryMb": 1024})
        cid = r.get("computer", {}).get("id")
        record("setup + computer ready", r.get("computer", {}).get("state") == "ready", r.get("computer", {}).get("state"))

        status, _ = ws_connect(f"/api/computers/{cid}/vnc")
        record("VNC proxy rejects unauthenticated upgrade", "401" in status, status)

        cookie = session_cookie()
        record("session cookie present after setup", cookie is not None, "jar")
        status, payload = ws_connect(f"/api/computers/{cid}/vnc", cookie)
        record("VNC proxy: 101 + real RFB banner through the whole chain",
               "101" in status and payload is not None and payload.startswith(b"RFB "),
               f"{status} payload={payload!r}")

        # wake-on-connect: sleep, then connect — the proxy must wake first
        api("POST", f"/api/computers/{cid}/sleep", {})
        lst = api("GET", "/api/computers")
        record("computer asleep before wake test", lst["computers"][0]["state"] == "sleeping",
               lst["computers"][0]["state"])
        status, payload = ws_connect(f"/api/computers/{cid}/vnc", cookie)
        lst = api("GET", "/api/computers")
        record("VNC connect wakes the computer and streams RFB",
               "101" in status and payload is not None and payload.startswith(b"RFB ")
               and lst["computers"][0]["state"] == "ready",
               f"{status} state={lst['computers'][0]['state']}")

        a = api("GET", "/api/audit")
        record("audit records the desktop connections",
               any(e["action"] == "computer.vnc_open" for e in a.get("entries", [])),
               [e["action"] for e in a.get("entries", [])][:6])
    finally:
        for p in (cp, sup):
            p.send_signal(signal.SIGTERM)
        if cid:
            subprocess.run(["docker", "rm", "-f", f"acp-{cid}"], capture_output=True)
            subprocess.run(["docker", "volume", "rm", "-f", f"acp-{cid}-home"], capture_output=True)
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nPHASE 3 DASHBOARD TESTS: {passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
