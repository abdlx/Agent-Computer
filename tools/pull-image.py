#!/usr/bin/env python3
"""
Dev-environment image puller (NOT part of the product).

Why this exists: on this development VM, the Docker daemon's own registry
requests stall (TLS handshake timeout through the egress proxy) while
ordinary HTTPS clients (curl/requests) reach Docker Hub fine. This script
pulls an image through the standard Registry HTTP API v2 using requests and
emits a classic `docker load` tar, so Phase 0 work can proceed. On a normal
host, `docker pull` works and this script is unnecessary.

Usage:  python3 tools/pull-image.py debian:bookworm-slim [more images...]
Output: /tmp/images/<name>.tar  (then: docker load -i <file>)
"""
import gzip
import io
import json
import os
import sys
import tarfile

import requests

REG = "https://registry-1.docker.io"
ARCH = os.environ.get("PULL_ARCH", "amd64")
OS = "linux"


def parse(ref):
    if "/" not in ref:
        ref = "library/" + ref
    if ":" in ref.rsplit("/", 1)[-1]:
        repo, tag = ref.rsplit(":", 1)
    else:
        repo, tag = ref, "latest"
    return repo, tag


def token(repo):
    r = requests.get("https://auth.docker.io/token",
                     params={"service": "registry.docker.io",
                             "scope": f"repository:{repo}:pull"}, timeout=30)
    r.raise_for_status()
    return r.json()["token"]


def get_manifest(repo, ref, tok):
    h = {"Authorization": f"Bearer {tok}",
         "Accept": ("application/vnd.oci.image.index.v1+json,"
                    "application/vnd.docker.distribution.manifest.list.v2+json,"
                    "application/vnd.oci.image.manifest.v1+json,"
                    "application/vnd.docker.distribution.manifest.v2+json")}
    r = requests.get(f"{REG}/v2/{repo}/manifests/{ref}", headers=h, timeout=60)
    r.raise_for_status()
    return r.json()


def get_blob(repo, digest, tok):
    r = requests.get(f"{REG}/v2/{repo}/blobs/{digest}",
                     headers={"Authorization": f"Bearer {tok}"},
                     timeout=600, stream=True)
    r.raise_for_status()
    return r.raw.read()


def pull(ref):
    repo, tag = parse(ref)
    tok = token(repo)
    man = get_manifest(repo, tag, tok)
    if man.get("manifests"):  # index / manifest list -> pick platform
        digest = None
        for m in man["manifests"]:
            p = m.get("platform", {})
            if p.get("architecture") == ARCH and p.get("os") == OS:
                digest = m["digest"]
                break
        if not digest:
            raise SystemExit(f"no {OS}/{ARCH} manifest in index for {ref}")
        man = get_manifest(repo, digest, tok)
    config_digest = man["config"]["digest"]
    config = get_blob(repo, config_digest, tok)
    config_name = config_digest.split(":", 1)[1] + ".json"

    layer_names = []
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as tf:
        ti = tarfile.TarInfo(config_name)
        ti.size = len(config)
        tf.addfile(ti, io.BytesIO(config))
        for i, layer in enumerate(man["layers"]):
            blob = get_blob(repo, layer["digest"], tok)
            if blob[:2] == b"\x1f\x8b":
                blob = gzip.decompress(blob)
            name = f"layer{i}.tar"
            ti = tarfile.TarInfo(name)
            ti.size = len(blob)
            tf.addfile(ti, io.BytesIO(blob))
            layer_names.append(name)
            print(f"  layer {i}: {len(blob)/1e6:.1f} MB", flush=True)
        manifest = [{"Config": config_name, "RepoTags": [f"{repo}:{tag}"],
                     "Layers": layer_names}]
        data = json.dumps(manifest).encode()
        ti = tarfile.TarInfo("manifest.json")
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))
    os.makedirs("/tmp/images", exist_ok=True)
    path = f"/tmp/images/{repo.replace('/', '_')}_{tag}.tar"
    with open(path, "wb") as f:
        f.write(out.getvalue())
    print(f"{ref} -> {path} ({os.path.getsize(path)/1e6:.1f} MB)")
    return path


if __name__ == "__main__":
    for ref in sys.argv[1:]:
        pull(ref)
