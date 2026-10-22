#!/bin/bash
# Guest entrypoint: start supervised services, wait for readiness, stay as PID 1 child of tini.
set -u
export DISPLAY=:0
export HOME=/home/agent

# 1. Unset proxy env vars in container runtime so browsers and tools never inherit broken proxies
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ACP_BROWSER_PROXY 2>/dev/null || true

# 2. Ensure fresh Camoufox profile on every start to prevent corrupt prefs / stale proxy state
rm -rf /home/agent/.camoufox-profile
mkdir -p /home/agent/.camoufox-profile
chown -R agent:agent /home/agent/.camoufox-profile 2>/dev/null || true

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
mkdir -p /tmp/.X11-unix /run/user/1000 /home/agent/.vnc /home/agent/Desktop /home/agent/.config/openbox /home/agent/.config/tint2
chmod 1777 /tmp/.X11-unix
chown agent:agent /run/user/1000 /home/agent/.vnc /home/agent/Desktop /home/agent/.config 2>/dev/null || true
export XDG_RUNTIME_DIR=/run/user/1000

# Seed desktop shortcuts and panel launchers into persistent home
for d in camoufox.desktop terminal.desktop files.desktop; do
  if [ -f "/usr/share/applications/$d" ] && [ ! -f "/home/agent/Desktop/$d" ]; then
    cp "/usr/share/applications/$d" "/home/agent/Desktop/$d"
    chmod +x "/home/agent/Desktop/$d"
  fi
done
if [ -f /etc/xdg/tint2/tint2rc ] && [ ! -f /home/agent/.config/tint2/tint2rc ]; then
  cp /etc/xdg/tint2/tint2rc /home/agent/.config/tint2/tint2rc
fi
if [ -f /etc/xdg/openbox/menu.xml ] && [ ! -f /home/agent/.config/openbox/menu.xml ]; then
  cp /etc/xdg/openbox/menu.xml /home/agent/.config/openbox/menu.xml
fi
chown -R agent:agent /home/agent/Desktop /home/agent/.config 2>/dev/null || true

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
