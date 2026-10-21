// Tiny API client for the control plane. Same-origin, cookie session;
// mutations carry the CSRF header the API requires.
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-acp-request": "1" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

export const stateColor = (s) =>
  ({ ready: "#3fb950", idle: "#3fb950", sleeping: "#8b949e", stopped: "#8b949e", starting: "#d29922",
     waking: "#d29922", stopping: "#d29922", failed: "#f85149",
     unhealthy: "#f85149", creating: "#d29922" }[s] || "#8b949e");

export function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
