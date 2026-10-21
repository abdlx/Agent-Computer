/**
 * Phase 2 validation client — uses the OFFICIAL MCP TypeScript SDK
 * (Streamable HTTP transport) against the ACP gateway, the same way a
 * real agent (Hermes etc.) would connect.
 *
 * Env: ACP_MCP_URL, ACP_TOKEN, ACP_SCENARIO (full|readonly|bound)
 * Prints one JSON line per step: {"step": ..., "ok": bool, "data": ...}
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.ACP_MCP_URL);
const token = process.env.ACP_TOKEN;
const scenario = process.env.ACP_SCENARIO ?? "full";

const out = (step, ok, data) => console.log(JSON.stringify({ step, ok, data }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const PAGE = `<!DOCTYPE html><html><head><title>MCP Test Page</title></head><body>
<h1>MCP Test Page</h1>
<label>Code word <input id="w" type="text" aria-label="Code word"></label>
<button id="b" onclick="document.getElementById('out').textContent='revealed:'+document.getElementById('w').value">Reveal</button>
<p id="out">hidden</p>
</body></html>`;

async function main() {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "acp-phase2-test", version: "1.0.0" });
  await client.connect(transport);
  out("connect", true, { server: client.getServerVersion() });

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  out("tools_list", names.length > 0, { count: names.length, names });

  const call = async (name, args = {}) => client.callTool({ name, arguments: args });

  if (scenario === "readonly") {
    const r1 = await call("computer_list");
    out("ro_computer_list", !r1.isError, textOf(r1).slice(0, 200));
    const r2 = await call("keyboard_type", { text: "nope" });
    out("ro_keyboard_type_blocked", r2.isError === true, textOf(r2).slice(0, 200));
    const r3 = await call("screenshot");
    const img = (r3.content ?? []).find((c) => c.type === "image");
    out("ro_screenshot", !!img && img.data.length > 1000, { bytes: img ? img.data.length : 0 });
    await client.close();
    return;
  }

  if (scenario === "bound") {
    const r1 = await call("computer_status", { computer: "some-other-box" });
    out("bound_other_blocked", r1.isError === true, textOf(r1).slice(0, 200));
    const r2 = await call("computer_status", {});
    out("bound_own_ok", !r2.isError, textOf(r2).slice(0, 120));
    await client.close();
    return;
  }

  // ---- full scenario -----------------------------------------------------
  let r = await call("computer_list");
  out("computer_list", !r.isError && textOf(r).includes("ready"), textOf(r).slice(0, 200));

  r = await call("fs_write", { path: "page.html", content: PAGE });
  out("fs_write", !r.isError, textOf(r).slice(0, 120));

  r = await call("terminal_exec", {
    command: "nohup python3 -m http.server 8123 --directory /home/agent >/tmp/http.log 2>&1 & sleep 1; curl -s http://127.0.0.1:8123/page.html | head -c 80",
    timeout_s: 20,
  });
  out("terminal_exec_serves_page", !r.isError && textOf(r).includes("MCP Test Page"), textOf(r).slice(0, 240));

  r = await call("browser_start");
  out("browser_start", !r.isError, textOf(r).slice(0, 120));

  r = await call("browser_navigate", { url: "http://127.0.0.1:8123/page.html" });
  out("browser_navigate", !r.isError && textOf(r).includes("MCP Test Page"), textOf(r).slice(0, 160));

  r = await call("browser_snapshot");
  const snapText = textOf(r);
  let snap;
  try { snap = JSON.parse(snapText); } catch { snap = { elements: [] }; }
  const input = (snap.elements ?? []).find((e) => e.name === "Code word");
  const button = (snap.elements ?? []).find((e) => e.name === "Reveal");
  out("browser_snapshot_refs", !!input && !!button, { input: input?.ref, button: button?.ref });

  r = await call("browser_fill", { ref: input.ref, text: "s3cret" });
  out("browser_fill", !r.isError, textOf(r).slice(0, 80));
  r = await call("browser_click", { ref: button.ref });
  out("browser_click", !r.isError, textOf(r).slice(0, 80));
  r = await call("browser_content");
  out("browser_reveal", !r.isError && textOf(r).includes("revealed:s3cret"), textOf(r).slice(0, 160));

  r = await call("screenshot");
  const img = (r.content ?? []).find((c) => c.type === "image");
  out("screenshot_image", !!img && img.data.length > 5000, { base64chars: img ? img.data.length : 0 });

  r = await call("mouse_move", { x: 432, y: 345, mode: "natural" });
  out("mouse_move", !r.isError, textOf(r).slice(0, 80));
  r = await call("cursor_get");
  out("cursor_at_target", !r.isError && textOf(r).includes('"x": 432') && textOf(r).includes('"y": 345'), textOf(r).slice(0, 80));

  // batch: launch terminal, focus it, type a command, verify via fs_read
  r = await call("app_launch", { app: "terminal" });
  out("app_launch", !r.isError, textOf(r).slice(0, 80));
  await sleep(2000);
  r = await call("windows_list");
  let wins;
  try { wins = JSON.parse(textOf(r)).windows; } catch { wins = []; }
  const xterm = wins.find((w) => w.title === "xterm");
  out("windows_list_xterm", !!xterm, { id: xterm?.id });
  r = await call("batch", {
    steps: [
      { tool: "window_focus", args: { id: xterm.id } },
      { tool: "keyboard_type", args: { text: "echo BATCHED-OK > /home/agent/batch.txt" } },
      { tool: "keyboard_key", args: { keys: ["Return"] } },
    ],
  });
  out("batch_ran", !r.isError, textOf(r).slice(0, 200));
  await sleep(1500);
  r = await call("fs_read", { path: "batch.txt" });
  out("batch_effect_visible", !r.isError && textOf(r).includes("BATCHED-OK"), textOf(r).slice(0, 160));

  r = await call("fs_list", { path: "." });
  out("fs_list", !r.isError && textOf(r).includes("page.html"), textOf(r).slice(0, 200));

  r = await call("fs_write", { path: "to-delete.txt", content: "x" });
  await call("fs_delete", { path: "to-delete.txt" });
  r = await call("fs_read", { path: "to-delete.txt" });
  out("fs_delete", r.isError === true, textOf(r).slice(0, 120));

  await client.close();
}

main().catch((e) => {
  out("fatal", false, String(e && e.message ? e.message : e));
  process.exit(1);
});
