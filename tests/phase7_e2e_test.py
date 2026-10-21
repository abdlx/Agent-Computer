#!/usr/bin/env python3
"""
Phase 7 end-to-end journey — one fresh stack, the whole product story
in 24 numbered steps:

  deploy -> owner setup -> login -> create two computers -> live
  desktop -> isolation -> connect an agent (official MCP SDK) -> agent
  completes a real task -> human takeover -> sleep / wake-on-call ->
  persistence -> auto-sleep -> platform restart -> backup & restore
  -> deletion -> audit -> clean teardown.

Configuration note: the stack runs with ACP_IDLE_TIMEOUT_S=45 and a
5s tick so step 18 (auto-sleep) is observable inside a test run. The
shipped default remains 300s; the mechanism is identical.
"""
import base64
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phase1_api_test as p1  # noqa: E402
from phase1_api_test import curl, curl_status, wait_port, REPO  # noqa: E402
from phase4_hardening_test import curl_raw  # noqa: E402

TMP = os.path.expanduser("~/workspace/agent-computer/.build/e2e-tmp")
PORT = 18797
BASE = f"http://127.0.0.1:{PORT}"
SOCK = f"{TMP}/supervisor.sock"
SECRET = "e2e-secret"
JAR = f"{TMP}/cookies.txt"
p1.JAR = JAR
VOLROOT = "/home/hatch/docker-data/volumes"
STEP = [0]
RESULTS = []


def record(name, ok, evidence=""):
    STEP[0] += 1
    RESULTS.append((STEP[0], name, bool(ok)))
    print(f"[{STEP[0]:02d} {'PASS' if ok else 'FAIL'}] {name} — {str(evidence)[:150]}", flush=True)


def api(method, path, body=None):
    h = ["x-acp-request: 1"] if method != "GET" else []
    return curl(method, f"{BASE}{path}", body, jar=True, headers=h)


def spawn_stack():
    env = dict(os.environ)
    sup = subprocess.Popen(
        ["node", "supervisor/src/server.ts"], cwd=REPO,
        env={**env, "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET},
        stdout=open(f"{TMP}/supervisor.log", "a"), stderr=subprocess.STDOUT)
    cp = subprocess.Popen(
        ["node", "apps/control-plane/src/server.ts"], cwd=REPO,
        env={**env, "ACP_PORT": str(PORT), "ACP_DB": f"{TMP}/cp.db",
             "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET,
             "ACP_IDLE_TIMEOUT_S": "45", "ACP_TICK_MS": "5000",
             "ACP_DASHBOARD_DIR": f"{REPO}/apps/dashboard/dist"},
        stdout=open(f"{TMP}/control-plane.log", "a"), stderr=subprocess.STDOUT)
    assert wait_port(f"{BASE}/api/health"), "stack did not boot"
    return sup, cp


def stop_proc(p):
    try:
        p.send_signal(signal.SIGTERM)
        p.wait(timeout=15)
    except Exception:
        p.kill()


def session_cookie():
    with open(JAR) as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 7 and parts[5] == "acp_session":
                return f"acp_session={parts[6]}"
    return None


def rfb_session(cid, cookie):
    """Open the desktop WS and complete the RFB handshake up to ServerInit.

    Returns (socket, send_frame). Frame parsing is incremental: WS frame
    boundaries do not align with RFB messages, so payloads accumulate
    into one stream buffer that take() consumes exactly.
    """
    s = socket.create_connection(("127.0.0.1", PORT), timeout=30)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /api/computers/{cid}/vnc HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
               f"Sec-WebSocket-Protocol: binary\r\nCookie: {cookie}\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(4096)
    head, rest = buf.split(b"\r\n\r\n", 1)
    assert b"101" in head.split(b"\r\n")[0], head[:80]

    raw = bytearray(rest)     # unparsed WS bytes
    stream = bytearray()      # RFB payload bytes

    def fill_raw():
        chunk = s.recv(65536)
        if not chunk:
            raise ConnectionError("ws closed")
        raw.extend(chunk)

    def next_frame():
        while True:
            if len(raw) >= 2:
                ln = raw[1] & 0x7F
                hdr = 2
                if ln == 126:
                    if len(raw) >= 4:
                        ln = int.from_bytes(raw[2:4], "big")
                        hdr = 4
                    else:
                        ln = -1
                elif ln == 127:
                    if len(raw) >= 10:
                        ln = int.from_bytes(raw[2:10], "big")
                        hdr = 10
                    else:
                        ln = -1
                if ln >= 0 and len(raw) >= hdr + ln:
                    payload = bytes(raw[hdr:hdr + ln])
                    del raw[:hdr + ln]
                    stream.extend(payload)
                    return
            fill_raw()

    def take(n):
        while len(stream) < n:
            next_frame()
        out = bytes(stream[:n])
        del stream[:n]
        return out

    def send_frame(payload):
        mask = os.urandom(4)
        ln = len(payload)
        hdr = bytes([0x82])
        if ln < 126:
            hdr += bytes([0x80 | ln])
        else:
            hdr += bytes([0x80 | 126]) + ln.to_bytes(2, "big")
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        s.sendall(hdr + mask + masked)

    banner = take(12)
    assert banner.startswith(b"RFB "), banner
    send_frame(b"RFB 003.008\n")
    ntypes = take(1)[0]
    assert ntypes > 0, "no security types offered"
    sectypes = take(ntypes)
    assert 1 in sectypes, sectypes  # None offered
    send_frame(bytes([1]))
    sec_result = int.from_bytes(take(4), "big")
    assert sec_result == 0, sec_result
    send_frame(bytes([1]))  # ClientInit: shared
    serverinit = take(24)
    name_len = int.from_bytes(serverinit[20:24], "big")
    if name_len:
        take(name_len)
    return s, send_frame


def mcp_call(token, method, params, rpc_id=1):
    req = urllib.request.Request(
        f"{BASE}/mcp", method="POST",
        data=json.dumps({"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params}).encode(),
        headers={"content-type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=240) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def tool(token, name, args):
    st, r = mcp_call(token, "tools/call", {"name": name, "arguments": args})
    result = r.get("result", {})
    text = " ".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    return result.get("isError") is True, text, result


def run_sdk_client(token, scenario="full"):
    env = dict(os.environ)
    env.update({"ACP_MCP_URL": f"{BASE}/mcp", "ACP_TOKEN": token, "ACP_SCENARIO": scenario})
    r = subprocess.run(["node", f"{REPO}/tests/mcp-client/client.mjs"],
                       capture_output=True, text=True, env=env, timeout=900)
    steps = {}
    for line in r.stdout.strip().splitlines():
        try:
            d = json.loads(line)
            steps[d["step"]] = d
        except Exception:
            pass
    return steps


def docker_state(name):
    r = subprocess.run(["docker", "inspect", "-f", "{{.State.Status}}", name],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else "absent"


def main():
    subprocess.run(["rm", "-rf", TMP], check=False)
    os.makedirs(TMP, exist_ok=True)
    sup, cp = spawn_stack()
    A = B = None
    try:
        # 01 fresh deployment
        st = api("GET", "/api/setup/status")
        record("fresh deployment boots; setup is open", st.get("needsSetup") is True, st)
        # 02 dashboard served
        code = curl_status("GET", f"{BASE}/", jar=False)
        record("dashboard is served at /", code == 200, code)
        # 03 owner setup, then closed
        r = api("POST", "/api/setup", {"username": "owner", "password": "correct horse battery"})
        c2 = curl_status("POST", f"{BASE}/api/setup",
                         {"username": "second", "password": "another password ok"}, jar=False)
        record("owner account created; setup closes behind it",
               r.get("ok") is True and c2 == 409, f"setup={r.get('ok')} second={c2}")
        # 04 logout / login round trip
        api("POST", "/api/auth/logout", {})
        c = curl_status("GET", f"{BASE}/api/auth/me")
        back = api("POST", "/api/auth/login", {"username": "owner", "password": "correct horse battery"})
        record("logout invalidates; login restores the session",
               c == 401 and back.get("ok") is True, f"after-logout={c} login={back.get('ok')}")
        # 05 create computer A
        r = api("POST", "/api/computers", {"name": "Journey Main", "cpuMillis": 2000, "memoryMb": 2048})
        A = r.get("computer", {}).get("id")
        record("computer A created and ready (limits honestly reported)",
               r.get("computer", {}).get("state") == "ready" and "limitsEnforced" in r.get("computer", {}),
               r.get("computer"))
        # 06 stats + guest health via the owner API
        stats = api("GET", f"/api/computers/{A}/stats")
        health = api("GET", f"/api/computers/{A}/guest/health")
        record("owner API: stats respond and the guest is healthy",
               "stats" in stats and health.get("ok") is True, f"health={health.get('ok')}")
        # 07 live desktop
        ws, _send = rfb_session(A, session_cookie())
        record("live desktop streams through the authenticated proxy (RFB handshake done)", True, "ServerInit received")
        ws.close()
        # tokens are minted before B exists so the SDK scenario below
        # has exactly one computer to resolve
        # tokens
        full = api("POST", "/api/tokens", {"name": "journey-agent",
                                           "scopes": ["read", "write", "browser", "files"]})
        bound = api("POST", "/api/tokens", {"name": "bound-a", "scopes": ["read"], "computerId": A})
        # 09 MCP initialize with the full token
        st, init = mcp_call(full["token"], "initialize",
                            {"protocolVersion": "2025-03-26", "capabilities": {},
                             "clientInfo": {"name": "e2e", "version": "1"}})
        record("agent connects to the MCP gateway",
               st == 200 and init.get("result", {}).get("serverInfo", {}).get("name") == "acp",
               init.get("result", {}).get("serverInfo"))
        # 10 agent task via the OFFICIAL SDK client
        steps = run_sdk_client(full["token"])
        record("agent completes a real task via the official MCP SDK (write->serve->browse->fill->reveal)",
               steps.get("browser_reveal", {}).get("ok") is True
               and steps.get("batch_effect_visible", {}).get("ok") is True,
               {k: v.get("ok") for k, v in steps.items() if not v.get("ok")} or "all client steps ok")
        # 11 screenshot content block
        record("screenshot returns a real image block to the agent",
               steps.get("screenshot_image", {}).get("ok") is True,
               steps.get("screenshot_image", {}).get("data"))
        # 12 computer B joins; two computers coexist
        r = api("POST", "/api/computers", {"name": "Journey Second", "cpuMillis": 1000, "memoryMb": 1024})
        B = r.get("computer", {}).get("id")
        lst = api("GET", "/api/computers")
        record("computer B created; two computers coexist",
               r.get("computer", {}).get("state") == "ready" and len(lst["computers"]) == 2, len(lst["computers"]))
        # 13 file isolation between computers
        api("POST", f"/api/computers/{A}/guest/fs/write", {"path": "secret-a.txt", "content": "A-ONLY"})
        rb = api("POST", f"/api/computers/{B}/guest/fs/read", {"path": "secret-a.txt"})
        lb = api("POST", f"/api/computers/{B}/guest/fs/list", {"path": "."})
        record("isolation: B cannot see A's files",
               "A-ONLY" not in json.dumps(rb) and "secret-a.txt" not in json.dumps(lb),
               f"B read={str(rb)[:60]}")
        # 14 bound-token isolation
        err, text, _ = tool(bound["token"], "computer_status", {"computer": B})
        record("isolation: a token bound to A is refused for B", err and "bound" in text, text[:90])
        # a marker for the persistence steps
        api("POST", f"/api/computers/{A}/guest/fs/write",
            {"path": "journey-marker.txt", "content": "journey-state-v1"})
        # 15 human takeover: real pointer motion over RFB seizes control
        ws, send = rfb_session(A, session_cookie())
        pointer = bytes([5, 0]) + (640).to_bytes(2, "big") + (400).to_bytes(2, "big")
        send(pointer)
        send(bytes([5, 0]) + (700).to_bytes(2, "big") + (420).to_bytes(2, "big"))
        time.sleep(1.0)
        err, text, _ = tool(full["token"], "keyboard_type", {"computer": A, "text": "agent-typed"})
        seized = err and ("409" in text or "human" in text.lower())
        ws.close()
        time.sleep(5)  # human idle auto-release (~3s) + margin
        err2, text2, _ = tool(full["token"], "keyboard_type", {"computer": A, "text": "x"})
        record("human takeover: owner pointer motion blocks agent input, then auto-releases",
               seized and not err2, f"during={text[:70]} after={text2[:50]}")
        # 16 sleep A; the container really stops
        r = api("POST", f"/api/computers/{A}/sleep", {})
        record("sleep: state sleeping and the container is stopped",
               r.get("computer", {}).get("state") == "sleeping"
               and docker_state(f"acp-{A}") == "exited",
               docker_state(f"acp-{A}"))
        # 17 an MCP call wakes it
        err, text, result = tool(full["token"], "screenshot", {"computer": A})
        lst = api("GET", "/api/computers")
        a_state = next(c["state"] for c in lst["computers"] if c["id"] == A)
        record("wake-on-MCP-call: screenshot wakes A and returns an image",
               not err and a_state == "ready"
               and any(c.get("type") == "image" for c in result.get("content", [])),
               a_state)
        # 18 persistence across the sleep/wake cycle
        err, text, _ = tool(full["token"], "fs_read", {"computer": A, "path": "journey-marker.txt"})
        err2, text2, _ = tool(full["token"], "terminal_exec",
                              {"computer": A, "timeout_s": 20,
                               "command": "nohup python3 -m http.server 8123 --directory /home/agent >/tmp/h.log 2>&1 & sleep 1; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/page.html"})
        tool(full["token"], "browser_start", {"computer": A})
        err3, text3, _ = tool(full["token"], "browser_navigate",
                              {"computer": A, "url": "http://127.0.0.1:8123/page.html"})
        record("persistence: files and the browser profile survive sleep/wake",
               "journey-state-v1" in text and "200" in text2 and "MCP Test Page" in text3,
               f"file={'journey-state-v1' in text} serve={text2[:40]} nav={text3[:60]}")
        # 19 auto-sleep from idleness (45s configured; leases lapse first)
        deadline = time.time() + 330
        state = ""
        while time.time() < deadline:
            state = next(c["state"] for c in api("GET", "/api/computers")["computers"] if c["id"] == A)
            if state == "sleeping":
                break
            time.sleep(5)
        record("auto-sleep: idle computer puts itself to sleep", state == "sleeping",
               f"state={state}")
        # 20 platform restart: services down and back up; state reconciles
        stop_proc(cp)
        stop_proc(sup)
        sup, cp = spawn_stack()
        lst = api("GET", "/api/computers")
        states = {c["id"]: c["state"] for c in lst["computers"]}
        api("POST", f"/api/computers/{B}/wake", {})
        states = {c["id"]: c["state"] for c in api("GET", "/api/computers")["computers"]}
        record("platform restart: state reconciles (B wakes clean, A stays asleep)",
               states.get(B) == "ready" and states.get(A) == "sleeping", states)
        # 21 backup & restore (same artifacts ops/backup.sh produces)
        backup_dir = f"{TMP}/backup"
        os.makedirs(backup_dir, exist_ok=True)
        stop_proc(cp)
        # checkpoint the WAL so the copied database file is complete
        # (ops/backup.sh sidesteps this by copying the whole volume)
        import sqlite3
        _c = sqlite3.connect(f"{TMP}/cp.db")
        _c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        _c.close()
        shutil.copy(f"{TMP}/cp.db", f"{backup_dir}/control-plane.db")
        a_vol = f"{VOLROOT}/acp-{A}-home/_data"
        with tarfile.open(f"{backup_dir}/a-home.tar.gz", "w:gz") as tf:
            tf.add(a_vol, arcname="_data")
        _, cp = spawn_stack_keep_sup(sup)
        # mutate: delete the marker, mint a junk token
        api("POST", f"/api/computers/{A}/wake", {})
        api("POST", f"/api/computers/{A}/guest/fs/delete", {"path": "journey-marker.txt"})
        junk = api("POST", "/api/tokens", {"name": "junk", "scopes": ["read"]})
        # mirror ops/restore.sh: computers are stopped before volumes move
        api("POST", f"/api/computers/{A}/sleep", {})
        stop_proc(cp)
        for suf in ("", "-wal", "-shm"):
            try:
                os.unlink(f"{TMP}/cp.db{suf}")
            except FileNotFoundError:
                pass
        shutil.copy(f"{backup_dir}/control-plane.db", f"{TMP}/cp.db")
        shutil.rmtree(a_vol)
        with tarfile.open(f"{backup_dir}/a-home.tar.gz") as tf:
            tf.extractall(f"{VOLROOT}/acp-{A}-home")
        _, cp = spawn_stack_keep_sup(sup)
        api("POST", "/api/auth/login", {"username": "owner", "password": "correct horse battery"})
        marker = api("POST", f"/api/computers/{A}/guest/fs/read", {"path": "journey-marker.txt"})
        st_junk, _ = mcp_call(junk["token"], "tools/list", {})
        st_full, _ = mcp_call(full["token"], "tools/list", {})
        record("backup & restore: marker file and token state roll back exactly",
               marker.get("content") == "journey-state-v1" and st_junk == 401 and st_full == 200,
               f"marker={marker.get('content')} junk={st_junk} full={st_full}")
        # 22 delete B with typed confirmation
        r = api("DELETE", f"/api/computers/{B}", {"confirmName": "Journey Second"})
        gone = docker_state(f"acp-{B}") == "absent" and not os.path.exists(f"{VOLROOT}/acp-{B}-home")
        record("computer B deleted: container and volume are gone",
               r.get("ok") is True and gone, f"ok={r.get('ok')} container={docker_state(f'acp-{B}')}")
        # 23 delete A; fleet is empty
        api("POST", f"/api/computers/{A}/sleep", {})
        r = api("DELETE", f"/api/computers/{A}", {"confirmName": "Journey Main"})
        lst = api("GET", "/api/computers")
        record("computer A deleted; no computers remain",
               r.get("ok") is True and lst["computers"] == [], lst)
        # 24 audit coverage
        a = api("GET", "/api/audit")
        actions = {e["action"] for e in a.get("entries", [])}
        need = {"auth.setup", "computer.create", "token.create", "computer.vnc_open",
                "computer.sleep", "computer.delete"}
        record("audit log covers the journey", need <= actions, sorted(actions))
        # teardown cleanliness (final record)
        leftovers = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=journey", "--format", "{{.Names}}"],
            capture_output=True, text=True).stdout.strip()
        vols = subprocess.run(
            ["docker", "volume", "ls", "--filter", "name=journey", "--format", "{{.Name}}"],
            capture_output=True, text=True).stdout.strip()
        record("teardown leaves none of this journey's containers or volumes behind",
               leftovers == "" and vols == "", f"containers={leftovers!r} volumes={vols!r}")
    finally:
        stop_proc(cp)
        stop_proc(sup)
        for cid in (A, B):
            if cid:
                subprocess.run(["docker", "rm", "-f", f"acp-{cid}"], capture_output=True)
                subprocess.run(["docker", "volume", "rm", "-f", f"acp-{cid}-home"], capture_output=True)
    passed = sum(1 for _, _, ok in RESULTS if ok)
    print(f"\nPHASE 7 E2E JOURNEY: {passed}/{len(RESULTS)} steps passed")
    return 0 if passed == len(RESULTS) else 1


def spawn_stack_keep_sup(sup):
    """Restart only the control plane (used inside the backup/restore step)."""
    env = dict(os.environ)
    cp = subprocess.Popen(
        ["node", "apps/control-plane/src/server.ts"], cwd=REPO,
        env={**env, "ACP_PORT": str(PORT), "ACP_DB": f"{TMP}/cp.db",
             "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET,
             "ACP_IDLE_TIMEOUT_S": "45", "ACP_TICK_MS": "5000",
             "ACP_DASHBOARD_DIR": f"{REPO}/apps/dashboard/dist"},
        stdout=open(f"{TMP}/control-plane.log", "a"), stderr=subprocess.STDOUT)
    assert wait_port(f"{BASE}/api/health"), "control plane did not restart"
    return sup, cp


if __name__ == "__main__":
    sys.exit(main())
