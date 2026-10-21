#!/bin/bash
# Finish the guest image after the main apt step completes.
umask 022  # build sessions here run umask 0007; image files must stay world-readable
# Run from ~/workspace/agent-computer. Each network step regenerates the apt
# proxy config from the CURRENT session env (proxy credentials rotate per
# exec session on this VM — a stale config file causes 407s).
set -e
cd ~/workspace/agent-computer
ROOT=.build/guest-rootfs
gen_proxy() {
  P4=$(printenv http_proxy | sed 's/@hatch-egress-proxy:/@198.19.0.1:/')
  printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$P4" "$P4" > $ROOT/etc/apt/apt.conf.d/80proxy
}

echo "== chromium =="
gen_proxy
DEBIAN_FRONTEND=noninteractive chroot $ROOT /bin/bash -c \
  'apt-get update -qq && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*'

echo "== pip: playwright + camoufox =="
# NOTE: proxy must be the literal gateway IP inside the chroot — the hostname
# resolves to a fake-IP there and the egress layer treats it as direct TCP.
PIP_PROXY_HTTP=$(printenv http_proxy | sed 's/@hatch-egress-proxy:/@198.19.0.1:/')
PIP_PROXY_HTTPS=$(printenv https_proxy | sed 's/@hatch-egress-proxy:/@198.19.0.1:/')
chroot $ROOT /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/root http_proxy="$PIP_PROXY_HTTP" https_proxy="$PIP_PROXY_HTTPS" HTTP_PROXY="$PIP_PROXY_HTTP" HTTPS_PROXY="$PIP_PROXY_HTTPS" \
  /bin/bash -c 'pip3 install --no-cache-dir --break-system-packages playwright camoufox' \
  || echo "WARN: pip install failed (chromium fallback only)"
mkdir -p $ROOT/home/agent/.cache
chroot $ROOT /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/home/agent http_proxy="$PIP_PROXY_HTTP" https_proxy="$PIP_PROXY_HTTPS" HTTP_PROXY="$PIP_PROXY_HTTP" HTTPS_PROXY="$PIP_PROXY_HTTPS" \
  /bin/bash -c 'python3 -m camoufox fetch' \
  || echo "WARN: camoufox fetch failed (chromium fallback only)"

echo "== user + files =="
chroot $ROOT /bin/bash -c 'id agent >/dev/null 2>&1 || useradd -m -s /bin/bash -u 1000 agent; mkdir -p /home/agent/.config/openbox /home/agent/.camoufox-profile /home/agent/Downloads'
cp guest/config/openbox-autostart $ROOT/home/agent/.config/openbox/autostart
cp guest/config/supervisord.conf $ROOT/etc/supervisor/supervisord.conf
cp guest/config/entrypoint.sh $ROOT/usr/local/bin/entrypoint.sh
mkdir -p $ROOT/opt/guest-supervisor
cp guest/supervisor/supervisor.py guest/supervisor/trajectory.py guest/supervisor/browser_owner.py $ROOT/opt/guest-supervisor/
chmod +x $ROOT/usr/local/bin/entrypoint.sh
chroot $ROOT /bin/bash -c 'chown -R agent:agent /home/agent /opt/guest-supervisor'

echo "== import check (catches the supervisor import issue pre-boot) =="
chroot $ROOT /usr/bin/env -i PATH=/usr/bin:/bin HOME=/home/agent /bin/bash -c \
  'cd /opt/guest-supervisor && python3 -c "import trajectory, browser_owner; print(\"modules ok\")" && python3 -m py_compile supervisor.py && echo SUPERVISOR_IMPORT_OK' || true

echo "== cleanup (secrets out, runtime files out) =="
rm -f $ROOT/etc/apt/apt.conf.d/80proxy $ROOT/usr/sbin/policy-rc.d
cp /tmp/resolv.conf.orig $ROOT/etc/resolv.conf 2>/dev/null || true
rm -rf $ROOT/root/.cache $ROOT/tmp/* $ROOT/var/tmp/*
umount $ROOT/proc $ROOT/sys $ROOT/dev/pts 2>/dev/null || true
for n in null zero full random urandom tty; do umount $ROOT/dev/$n 2>/dev/null || true; done
umount $ROOT/dev 2>/dev/null || true

echo "== docker import =="
tar -C $ROOT -c . | docker import \
  --change 'LABEL org.agentcomputer.component="guest" org.agentcomputer.phase="0"' \
  --change 'ENV DISPLAY=:0' \
  --change 'ENV SCREEN_WIDTH=1280' \
  --change 'ENV SCREEN_HEIGHT=800' \
  --change 'ENV SCREEN_DEPTH=24' \
  --change 'ENV HOME=/home/agent' \
  --change 'ENV LANG=C.UTF-8' \
  --change 'EXPOSE 5901' \
  --change 'EXPOSE 6080' \
  --change 'EXPOSE 8731' \
  --change 'ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]' \
  - agentcomputer/guest:phase0
docker images agentcomputer/guest:phase0
echo "FINISH_BUILD_OK"
