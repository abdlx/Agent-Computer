import { Client } from "../tests/mcp-client/node_modules/@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "../tests/mcp-client/node_modules/@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL("https://agentcomputer.idkwihl.site/mcp");
const token = "acp_mkNFbFRcWxE0H2jkuMaG7sfsN7OBGaSb";

async function run() {
  console.log("Connecting to", url.href);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "debug-client", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected! Server version:", client.getServerVersion());

  const tools = await client.listTools();
  console.log("Available tools:", tools.tools.map(t => t.name));

  const listRes = await client.callTool({ name: "computer_list", arguments: {} });
  console.log("computer_list:", JSON.stringify(listRes, null, 2));

  // Run terminal command to test networking inside the container!
  if (tools.tools.find(t => t.name === "terminal_exec" || t.name === "bash" || t.name === "exec")) {
    const toolName = tools.tools.find(t => t.name === "terminal_exec" || t.name === "bash" || t.name === "exec").name;
    console.log("Found exec tool:", toolName);
  }

  // Check what tools exist
  for (const t of tools.tools) {
    console.log("Tool:", t.name, JSON.stringify(t.inputSchema));
  }

  await client.close();
}

run().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
