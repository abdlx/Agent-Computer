# Agent Computer — guest image (Phase 0)
# Debian Slim + TigerVNC Xvnc + Openbox + Camoufox (Chromium fallback) + guest supervisor.
# Persistence contract: ONLY /home/agent is a persistent volume. Everything else is image state.
FROM debian:bookworm-slim

LABEL org.agentcomputer.component="guest" org.agentcomputer.phase="0"
ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    SCREEN_WIDTH=1280 SCREEN_HEIGHT=800 SCREEN_DEPTH=24 \
    HOME=/home/agent \
    LANG=C.UTF-8

# Core desktop + control stack
RUN apt-get update && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server tigervnc-common \
    openbox tint2 xterm pcmanfm dbus-x11 \
    python3 python3-pip python3-xlib python3-pil python3-websockets \
    xdotool wmctrl xclip x11-utils xauth \
    supervisor tini procps psmisc curl ca-certificates locales \
    novnc websockify \
    fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

# Chromium fallback browser (Debian package; used only if Camoufox is unavailable)
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

# Browser runtime is immutable image data, not copied into every home volume.
ARG PLAYWRIGHT_VERSION=1.62.0
ARG CAMOUFOX_VERSION=0.5.8
RUN pip3 install --no-cache-dir --break-system-packages playwright==${PLAYWRIGHT_VERSION} camoufox==${CAMOUFOX_VERSION} \
    && mkdir -p /opt/browser-runtime \
    && HOME=/opt/browser-runtime python3 -m camoufox fetch \
    && chmod -R a+rX /opt/browser-runtime

# Non-root computer user. Home is the persistent volume mountpoint.
RUN useradd -m -s /bin/bash -u 1000 agent \
    && mkdir -p /home/agent/.config/openbox /home/agent/.camoufox-profile /home/agent/Downloads \
    && mkdir -p /home/agent/.cache/camoufox \
    && cp -a /opt/browser-runtime/.cache/camoufox/config.json /opt/browser-runtime/.cache/camoufox/repo_cache.json /opt/browser-runtime/.cache/camoufox/.0.5_FLAG /home/agent/.cache/camoufox/ \
    && ln -s /opt/browser-runtime/.cache/camoufox/browsers /home/agent/.cache/camoufox/browsers \
    && ln -s /opt/browser-runtime/.cache/camoufox/addons /home/agent/.cache/camoufox/addons \
    && chown -R agent:agent /home/agent

COPY config/openbox-autostart /home/agent/.config/openbox/autostart
COPY config/supervisord.conf /etc/supervisor/supervisord.conf
COPY config/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY config/camoufox-browser /usr/local/bin/camoufox-browser
COPY config/camoufox.desktop config/terminal.desktop config/files.desktop /usr/share/applications/
COPY config/tint2rc /etc/xdg/tint2/tint2rc
COPY config/menu.xml /etc/xdg/openbox/menu.xml
COPY supervisor/ /opt/guest-supervisor/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/camoufox-browser \
    && chown -R agent:agent /home/agent /opt/guest-supervisor

# Internal only: 5901 VNC (Xvnc), 6080 noVNC websockify, 8731 guest supervisor API.
# Nothing here is published directly by the platform; the control plane proxies access.
EXPOSE 5901 6080 8731

HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=6 \
  CMD curl -sf http://127.0.0.1:8731/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
