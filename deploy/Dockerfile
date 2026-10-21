# Platform image: control plane + Docker supervisor (same image, two
# commands) with the dashboard built in. Build context is the repo root.
FROM node:24-bookworm-slim AS dashbuild
WORKDIR /build
COPY apps/dashboard/package.json apps/dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/dashboard/ ./
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY apps/control-plane/src ./control-plane/src
COPY supervisor/src ./supervisor/src
COPY --from=dashbuild /build/dist ./dashboard/dist
ENV ACP_DASHBOARD_DIR=/app/dashboard/dist \
    ACP_DB=/data/control-plane.db \
    ACP_PORT=8787 \
    ACP_SUPERVISOR_SOCK=/run/acp/supervisor.sock
# Control plane (compose overrides the command for the supervisor service).
CMD ["node", "control-plane/src/server.ts"]
