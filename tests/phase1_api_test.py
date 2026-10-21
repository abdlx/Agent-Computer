#!/usr/bin/env python3
"""
Phase 1 control-plane test: spawns the Docker supervisor + control plane
with throwaway state and drives the real API end to end (setup, auth,
computer CRUD through the supervisor, guest proxy, lifecycle, tokens,
audit, delete) plus supervisor abuse cases.
"""
import json
import os
import signal
import subprocess
import sys
import time

from test_environment import configure
configure()

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = "/tmp/acp-test"
PORT = 18787
BASE = f"http://127.0.0.1:{PORT}"
SOCK = f"{TMP}/supervisor.sock"
SECRET = "test-secret-123"
JAR = f"{TMP}/cookies.txt"

RESULTS = []


def record(name, ok, evidence=""):
    RESULTS.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} — {str(evidence)[:150]}", flush=True)


def curl(method, url, body=None, jar=True, headers=None, sock=None):
    cmd = ["curl", "-s", "-m", "120", "-X", method]
    if sock:
        cmd += ["--unix-socket", sock]
    if jar:
        cmd += ["-c", JAR, "-b", JAR]
    for h in headers or []:
        cmd += ["-H", h]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "-d", json.dumps(body)]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=150)
    try:
        return json.loads(r.stdout) if r.stdout else {}
    except Exception:
        return {"raw": r.stdout, "err": r.stderr}


def curl_status(method, url, body=None, jar=True, headers=None, sock=None):
    cmd = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "120", "-X", method]
    if sock:
        cmd += ["--unix-socket", sock]
    if jar:
        cmd += ["-c", JAR, "-b", JAR]
    for h in headers or []:
        cmd += ["-H", h]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "-d", json.dumps(body)]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=150)
    return int(r.stdout.strip())


def wait_port(url, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            code = curl_status("GET", url, jar=False)
            if code in (200, 401, 404):
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def main():
    subprocess.run(["rm", "-rf", TMP], check=False)
    os.makedirs(TMP, exist_ok=True)
    env = dict(os.environ)
    sup_env = {**env, "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET}
    sup = subprocess.Popen(
        ["node", "supervisor/src/server.ts"], cwd=REPO, env=sup_env,
        stdout=open(f"{TMP}/supervisor.log", "w"), stderr=subprocess.STDOUT)
    cp_env = {**env, "ACP_PORT": str(PORT), "ACP_DB": f"{TMP}/cp.db",
              "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET,
              "ACP_IDLE_TIMEOUT_S": "3600"}
    cp = subprocess.Popen(
        ["node", "apps/control-plane/src/server.ts"], cwd=REPO, env=cp_env,
        stdout=open(f"{TMP}/control-plane.log", "w"), stderr=subprocess.STDOUT)
    cid = None
    try:
        assert wait_port(f"{BASE}/api/health"), "control plane did not start"
        # supervisor ping
        ping = curl("POST", "http://localhost/ping", {}, jar=False, sock=SOCK,
                    headers=[f"x-supervisor-secret: {SECRET}"])
        record("supervisor ping", ping.get("ok") is True, ping)

        # setup flow
        st = curl("GET", f"{BASE}/api/setup/status", jar=False)
        record("setup initially required", st.get("needsSetup") is True, st)
        code = curl_status("GET", f"{BASE}/api/computers", jar=False)
        record("unauthenticated computers list -> 401", code == 401, code)
        code = curl_status("POST", f"{BASE}/api/setup",
                           {"username": "owner", "password": "short"}, jar=True)
        record("setup rejects short password", code == 400, code)
        r = curl("POST", f"{BASE}/api/setup",
                 {"username": "owner", "password": "correct horse battery"}, jar=True)
        record("setup creates owner + session", r.get("ok") is True, r)
        code = curl_status("POST", f"{BASE}/api/setup",
                           {"username": "second", "password": "another long password"}, jar=True)
        record("second setup -> 409", code == 409, code)
        me = curl("GET", f"{BASE}/api/auth/me")
        record("me returns owner", me.get("username") == "owner", me)

        # CSRF guard
        code = curl_status("POST", f"{BASE}/api/computers", {"name": "X"}, jar=True)
        record("mutation without x-acp-request -> 403", code == 403, code)

        # create a real computer
        r = curl("POST", f"{BASE}/api/computers",
                 {"name": "Test Box", "cpuMillis": 1000, "memoryMb": 1024, "diskGb": 10},
                 headers=["x-acp-request: 1"])
        comp = r.get("computer", {})
        cid = comp.get("id")
        record("create computer -> ready", r.get("computer", {}).get("state") == "ready", r)
        lst = curl("GET", f"{BASE}/api/computers")
        record("list shows the computer", len(lst.get("computers", [])) == 1, lst)

        # guest proxy (token-authenticated inside)
        h = curl("GET", f"{BASE}/api/computers/{cid}/guest/health")
        record("guest proxy health", h.get("ok") is True, str(h)[:120])
        scr = curl("POST", f"{BASE}/api/computers/{cid}/guest/input/move",
                   {"x": 321, "y": 234}, headers=["x-acp-request: 1"])
        cur = curl("GET", f"{BASE}/api/computers/{cid}/guest/cursor")
        record("guest proxy input + cursor", scr.get("x") == 321 and cur == {"x": 321, "y": 234},
               f"move={scr} cursor={cur}")

        # stats (values are 0 on this cgroup-less VM; shape is the contract)
        s = curl("GET", f"{BASE}/api/computers/{cid}/stats")
        record("stats shape", s.get("running") is True and "cpuPercent" in s.get("stats", {}), s)

        # lifecycle through the API
        r = curl("POST", f"{BASE}/api/computers/{cid}/sleep", {}, headers=["x-acp-request: 1"])
        record("sleep via API", r.get("computer", {}).get("state") == "sleeping", r)
        h = curl("GET", f"{BASE}/api/computers/{cid}/guest/health")
        lst = curl("GET", f"{BASE}/api/computers")
        woken_state = lst["computers"][0]["state"] if lst.get("computers") else "MISSING"
        record("guest call wakes the computer",
               h.get("ok") is True and woken_state == "ready",
               f"health ok={h.get('ok')} state={woken_state}")
        r = curl("POST", f"{BASE}/api/computers/{cid}/stop", {}, headers=["x-acp-request: 1"])
        record("manual stop via API", r.get("computer", {}).get("state") == "stopped", r)
        r = curl("POST", f"{BASE}/api/computers/{cid}/start", {}, headers=["x-acp-request: 1"])
        record("start via API", r.get("computer", {}).get("state") == "ready", r)

        # supervisor abuse cases (direct)
        code = curl_status("POST", "http://localhost/ping", {}, jar=False, sock=SOCK,
                           headers=["x-supervisor-secret: WRONG"])
        record("supervisor rejects wrong secret", code == 401, code)
        code = curl_status("POST", "http://localhost/create",
                           {"computerId": "evil-1", "Privileged": True}, jar=False, sock=SOCK,
                           headers=[f"x-supervisor-secret: {SECRET}"])
        record("supervisor rejects payload with Privileged field", code == 400, code)
        code = curl_status("POST", "http://localhost/create",
                           {"computerId": "evil-2", "image": "alpine"}, jar=False, sock=SOCK,
                           headers=[f"x-supervisor-secret: {SECRET}"])
        record("supervisor rejects caller-chosen image", code == 400, code)
        code = curl_status("POST", "http://localhost/stop",
                           {"computerId": "../guest1"}, jar=False, sock=SOCK,
                           headers=[f"x-supervisor-secret: {SECRET}"])
        record("supervisor cannot be aimed at foreign containers", code in (400, 403, 404), code)
        insp = curl("POST", "http://localhost/inspect", {"computerId": cid.split("-", 1)[1] if False else cid},
                    jar=False, sock=SOCK, headers=[f"x-supervisor-secret: {SECRET}"])
        record("created container is not privileged", insp.get("privileged") is False, insp)

        # tokens
        t = curl("POST", f"{BASE}/api/tokens",
                 {"name": "hermes", "scopes": ["read", "write"], "computerId": cid},
                 headers=["x-acp-request: 1"])
        record("create MCP token (shown once)", str(t.get("token", "")).startswith("acp_"), t.get("id"))
        tl = curl("GET", f"{BASE}/api/tokens")
        row = (tl.get("tokens") or [{}])[0]
        record("token list hides the secret",
               len(tl.get("tokens", [])) == 1
               and "token" not in row and "token_hash" not in row
               and row.get("scopes") == ["read", "write"],
               tl)
        code = curl_status("DELETE", f"{BASE}/api/tokens/{t['id']}", {}, headers=["x-acp-request: 1"])
        record("revoke token", code == 200, code)

        # audit
        a = curl("GET", f"{BASE}/api/audit")
        actions = {e["action"] for e in a.get("entries", [])}
        record("audit log records the journey",
               {"auth.setup", "computer.create", "computer.sleep", "token.create"} <= actions,
               sorted(actions))

        # delete with typed confirmation
        code = curl_status("DELETE", f"{BASE}/api/computers/{cid}", {"confirmName": "Wrong"},
                           headers=["x-acp-request: 1"])
        record("delete without exact name -> 400", code == 400, code)
        r = curl("DELETE", f"{BASE}/api/computers/{cid}", {"confirmName": "Test Box"},
                 headers=["x-acp-request: 1"])
        record("delete computer", r.get("ok") is True, r)
        lst = curl("GET", f"{BASE}/api/computers")
        leftover = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"name=acp-{cid}"],
                                  capture_output=True, text=True).stdout.strip()
        record("delete removed container + volume",
               len(lst.get("computers", [])) == 0 and leftover == "",
               f"list={len(lst.get('computers', []))} volume leftover={leftover!r}")
        cid = None

        # auth round trip
        r = curl("POST", f"{BASE}/api/auth/logout", {}, headers=["x-acp-request: 1"])
        code = curl_status("GET", f"{BASE}/api/auth/me")
        record("logout invalidates the session", r.get("ok") is True and code == 401, code)
        code = curl_status("POST", f"{BASE}/api/auth/login",
                           {"username": "owner", "password": "wrong password"}, jar=True)
        record("wrong password -> 401", code == 401, code)
        r = curl("POST", f"{BASE}/api/auth/login",
                 {"username": "owner", "password": "correct horse battery"}, jar=True)
        me = curl("GET", f"{BASE}/api/auth/me")
        record("login works after logout", r.get("ok") is True and me.get("username") == "owner", me)
    finally:
        for p in (cp, sup):
            p.send_signal(signal.SIGTERM)
        if cid:
            subprocess.run(["docker", "rm", "-f", f"acp-{cid}"], capture_output=True)
            subprocess.run(["docker", "volume", "rm", "-f", f"acp-{cid}-home"], capture_output=True)
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nPHASE 1 API TESTS: {passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
