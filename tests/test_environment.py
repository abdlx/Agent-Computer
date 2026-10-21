"""Portable, narrowly scoped Linux environment for historical test suites."""
import json
import os
from pathlib import Path
import subprocess
import sys

def configure():
    if os.name != "posix": return
    repo = Path(__file__).resolve().parents[1]
    suite = Path(sys.modules["__main__"].__file__).stem
    runtime = "acp-hardening-tests-run"
    subprocess.run(["docker", "volume", "create", "--label", "acp.test-harness=true", runtime], check=True, stdout=subprocess.DEVNULL)
    mountpoint = json.loads(subprocess.check_output(["docker", "volume", "inspect", runtime]))[0]["Mountpoint"]
    storage = subprocess.check_output(["docker", "info", "--format", "{{.DockerRootDir}}"], text=True).strip()
    registry = repo / ".build" / (suite + "-registry.json")
    registry.parent.mkdir(exist_ok=True)
    os.environ.update(ACP_RUNTIME_VOLUME=runtime, ACP_RUNTIME_DIR=mountpoint,
                      ACP_REGISTRY_FILE=str(registry), ACP_STORAGE_PROBE=storage,
                      ACP_GUEST_NETWORK="none", ACP_TRUST_PROXY="true")
