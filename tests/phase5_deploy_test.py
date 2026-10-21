#!/usr/bin/env python3
"""
Phase 5 deployment smoke test: run the stack the way production does —
as containers from the built platform image — and verify it works.

- The supervisor container (with the host Docker socket mounted)
  creates, starts, inspects and removes a real guest computer, driven
  over its unix socket in the shared run volume.
- The control-plane container boots from the same image, serves its
  health endpoint and dashboard, and initializes a v2 database in its
  data volume. On hosts with container networking, the full API flow
  runs against it; in this sandbox (loopback-only containers) the TCP
  leg may be unreachable — that is recorded with its evidence rather
  than silently passing, and the API itself is covered by Phase 1–4.

Requires images: agentcomputer/platform:0.1.0, agentcomputer/guest:phase0.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from phase1_api_test import curl  # noqa: E402

from test_environment import configure
configure()

VOLROOT = subprocess.check_output(["docker", "info", "--format", "{{.DockerRootDir}}"], text=True).strip() + "/volumes"
RUN_VOL = "acp5-run"
DATA_VOL = "acp5-data"
SUP_DATA_VOL = "acp5-supervisor-data"
SECRET = "deploy-test-secret"
SUP_SOCK = f"{VOLROOT}/{RUN_VOL}/_data/supervisor.sock"
PORT = 18795
BASE = f"http://127.0.0.1:{PORT}"

RESULTS = []


def record(name, ok, evidence=""):
    RESULTS.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} — {str(evidence)[:170]}", flush=True)


def docker(*args, check=True):
    r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=180)
    if check and r.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args)}: {r.stderr[:300]}")
    return r.stdout.strip()


def sup_call(route, body):
    import http.client
    import socket as sk

    class UConn(http.client.HTTPConnection):
        def connect(self):
            self.sock = sk.socket(sk.AF_UNIX, sk.SOCK_STREAM)
            self.sock.connect(SUP_SOCK)

    c = UConn("localhost", timeout=120)
    c.request("POST", route, body=json.dumps(body),
              headers={"content-type": "application/json", "x-supervisor-secret": SECRET})
    r = c.getresponse()
    return r.status, json.loads(r.read() or b"{}")


def main():
    for v in (RUN_VOL, DATA_VOL, SUP_DATA_VOL):
        docker("volume", "create", v)
    docker("rm", "-f", "acp5-sup", check=False)
    docker("rm", "-f", "acp5-cp", check=False)
    guest_id = None
    try:
        docker("run", "-d", "--name", "acp5-sup",
               "-e", f"ACP_SUPERVISOR_SECRET={SECRET}",
               "-e", "ACP_GUEST_NETWORK=none",
               "-e", "ACP_MIN_FREE_DISK_GB=1",
               "-e", f"ACP_RUNTIME_VOLUME={RUN_VOL}",
               "-e", "ACP_STORAGE_PROBE=/docker-storage",
               "-v", "/run/docker.sock:/var/run/docker.sock",
               "-v", f"{RUN_VOL}:/run/acp",
               "-v", f"{SUP_DATA_VOL}:/data/supervisor",
               "-v", f"{VOLROOT.rsplit('/', 1)[0]}/acp-capacity-probe:/docker-storage:ro",
               "agentcomputer/platform:0.1.0", "node", "supervisor/src/server.ts")
        deadline = time.time() + 30
        while not os.path.exists(SUP_SOCK) and time.time() < deadline:
            time.sleep(0.5)
        record("containerized supervisor is up (socket in shared volume)",
               os.path.exists(SUP_SOCK), docker("logs", "acp5-sup")[:120])

        st, ping = sup_call("/ping", {})
        record("supervisor /ping over the shared socket", st == 200 and ping.get("ok") is True, ping)

        st, created = sup_call("/create", {"computerId": "deploybox1", "displayName": "Deploy Box",
                                           "cpuMillis": 1000, "memoryMb": 1024})
        guest_id = "deploybox1"
        record("containerized supervisor creates a real guest",
               st == 200 and created.get("container") == "acp-deploybox1", created)
        st, _ = sup_call("/start", {"computerId": guest_id})
        record("guest starts", st == 200, st)
        st, insp = sup_call("/inspect", {"computerId": guest_id})
        record("guest inspect shows it running",
               st == 200 and insp.get("running") is True, insp.get("status"))
        # the guest's own supervisor answers through the volume socket
        gsock = created.get("socketPath", "").replace("/run/acp/", f"{VOLROOT}/{RUN_VOL}/_data/", 1)
        ok = False
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                h = curl("GET", "http://localhost/health", sock=gsock, jar=False)
                if h.get("ok") is True:
                    ok = True
                    break
            except Exception:
                pass
            time.sleep(2)
        record("guest supervisor healthy (full containerized path)", ok, gsock)
        st, _ = sup_call("/stop", {"computerId": guest_id})
        record("guest stops", st == 200, st)
        st, _ = sup_call("/remove", {"computerId": guest_id, "removeVolume": True})
        record("guest removed", st == 200, st)
        guest_id = None

        # ---- control-plane container -----------------------------------
        docker("run", "-d", "--name", "acp5-cp",
               "-e", f"ACP_SUPERVISOR_SECRET={SECRET}",
               "-e", "ACP_IDLE_TIMEOUT_S=3600",
               "-p", f"127.0.0.1:{PORT}:8787",
               "-v", f"{RUN_VOL}:/run/acp:ro",
               "-v", f"{DATA_VOL}:/data",
               "agentcomputer/platform:0.1.0", "node", "control-plane/src/server.ts")
        time.sleep(3)
        logs = docker("logs", "acp5-cp")
        record("containerized control plane boots and listens",
               "listening on :8787" in logs, logs.strip().splitlines()[-1] if logs else "no logs")
        import sqlite3
        dbfile = f"{VOLROOT}/{DATA_VOL}/_data/control-plane.db"
        v = sqlite3.connect(dbfile).execute("SELECT v FROM schema_version").fetchone()[0]
        record("control plane initialized a v3 database in its data volume", v == 3, v)

        reachable = False
        try:
            h = curl("GET", f"{BASE}/api/health", jar=False)
            reachable = h.get("ok") is True
        except Exception:
            reachable = False
        if reachable:
            record("containerized CP serves the API over published port", True, BASE)
            code = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", f"{BASE}/"],
                capture_output=True, text=True).stdout
            record("containerized CP serves the dashboard", code == "200", code)
        else:
            record("containerized CP serves the API over published port",
                   False, "TCP unreachable from this sandbox (loopback-only containers); "
                          "API behavior is covered by Phases 1–4 against the same code")
    finally:
        if guest_id:
            sup_call("/remove", {"computerId": guest_id, "removeVolume": True})
        docker("rm", "-f", "acp5-sup", check=False)
        docker("rm", "-f", "acp5-cp", check=False)
        docker("volume", "rm", "-f", RUN_VOL, check=False)
        docker("volume", "rm", "-f", DATA_VOL, check=False)
        docker("volume", "rm", "-f", SUP_DATA_VOL, check=False)
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nPHASE 5 DEPLOYMENT TESTS: {passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
