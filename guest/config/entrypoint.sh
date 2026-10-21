#!/bin/bash
# Guest entrypoint: start supervised services, wait for readiness, stay as PID 1 child of tini.
set -u
export DISPLAY=:0
export HOME=/home/agent

# Migrate only the exact legacy immutable-cache link created by this project.
# Browser/fontconfig metadata stays writable; large binaries and addons stay in the image.
CACHE=/home/agent/.cache/camoufox
if [ -L "$CACHE" ] && [ "$(readlink "$CACHE")" = /opt/browser-runtime/.cache/camoufox ]; then
  unlink "$CACHE"
  mkdir -p "$CACHE"
  cp -a /opt/browser-runtime/.cache/camoufox/config.json /opt/browser-runtime/.cache/camoufox/repo_cache.json /opt/browser-runtime/.cache/camoufox/.0.5_FLAG "$CACHE/"
  ln -s /opt/browser-runtime/.cache/camoufox/browsers "$CACHE/browsers"
  ln -s /opt/browser-runtime/.cache/camoufox/addons "$CACHE/addons"
  chown -hR agent:agent "$CACHE"
fi

# Runtime dirs
mkdir -p /tmp/.X11-unix /run/user/1000 /home/agent/.vnc
chmod 1777 /tmp/.X11-unix
chown agent:agent /run/user/1000 /home/agent/.vnc 2>/dev/null || true
export XDG_RUNTIME_DIR=/run/user/1000

# VNC password: generated once into the persistent home, never printed.
if [ ! -f /home/agent/.vnc/passwd ]; then
  PW="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"
  echo "$PW" | vncpasswd -f > /home/agent/.vnc/passwd 2>/dev/null || true
  chmod 600 /home/agent/.vnc/passwd
  chown agent:agent /home/agent/.vnc/passwd
fi

# Graceful shutdown: supervisord propagates TERM to children (Xvnc, supervisor, browser owner).
trap 'kill -TERM "$SUP_PID" 2>/dev/null; wait "$SUP_PID"; exit 0' TERM INT

# --nodaemon: supervisord must stay a direct child, or `wait` returns as soon
# as the daemonizing parent exits and the container stops.
/usr/bin/supervisord --nodaemon -c /etc/supervisor/supervisord.conf &
SUP_PID=$!

# Readiness: X display answers + supervisor API healthy.
for i in $(seq 1 60); do
  if xdpyinfo -display :0 >/dev/null 2>&1 && curl -sf http://127.0.0.1:8731/health >/dev/null 2>&1; then
    touch /tmp/guest-ready
    echo "[entrypoint] guest ready after ${i}s"
    break
  fi
  sleep 1
done

wait $SUP_PID
