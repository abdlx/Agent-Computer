#!/usr/bin/env python3
"""Offline, installation-scoped backup/restore. Root Docker access is required.
Archives are validated before services stop; runtime sockets are never backed up.
Restore is transactional with durable rollback copies and an interruption journal.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time

ID = re.compile(r"^[a-z0-9][a-z0-9-]{2,40}$")
NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def docker(*args):
    return run("docker", *args)

def inspect(identity):
    return json.loads(docker("inspect", identity))[0]

def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def safe_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise ValueError("invalid artifact/volume name")
    return value

def validate_members(archive, maximum=100 * 1024**3):
    members = []
    seen, links, expanded = set(), set(), 0
    for member in archive:
        name = member.name
        path = PurePosixPath(name)
        if (not name or "\\" in name or path.is_absolute() or ".." in path.parts
                or any(":" in part for part in path.parts) or not path.parts or path.as_posix() != name or name in seen):
            raise ValueError("unsafe or duplicate archive path")
        members.append(member)
        seen.add(name)
        if not (member.isdir() or member.isfile() or member.issym()):
            raise ValueError("archive contains hardlink, device, socket or special entry")
        if member.issym():
            links.add(path)
        expanded += member.size
        if member.size < 0 or expanded > maximum or len(seen) > 100000:
            raise ValueError("archive expanded size/member limit exceeded")
    for member in members:
        if any(parent in links for parent in PurePosixPath(member.name).parents):
            raise ValueError("archive traverses a symlink")
    return members, expanded

def extract(artifact, destination, maximum=100 * 1024**3):
    """Extract files first, then symlinks. Never follow links while writing."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink() or any(destination.iterdir()):
        raise ValueError("extraction destination must be an empty real directory")
    with tarfile.open(artifact, "r:gz") as archive:
        members, _ = validate_members(archive, maximum)
        for member in sorted(members, key=lambda m: (m.issym(), len(PurePosixPath(m.name).parts))):
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            elif member.isfile():
                with archive.extractfile(member) as source, open(target, "xb") as output:
                    shutil.copyfileobj(source, output)
            else:
                os.symlink(member.linkname, target)
            if hasattr(os, "chown") and os.geteuid() == 0:
                os.chown(target, member.uid, member.gid, follow_symlinks=False)
        # Apply directory modes last, after children have been created.
        for member in sorted(members, key=lambda m: len(PurePosixPath(m.name).parts), reverse=True):
            if not member.issym():
                target = destination.joinpath(*PurePosixPath(member.name).parts)
                os.chmod(target, member.mode & 0o777)
                os.utime(target, (member.mtime, member.mtime))

def pack(source, artifact):
    source = Path(source)
    with tarfile.open(artifact, "w:gz", compresslevel=3) as archive:
        for directory, dirs, files in os.walk(source, followlinks=False):
            for name in sorted(dirs + files):
                path = Path(directory) / name
                if stat.S_ISSOCK(path.lstat().st_mode):
                    continue
                archive.inodes = {}  # Store hardlinked files independently.
                archive.add(path, arcname=path.relative_to(source).as_posix(), recursive=False)
    with tarfile.open(artifact, "r:gz") as archive:
        _, expanded = validate_members(archive)
    return {"file": Path(artifact).name, "sha256": digest(artifact), "bytes": Path(artifact).stat().st_size,
            "expandedBytes": expanded}

def verify(directory):
    directory = Path(directory).resolve(strict=True)
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 2_000_000:
        raise ValueError("invalid manifest")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("version") != 1 or not isinstance(manifest.get("volumes"), list) or not manifest["volumes"]:
        raise ValueError("unsupported backup format")
    seen = set()
    for item in manifest["volumes"]:
        name = safe_name(item["file"])
        safe_name(item["volume"])
        if name in seen or item.get("role") not in ("control-plane", "supervisor", "home"):
            raise ValueError("duplicate/unknown backup entry")
        seen.add(name)
        artifact = directory / name
        if artifact.is_symlink() or not artifact.is_file() or artifact.stat().st_size != item["bytes"] or digest(artifact) != item["sha256"]:
            raise ValueError("backup checksum/size mismatch")
        with tarfile.open(artifact, "r:gz") as archive:
            _, expanded = validate_members(archive, item["expandedBytes"])
        if expanded != item["expandedBytes"]:
            raise ValueError("expanded size mismatch")
    roles = [v["role"] for v in manifest["volumes"]]
    if roles.count("control-plane") != 1 or roles.count("supervisor") != 1:
        raise ValueError("backup must include database and supervisor registry")
    return manifest

def service(name):
    ids = run("docker", "compose", "ps", "-a", "-q", name).splitlines()
    if len(ids) != 1:
        raise ValueError(f"expected one {name} service")
    data = inspect(ids[0])
    if data["Config"]["Labels"].get("com.docker.compose.service") != name:
        raise ValueError("Compose identity mismatch")
    return data

def volume_at(container, destination):
    mounts = [m for m in container["Mounts"] if m["Destination"] == destination and m["Type"] == "volume"]
    if len(mounts) != 1:
        raise ValueError("expected specific named volume")
    name = safe_name(mounts[0]["Name"])
    data = json.loads(docker("volume", "inspect", name))[0]
    root = Path(data["Mountpoint"])
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("unsafe Docker volume mountpoint")
    return name, root

def inventory():
    cp, sup = service("control-plane"), service("supervisor")
    cp_name, cp_root = volume_at(cp, "/data")
    sup_name, sup_root = volume_at(sup, "/data/supervisor")
    registry = json.loads((sup_root / "registry.json").read_text()) if (sup_root / "registry.json").exists() else {}
    volumes = [("control-plane", cp_name, cp_root), ("supervisor", sup_name, sup_root)]
    computers = []
    for identity, entry in registry.items():
        if not ID.fullmatch(identity):
            raise ValueError("invalid registry identity")
        guest = inspect(entry["containerId"])
        if (guest["Name"] != f"/acp-{identity}" or guest["Id"] != entry["containerId"]
                or guest["Config"]["Labels"].get("acp.computer") != identity
                or guest["Config"]["Labels"].get("acp.managed") != "true"):
            raise ValueError("guest ownership mismatch")
        name, root = volume_at(guest, "/home/agent")
        if name != entry["volume"] or str(root) != entry["mountpoint"]:
            raise ValueError("home volume identity mismatch")
        volumes.append(("home", name, root))
        computers.append(guest)
    if len({str(v[2]) for v in volumes}) != len(volumes):
        raise ValueError("duplicate volume targets")
    return cp, sup, volumes, computers

def stop_stack(cp, sup, computers):
    # Stop ingress first, then the supervisor; never enumerate foreign labels.
    for data in (cp, sup, *computers):
        if data["State"]["Running"]:
            docker("stop", "-t", "35", data["Id"])

def resume_services(cp, sup):
    for data in (sup, cp):
        if data["State"]["Running"]:
            docker("start", data["Id"])
    print("Platform services resumed; guests remain asleep and wake through admission control.")

def atomic_json(path, value):
    path = Path(path)
    temp = path.with_suffix(".tmp")
    with open(temp, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(temp, path)

def snapshot(volumes, directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    entries = []
    for role, name, root in volumes:
        entries.append({"role": role, "volume": name, **pack(root, directory / (name + ".tar.gz"))})
    atomic_json(directory / "manifest.json", {"version": 1, "created": time.time(), "volumes": entries})
    verify(directory)

def clear_volume(root):
    # Called only for exact Docker-inspected named volumes after full validation.
    for child in Path(root).iterdir():
        if child.is_symlink() or not child.is_dir():
            child.unlink()
        else:
            shutil.rmtree(child)

def apply(directory, manifest, volumes):
    targets = {name: root for _, name, root in volumes}
    if set(targets) != {entry["volume"] for entry in manifest["volumes"]}:
        raise ValueError("backup installation inventory differs; refusing to modify volumes")
    for entry in manifest["volumes"]:
        root = targets[entry["volume"]]
        clear_volume(root)
        extract(Path(directory) / entry["file"], root, entry["expandedBytes"])

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "verify", "restore", "recover"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "verify":
        verify(args.directory); print("Backup integrity and archive paths verified."); return
    if args.action != "backup" and not args.yes:
        parser.error("restore/recover requires --yes")
    manifest = verify(args.directory) if args.action != "backup" else None
    cp, sup, volumes, computers = inventory()
    journal = Path.cwd() / ".build" / "restore-journal.json"
    if args.action != "recover" and journal.exists():
        raise ValueError("unfinished restore; run recover with its rollback directory")
    if manifest:
        # Validate backups in a staging directory, including recorded exact Docker IDs.
        with tempfile.TemporaryDirectory(prefix="acp-restore-validate-") as temp:
            registry_entry = next(v for v in manifest["volumes"] if v["role"] == "supervisor")
            extract(args.directory / registry_entry["file"], Path(temp) / "registry", registry_entry["expandedBytes"])
            old_registry = json.loads((Path(temp) / "registry" / "registry.json").read_text())
            current = json.loads((next(root for role, _, root in volumes if role == "supervisor") / "registry.json").read_text())
            if old_registry != current:
                raise ValueError("registry differs: offline recreation migration required; no services changed")
        if {v["volume"] for v in manifest["volumes"]} != {name for _, name, _ in volumes}:
            raise ValueError("volume inventory differs; no services changed")
    stop_stack(cp, sup, computers)
    try:
        if args.action == "backup":
            snapshot(volumes, args.directory)
        elif args.action == "recover":
            if not journal.exists() or Path(json.loads(journal.read_text())["rollback"]).resolve() != args.directory.resolve():
                raise ValueError("recovery directory does not match interruption journal")
            apply(args.directory, manifest, volumes)
            journal.unlink()
        else:
            rollback = args.directory.resolve().parent / ("rollback-" + str(time.time_ns()))
            snapshot(volumes, rollback)
            journal.parent.mkdir(exist_ok=True)
            atomic_json(journal, {"rollback": str(rollback), "target": str(args.directory.resolve())})
            try:
                apply(args.directory, manifest, volumes)
            except BaseException:
                apply(rollback, verify(rollback), volumes)
                journal.unlink()
                raise
            journal.unlink()
            print("Rollback checkpoint retained:", rollback)
    finally:
        # Leave ingress stopped if an interrupted restore still needs recovery.
        if not journal.exists():
            resume_services(cp, sup)
    print(args.action, "complete:", args.directory.resolve())

if __name__ == "__main__":
    main()
