/** Each guest has its own internal, gateway-isolated bridge and a constrained web proxy. */
export async function createGuestNetwork(id: string, docker: (method: string, path: string, body?: unknown) => Promise<{status: number; data: any}>, proxyName: string) {
  const name = `acp-${id}-net`;
  const old = await docker("GET", `/networks/${name}`);
  if (old.status !== 404) throw Object.assign(new Error("network name unavailable"), { code: 409 });
  const proxy = await docker("GET", `/containers/${encodeURIComponent(proxyName)}/json`);
  if (proxy.status !== 200 || !proxy.data.State.Running ||
      proxy.data.Config.Labels?.["com.docker.compose.project"] !== "agentcomputer" ||
      proxy.data.Config.Labels?.["com.docker.compose.service"] !== "egress") {
    throw Object.assign(new Error("trusted egress proxy unavailable"), { code: 503 });
  }
  const network = await docker("POST", "/networks/create", { Name: name, Driver: "bridge", Internal: true,
    EnableIPv6: false, CheckDuplicate: true,
    Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
    Labels: { "acp.managed": "true", "acp.computer": id } });
  if (network.status !== 201 || !network.data.Id) throw Object.assign(new Error("isolated guest network creation failed; Docker 28+ required"), { code: 503 });
  const attached = await docker("POST", `/networks/${network.data.Id}/connect`,
    { Container: proxy.data.Id, EndpointConfig: { Aliases: ["acp-egress"] } });
  if (attached.status !== 200) {
    await docker("DELETE", `/networks/${network.data.Id}`);
    throw Object.assign(new Error("egress proxy connection failed"), { code: 503 });
  }
  return { id: network.data.Id, name, proxyId: proxy.data.Id };
}
