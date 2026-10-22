const MCP_URL = "https://agentcomputer.idkwihl.site/mcp";
const TOKEN = "acp_mkNFbFRcWxE0H2jkuMaG7sfsN7OBGaSb";

let reqId = 1;
async function callRpc(method, params = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: reqId++, method, params }),
  });
  return await res.json();
}

async function callTool(name, args = {}) {
  return await callRpc("tools/call", { name, arguments: args });
}

async function main() {
  await callRpc("initialize", { protocolVersion: "2025-03-26" });

  const tools = await callRpc("tools/list");
  const hasCreate = tools.result?.tools?.some(t => t.name === "computer_create");
  console.log("Has computer_create?", hasCreate);
  if (hasCreate) {
    console.log("Trying to create a test computer...");
    const res = await callTool("computer_create", { name: "test-network" });
    console.log("Create result:", JSON.stringify(res, null, 2));
  }
}

main().catch(console.error);
