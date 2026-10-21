#!/usr/bin/env python3
"""
Phase 4 hardening tests:
- control-plane restart recovery (state reconciled against Docker)
- control-plane restart with the container deleted while down -> failed
- supervisor restart is transparent (it is stateless)
- v1 -> v2 schema migration on an existing database
- stale lease expiry lets the idle engine sleep the computer
- supervisor host-disk guard refuses creation when the disk is "full"
"""
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phase1_api_test as p1  # noqa: E402
from phase1_api_test import curl, wait_port, REPO  # noqa: E402


def curl_raw(method, url, body=None, jar_file=None):
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "-m", "120", "-X", method]
    if jar_file:
        cmd += ["-c", jar_file, "-b", jar_file]
    if method != "GET":
        cmd += ["-H", "x-acp-request: 1"]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "-d", json.dumps(body)]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=150)
    text, _, code = r.stdout.rpartition("\n")
    return int(code), text

RESULTS = []


def record(name, ok, evidence=""):
    RESULTS.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} — {str(evidence)[:170]}", flush=True)


def spawn_pair(tmp, port, secret, extra_cp=None, extra_sup=None):
    os.makedirs(tmp, exist_ok=True)
    env = dict(os.environ)
    sup = subprocess.Popen(
        ["node", "supervisor/src/server.ts"], cwd=REPO,
        env={**env, "ACP_SUPERVISOR_SOCK": f"{tmp}/supervisor.sock",
             "ACP_SUPERVISOR_SECRET": secret, **(extra_sup or {})},
        stdout=open(f"{tmp}/supervisor.log", "w"), stderr=subprocess.STDOUT)
    cp = subprocess.Popen(
        ["node", "apps/control-plane/src/server.ts"], cwd=REPO,
        env={**env, "ACP_PORT": str(port), "ACP_DB": f"{tmp}/cp.db",
             "ACP_SUPERVISOR_SOCK": f"{tmp}/supervisor.sock",
             "ACP_SUPERVISOR_SECRET": secret, "ACP_IDLE_TIMEOUT_S": "3600",
             **(extra_cp or {})},
        stdout=open(f"{tmp}/control-plane.log", "w"), stderr=subprocess.STDOUT)
    assert wait_port(f"http://127.0.0.1:{port}/api/health"), f"cp on {port} did not start"
    return sup, cp


def stop(p, sig=signal.SIGTERM):
    try:
        p.send_signal(sig)
        p.wait(timeout=15)
    except Exception:
        p.kill()


def docker_rm(cid):
    subprocess.run(["docker", "rm", "-f", f"acp-{cid}"], capture_output=True)
    subprocess.run(["docker", "volume", "rm", "-f", f"acp-{cid}-home"], capture_output=True)


def main():
    # ---------- pair A: restarts + migration -------------------------------
    TMP = "/tmp/acp-test4"
    PORT = 18790
    BASE = f"http://127.0.0.1:{PORT}"
    subprocess.run(["rm", "-rf", TMP], check=False)
    p1.JAR = f"{TMP}/cookies.txt"

    def api(method, path, body=None):
        h = ["x-acp-request: 1"] if method != "GET" else []
        return curl(method, f"{BASE}{path}", body, jar=True, headers=h)

    sup, cp = spawn_pair(TMP, PORT, "secret-a")
    cid = None
    try:
        api("POST", "/api/setup", {"username": "owner", "password": "correct horse battery"})
        r = api("POST", "/api/computers", {"name": "Phoenix", "cpuMillis": 1000, "memoryMb": 1024})
        cid = r.get("computer", {}).get("id")
        record("A: computer ready; limitsEnforced persisted in the API",
               r.get("computer", {}).get("state") == "ready"
               and r.get("computer", {}).get("limitsEnforced") is False,
               r.get("computer"))

        # control-plane restart: same DB, state must reconcile to ready
        stop(cp)
        _, cp = spawn_pair(TMP, PORT, "secret-a")
        lst = api("GET", "/api/computers")
        health = api("GET", f"/api/computers/{cid}/guest/health")
        record("A: CP restart — computer reconciled ready and reachable",
               lst["computers"][0]["state"] == "ready" and health.get("ok") is True,
               f"state={lst['computers'][0]['state']} health={health.get('ok')}")
        record("A: limitsEnforced survives the restart",
               lst["computers"][0].get("limitsEnforced") is False, lst["computers"][0])

        # supervisor restart: stateless, operations keep working
        stop(sup)
        sup2 = subprocess.Popen(
            ["node", "supervisor/src/server.ts"], cwd=REPO,
            env={**os.environ, "ACP_SUPERVISOR_SOCK": f"{TMP}/supervisor.sock",
                 "ACP_SUPERVISOR_SECRET": "secret-a"},
            stdout=open(f"{TMP}/supervisor2.log", "w"), stderr=subprocess.STDOUT)
        sup = sup2
        time.sleep(1)
        r = api("POST", f"/api/computers/{cid}/sleep", {})
        record("A: supervisor restart — lifecycle still works",
               r.get("computer", {}).get("state") == "sleeping", r.get("computer", {}).get("state"))
        r = api("POST", f"/api/computers/{cid}/wake", {})
        record("A: wake after supervisor restart",
               r.get("computer", {}).get("state") == "ready", r.get("computer", {}).get("state"))

        # container deleted while the CP is down -> restart marks failed
        stop(cp)
        subprocess.run(["docker", "rm", "-f", f"acp-{cid}"], capture_output=True)
        _, cp = spawn_pair(TMP, PORT, "secret-a")
        lst = api("GET", "/api/computers")
        record("A: CP restart with container gone — state is honestly 'failed'",
               lst["computers"][0]["state"] == "failed", lst["computers"][0]["state"])
        # clean the orphaned row/volume through the API delete path pieces
        subprocess.run(["docker", "volume", "rm", "-f", f"acp-{cid}-home"], capture_output=True)
        cid = None
    finally:
        stop(cp)
        stop(sup)
        if cid:
            docker_rm(cid)

    # schema version after all that
    v = sqlite3.connect(f"{TMP}/cp.db").execute("SELECT v FROM schema_version").fetchone()[0]
    record("A: schema is at v2 after migrations", v == 2, v)

    # ---------- v1 -> v2 migration on a hand-built v1 database -------------
    TMP2 = "/tmp/acp-test4-mig"
    subprocess.run(["rm", "-rf", TMP2], check=False)
    os.makedirs(TMP2, exist_ok=True)
    db = sqlite3.connect(f"{TMP2}/cp.db")
    db.executescript("""
    CREATE TABLE schema_version (v INTEGER NOT NULL);
    INSERT INTO schema_version (v) VALUES (1);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE computers (id TEXT PRIMARY KEY, name TEXT NOT NULL, container TEXT NOT NULL,
      volume TEXT NOT NULL, socket_path TEXT NOT NULL, guest_token TEXT NOT NULL,
      state TEXT NOT NULL, cpu_millis INTEGER NOT NULL, memory_mb INTEGER NOT NULL,
      disk_gb INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE mcp_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL,
      scopes TEXT NOT NULL, computer_id TEXT, created_at INTEGER NOT NULL,
      last_used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, computer_id TEXT, detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE engine_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
    """)
    db.commit(); db.close()
    sup, cp = spawn_pair(TMP2, 18791, "secret-mig")
    try:
        st, _ = curl_raw("GET", "http://127.0.0.1:18791/api/setup/status")
        v = sqlite3.connect(f"{TMP2}/cp.db").execute("SELECT v FROM schema_version").fetchone()[0]
        cols = [r[1] for r in sqlite3.connect(f"{TMP2}/cp.db").execute("PRAGMA table_info(computers)")]
        record("migration: v1 database upgrades in place and serves",
               st == 200 and v == 2 and "limits_enforced" in cols, f"status={st} v={v}")
    finally:
        stop(cp)
        stop(sup)

    # ---------- pair B: stale lease lets the engine sleep ------------------
    TMP3 = "/tmp/acp-test4-lease"
    subprocess.run(["rm", "-rf", TMP3], check=False)
    p1.JAR = f"{TMP3}/cookies.txt"
    BASE3 = "http://127.0.0.1:18792"
    sup, cp = spawn_pair(TMP3, 18792, "secret-b",
                         extra_cp={"ACP_IDLE_TIMEOUT_S": "20", "ACP_TICK_MS": "2000"})
    cid = None
    try:
        def api3(method, path, body=None):
            h = ["x-acp-request: 1"] if method != "GET" else []
            return curl(method, f"{BASE3}{path}", body, jar=True, headers=h)
        api3("POST", "/api/setup", {"username": "owner", "password": "correct horse battery"})
        r = api3("POST", "/api/computers", {"name": "Lease Box", "cpuMillis": 1000, "memoryMb": 1024})
        cid = r.get("computer", {}).get("id")
        lease = api3("POST", f"/api/computers/{cid}/leases", {"owner": "test", "ttlS": 8})
        record("B: lease acquired", bool(lease.get("lease", {}).get("id")), lease)
        time.sleep(5)
        lst = api3("GET", "/api/computers")
        record("B: live lease keeps the computer awake", lst["computers"][0]["state"] in ("ready", "idle"),
               lst["computers"][0]["state"])
        deadline = time.time() + 90
        state = ""
        while time.time() < deadline:
            state = api3("GET", "/api/computers")["computers"][0]["state"]
            if state == "sleeping":
                break
            time.sleep(3)
        record("B: after the lease lapses, the idle engine sleeps it", state == "sleeping", state)
    finally:
        stop(cp)
        stop(sup)
        if cid:
            docker_rm(cid)

    # ---------- pair C: disk guard ------------------------------------------
    TMP4 = "/tmp/acp-test4-disk"
    subprocess.run(["rm", "-rf", TMP4], check=False)
    p1.JAR = f"{TMP4}/cookies.txt"
    BASE4 = "http://127.0.0.1:18793"
    sup, cp = spawn_pair(TMP4, 18793, "secret-c", extra_sup={"ACP_MIN_FREE_DISK_GB": "999999"})
    try:
        def api4(method, path, body=None):
            h = ["x-acp-request: 1"] if method != "GET" else []
            return curl(method, f"{BASE4}{path}", body, jar=True, headers=h)
        api4("POST", "/api/setup", {"username": "owner", "password": "correct horse battery"})
        st, raw = curl_raw("POST", f"{BASE4}/api/computers",
                           {"name": "Nope", "cpuMillis": 1000, "memoryMb": 1024},
                           jar_file=f"{TMP4}/cookies.txt")
        record("C: disk guard refuses creation with a clear error",
               st >= 400 and "insufficient free disk" in raw, f"{st} {raw[:140]}")
        lst = api4("GET", "/api/computers")
        record("C: no half-created computer left behind", lst["computers"] == [], lst)
    finally:
        stop(cp)
        stop(sup)

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nPHASE 4 HARDENING TESTS: {passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
