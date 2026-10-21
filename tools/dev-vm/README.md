# Dev-VM workarounds (NOT part of the product)

This development VM is itself a systemd-nspawn container inside a user
namespace (uid_map 0->131072). That imposes constraints a normal host does
not have:

- Kernel has no bridge module -> dockerd runs with --bridge=none. The
  sandbox also blocks setns into existing namespaces, so `docker exec`,
  `--network host`, and `--network container:` joins ALL fail here; guests
  run with loopback-only networking and the guest supervisor is reached over
  a Unix socket in its home volume. Normal hosts use bridge networking and
  the container network as designed.
- dockerd's data-root is /home/hatch/docker-data (the root overlay fs is
  only 7.5G and filled up); on that device-backed mount overlay2 works, so
  it is the storage driver there.
- The chroot build's finishing steps are scripted in finish-build.sh
  (same directory as this README).
- Overlayfs mount fails -> storage driver falls back to vfs (slow, fat).
- The sandbox delegates ZERO cgroup controllers and Docker defaults to the
  systemd cgroup driver -> dockerd runs with cgroupfs + crun; `crun-docker`
  is a wrapper that strips linux.resources controller blocks (which cannot
  be applied here) from the OCI spec before exec'ing real crun. Resource
  limits therefore cannot be enforced on this VM; they are validated by spec
  inspection here and must be re-validated on a normal host.
- The egress proxy stalls Go TLS handshakes, so dockerd cannot pull images;
  `pull-image.py` pulls via the Registry HTTP API with Python requests and
  emits a `docker load` tar.
- `docker build` cannot create its sandbox here (netns setns not permitted),
  so the guest image is built equivalently: base rootfs exported, Dockerfile
  steps executed in a chroot, result imported with `docker import` (script:
  `.build/finish-build.sh`). HEALTHCHECK cannot be set via `docker import
  --change`; the Dockerfile carries it for normal hosts.
- Egress proxy quirks inside the chroot build (all measured 2026-10-21):
  (a) proxy credentials rotate per exec session — regenerate the apt proxy
  config from the CURRENT session env in the SAME call as the apt run, or
  every fetch 407s; (b) the proxy hostname resolves to a fake IP inside the
  chroot — always use the literal gateway IP (198.19.0.1) in proxy URLs, or
  the egress layer classifies the traffic as direct TCP and denies it;
  (c) the proxy MITMs TLS with its own CA — pip needs the host CA bundle
  passed via SSL_CERT_FILE/PIP_CERT/REQUESTS_CA_BUNDLE at build time (the
  bundle is NOT shipped in the image).
- Docker itself is the official static binary tarball (27.5.1) + Compose
  plugin, because the VM's apt mirrors hang through the proxy.

None of these workarounds ship in the product or its deployment path.
