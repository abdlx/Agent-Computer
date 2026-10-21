#!/usr/bin/env python3
"""Real Compose smoke tests on the designated development host only."""
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.error
import urllib.request

BASE = os.environ.get("ACP_TEST_BASE", "http://127.0.0.1:8787")
STATE = Path(".build/production-test-credentials.json")
EVIDENCE = Path("tests/evidence/production-linux/compose-e2e.json")
jar = http.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
checks = []


def request(path, method="GET", body=None, token=None):
    headers = {"content-type": "application/json", "x-acp-request": "1"}
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with client.open(req, timeout=180) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def check(name, ok, detail=None):
    checks.append({"name": name, "pass": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (" " + str(detail)[:240] if detail is not None else ""), flush=True)
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps({"checks": checks}, indent=2))
    if not ok:
        raise AssertionError(name)


def api(path, method="GET", body=None):
    status, value = request(path, method, body)
    if status >= 400:
        raise RuntimeError(f"{method} {path}: {status} {value.get('error')}")
    return value


def guest(cid, path, body=None):
    return api(f"/api/computers/{cid}/guest/{path}", "POST" if body is not None else "GET", body)


def execute(cid, command, timeout=30):
    return guest(cid, "exec", {"command": command, "timeout_s": timeout})


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def tool(token, name, args=None):
    status, result = request("/mcp", "POST", {"jsonrpc": "2.0", "id": 1,
        "method": "tools/call", "params": {"name": name, "arguments": args or {}}}, token)
    return status, result.get("result", {})


def main():
    os.umask(0o077)
    docker("image", "inspect", "agentcomputer/guest:phase0")
    STATE.parent.mkdir(exist_ok=True)
    credentials = json.loads(STATE.read_text()) if STATE.exists() else {
        "username": "validation-owner", "password": secrets.token_urlsafe(24)}
    needs_setup = api("/api/setup/status")["needsSetup"]
    api("/api/setup" if needs_setup else "/api/auth/login", "POST",
        {key: credentials[key] for key in ("username", "password")})
    STATE.write_text(json.dumps(credentials))
    check("Compose owner authentication", api("/api/auth/me")["username"] == credentials["username"])
    check("resource readiness", api("/api/ready")["ready"])
    resources = api("/api/resources")
    check("real host capacity", resources["capacity"]["totalMemoryMb"] > 7000, resources["capacity"])
    existing = api("/api/computers")["computers"]
    computer = next((c for c in existing if c["name"] == "Production validation"), None)
    start = time.monotonic()
    if not computer:
        computer = api("/api/computers", "POST", {
            "name": "Production validation", "cpuMillis": 1000, "memoryMb": 1536})["computer"]
    else:
        computer = api(f"/api/computers/{computer['id']}/wake", "POST", {})["computer"]
    cid = computer["id"]
    credentials["computer"] = cid
    STATE.write_text(json.dumps(credentials))
    check("real guest ready", computer["state"] == "ready", {
        "coldOrWakeSeconds": round(time.monotonic() - start, 3), "id": cid})
    inspection = json.loads(docker("inspect", "acp-" + cid))[0]
    limits = inspection["HostConfig"]
    check("Docker limits and isolation", limits["Memory"] == 1536 * 1048576
        and limits["NanoCpus"] == 1000000000 and limits["PidsLimit"] == 512
        and not limits["Privileged"] and not limits.get("PortBindings"),
        {key: limits[key] for key in ["Memory", "NanoCpus", "MemorySwap", "PidsLimit", "NetworkMode", "CapDrop"]})
    cgroups = execute(cid, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max")
    check("actual cgroup v2 limits", "1610612736" in cgroups["stdout"]
        and "100000 100000" in cgroups["stdout"] and "512" in cgroups["stdout"], cgroups["stdout"])
    proxy = execute(cid, "curl -sS -I --max-time 20 https://example.com", 25)
    check("public HTTPS through constrained proxy", proxy["code"] == 0 and "200" in proxy["stdout"], proxy)
    direct = execute(cid, "curl --noproxy '*' -sS -I --max-time 3 https://example.com", 5)
    check("direct internet blocked", direct["code"] != 0)
    denied = execute(cid, "curl --noproxy '' -x http://acp-egress:3128 -s --max-time 8 -o /dev/null -w '%{http_code}' http://127.0.0.1/", 10)
    check("proxy loopback destination rejected", denied["stdout"] == "403", denied["stdout"])
    token = api("/api/tokens", "POST", {"name": "production-test", "scopes": ["admin"], "computerId": cid})
    credentials["token"] = token["token"]
    STATE.write_text(json.dumps(credentials))
    install = subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd="tests/mcp-client",
        capture_output=True, text=True, timeout=180)
    check("official MCP client dependencies", install.returncode == 0, install.stderr[-200:])
    sdk = subprocess.run(["node", "tests/mcp-client/client.mjs"], env={**os.environ,
        "ACP_MCP_URL": BASE + "/mcp", "ACP_TOKEN": token["token"], "ACP_SCENARIO": "full"},
        capture_output=True, text=True, timeout=600)
    steps = [json.loads(line) for line in sdk.stdout.splitlines() if line.startswith("{")]
    Path("tests/evidence/production-linux/sdk-task.log").write_text(sdk.stdout + sdk.stderr)
    check("official external MCP task", sdk.returncode == 0 and bool(steps) and all(s.get("ok") for s in steps),
        {"steps": len(steps), "failed": [s["step"] for s in steps if not s.get("ok")]})
    guest(cid, "fs/write", {"path": "recovery-marker.txt", "content": "before-backup"})
    for action in ["sleep", "wake"]:
        start = time.monotonic()
        state = api(f"/api/computers/{cid}/{action}", "POST", {})["computer"]["state"]
        check("real " + action, state == ("sleeping" if action == "sleep" else "ready"),
            {"seconds": round(time.monotonic() - start, 3)})
    check("home persisted", guest(cid, "fs/read", {"path": "recovery-marker.txt"})["content"] == "before-backup")
    backup = ".build/production-roundtrip-backup"
    if not Path(backup).exists():
        subprocess.run(["python3", "ops/recovery.py", "backup", backup], check=True, timeout=300)
    time.sleep(2)
    guest(cid, "fs/write", {"path": "recovery-marker.txt", "content": "after-backup"})
    post = api("/api/tokens", "POST", {"name": "after-backup", "scopes": ["read"]})
    subprocess.run(["python3", "ops/recovery.py", "restore", backup, "--yes"], check=True, timeout=300)
    time.sleep(2)
    check("real registry/database/home restore", guest(cid, "fs/read", {"path": "recovery-marker.txt"})["content"] == "before-backup")
    status, _ = tool(post["token"], "computer_list")
    check("post-backup credential removed on restore", status == 401)
    api(f"/api/tokens/{token['id']}", "DELETE", {})
    status, _ = tool(token["token"], "computer_list")
    check("MCP revocation", status == 401)
    api(f"/api/computers/{cid}/stop", "POST", {})
    status, _ = request(f"/api/computers/{cid}/guest/health")
    check("manual stop prevents automatic wake", status >= 400)
    check("stopped processes released", json.loads(docker("inspect", "acp-" + cid))[0]["State"]["Pid"] == 0)
    print("Real Compose integration completed.")


if __name__ == "__main__":
    main()
