#!/usr/bin/env python3
"""
Phase 2 MCP gateway test: spawns supervisor + control plane, creates a
computer and scoped tokens through the owner API, then drives the MCP
gateway with the OFFICIAL MCP TypeScript SDK client
(tests/mcp-client/client.mjs) through full / readonly / bound scenarios,
plus auth negatives and wake-on-MCP-call.
"""
import json
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from phase1_api_test import curl, curl_status, wait_port, REPO  # noqa: E402

from test_environment import configure
configure()

TMP = "/tmp/acp-test2"
PORT = 18788
BASE = f"http://127.0.0.1:{PORT}"
SOCK = f"{TMP}/supervisor.sock"
SECRET = "test-secret-456"
JAR = f"{TMP}/cookies.txt"
CLIENT = ["node", f"{REPO}/tests/mcp-client/client.mjs"]

RESULTS = []


def record(name, ok, evidence=""):
    RESULTS.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} — {str(evidence)[:150]}", flush=True)


def run_client(scenario, token):
    env = dict(os.environ)
    env.update({"ACP_MCP_URL": f"{BASE}/mcp", "ACP_TOKEN": token, "ACP_SCENARIO": scenario})
    r = subprocess.run(CLIENT, capture_output=True, text=True, env=env, timeout=600)
    steps = {}
    for line in r.stdout.strip().splitlines():
        try:
            d = json.loads(line)
            steps[d["step"]] = d
        except Exception:
            pass
    if r.returncode != 0 and not steps:
        raise RuntimeError(f"client failed: {r.stdout} {r.stderr}")
    return steps


def main():
    subprocess.run(["rm", "-rf", TMP], check=False)
    os.makedirs(TMP, exist_ok=True)
    # reuse the phase1 helpers but with this test's jar/ports
    import phase1_api_test as p1
    p1.JAR = JAR
    globals()["JAR"] = JAR

    env = dict(os.environ)
    sup = subprocess.Popen(
        ["node", "supervisor/src/server.ts"], cwd=REPO,
        env={**env, "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET},
        stdout=open(f"{TMP}/supervisor.log", "w"), stderr=subprocess.STDOUT)
    cp = subprocess.Popen(
        ["node", "apps/control-plane/src/server.ts"], cwd=REPO,
        env={**env, "ACP_PORT": str(PORT), "ACP_DB": f"{TMP}/cp.db",
             "ACP_SUPERVISOR_SOCK": SOCK, "ACP_SUPERVISOR_SECRET": SECRET,
             "ACP_IDLE_TIMEOUT_S": "3600"},
        stdout=open(f"{TMP}/control-plane.log", "w"), stderr=subprocess.STDOUT)
    cid = None
    try:
        assert wait_port(f"{BASE}/api/health"), "control plane did not start"
        # owner + computer + tokens via the API (jar-based helpers point at
        # phase1's BASE; call this test's BASE explicitly)
        def api(method, path, body=None, headers=None):
            h = ["x-acp-request: 1"] if method != "GET" else []
            return curl(method, f"{BASE}{path}", body, jar=True, headers=(headers or []) + h)

        def api_status(method, path, body=None):
            return curl_status(method, f"{BASE}{path}", body, jar=True,
                               headers=["x-acp-request: 1"] if method != "GET" else [])

        api("POST", "/api/setup", {"username": "owner", "password": "correct horse battery"})
        r = api("POST", "/api/computers", {"name": "MCP Box", "cpuMillis": 1000, "memoryMb": 1024})
        cid = r.get("computer", {}).get("id")
        record("setup: computer ready", r.get("computer", {}).get("state") == "ready", r.get("computer"))

        full = api("POST", "/api/tokens",
                   {"name": "full", "scopes": ["read", "write", "browser", "files"]})
        ro = api("POST", "/api/tokens", {"name": "ro", "scopes": ["read"]})
        bound = api("POST", "/api/tokens",
                    {"name": "bound", "scopes": ["read"], "computerId": cid})
        record("setup: tokens minted", all(t.get("token", "").startswith("acp_") for t in (full, ro, bound)),
               [t.get("id") for t in (full, ro, bound)])

        # no token -> 401
        code = curl_status("POST", f"{BASE}/mcp",
                           {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                       "clientInfo": {"name": "raw", "version": "0"}}},
                           jar=False)
        record("MCP without token -> 401", code == 401, code)
        code = curl_status("POST", f"{BASE}/mcp",
                           {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                       "clientInfo": {"name": "raw", "version": "0"}}},
                           jar=False, headers=["Authorization: Bearer acp_bogus"])
        record("MCP with bogus token -> 401", code == 401, code)

        # FULL scenario with the official SDK client
        steps = run_client("full", full["token"])
        for step, label in [
            ("connect", "SDK client connects (official @modelcontextprotocol/sdk)"),
            ("browser_reveal", "agent loop: fs_write -> serve -> browse -> fill -> click -> revealed"),
            ("screenshot_image", "screenshot returns an image content block"),
            ("cursor_at_target", "mouse_move lands the real cursor on target"),
            ("batch_effect_visible", "batch (focus+type+key) has a real effect"),
            ("fs_delete", "fs_delete removes the file"),
        ]:
            record(f"full: {label}", steps.get(step, {}).get("ok") is True,
                   steps.get(step, {}).get("data"))
        names = steps.get("tools_list", {}).get("data", {}).get("names", [])
        record("full: tool catalog >= 30 tools incl. batch/browser/fs/terminal",
               len(names) >= 30 and {"batch", "browser_snapshot", "fs_write", "terminal_exec",
                                     "computer_sleep", "mouse_drag"} <= set(names),
               f"{len(names)} tools")

        # READONLY scenario
        steps = run_client("readonly", ro["token"])
        record("readonly: computer_list allowed", steps.get("ro_computer_list", {}).get("ok") is True,
               steps.get("ro_computer_list", {}).get("data"))
        record("readonly: keyboard_type blocked by scope",
               steps.get("ro_keyboard_type_blocked", {}).get("ok") is True,
               steps.get("ro_keyboard_type_blocked", {}).get("data"))
        record("readonly: screenshot allowed", steps.get("ro_screenshot", {}).get("ok") is True,
               steps.get("ro_screenshot", {}).get("data"))
        ro_names = steps.get("tools_list", {}).get("data", {}).get("names", [])
        record("readonly: tools/list hides out-of-scope tools",
               "keyboard_type" not in ro_names and "fs_write" not in ro_names
               and "computer_list" in ro_names and "screenshot" in ro_names,
               ro_names)

        # BOUND scenario
        steps = run_client("bound", bound["token"])
        record("bound: other computer refused", steps.get("bound_other_blocked", {}).get("ok") is True,
               steps.get("bound_other_blocked", {}).get("data"))
        record("bound: own computer works", steps.get("bound_own_ok", {}).get("ok") is True,
               steps.get("bound_own_ok", {}).get("data"))

        # wake-on-MCP-call: sleep via API, then a readonly screenshot must wake it
        r = api("POST", f"/api/computers/{cid}/sleep", {})
        record("sleep before wake test", r.get("computer", {}).get("state") == "sleeping", r.get("computer"))
        steps = run_client("readonly", ro["token"])
        lst = api("GET", "/api/computers")
        record("MCP call wakes the computer",
               steps.get("ro_screenshot", {}).get("ok") is True
               and lst["computers"][0]["state"] == "ready",
               f"screenshot ok={steps.get('ro_screenshot', {}).get('ok')}, state={lst['computers'][0]['state']}")

        # revoked token -> 401
        api_status("DELETE", f"/api/tokens/{ro['id']}")
        code = curl_status("POST", f"{BASE}/mcp",
                           {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                           jar=False, headers=[f"Authorization: Bearer {ro['token']}"])
        record("revoked token -> 401", code == 401, code)

        # audit contains the MCP calls
        a = api("GET", "/api/audit")
        mcp_actions = [e["action"] for e in a.get("entries", []) if e["action"].startswith("mcp.call.")]
        record("audit logs MCP tool calls", len(mcp_actions) >= 10, mcp_actions[:5])
    finally:
        for p in (cp, sup):
            p.send_signal(signal.SIGTERM)
        if cid:
            subprocess.run(["docker", "rm", "-f", f"acp-{cid}"], capture_output=True)
            subprocess.run(["docker", "volume", "rm", "-f", f"acp-{cid}-home"], capture_output=True)
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nPHASE 2 MCP TESTS: {passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
