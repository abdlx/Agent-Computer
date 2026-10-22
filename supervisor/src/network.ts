export async function findEgressProxy(docker: (method: string, path: string, body?: unknown) => Promise<{status: number; data: any}>, proxyName: string) {
  let proxy = await docker("GET", `/containers/${encodeURIComponent(proxyName)}/json`);
  if (proxy.status !== 200) {
    const list = await docker("GET", `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ["com.docker.compose.service=egress"], status: ["running"] }))}`);
    if (list.status === 200 && Array.isArray(list.data) && list.data.length > 0) {
      proxy = await docker("GET", `/containers/${list.data[0].Id}/json`);
    } else {
      const all = await docker("GET", `/containers/json?filters=${encodeURIComponent(JSON.stringify({ status: ["running"] }))}`);
      if (all.status === 200 && Array.isArray(all.data)) {
        const found = all.data.find((c: any) => c.Labels?.["com.docker.compose.service"] === "egress" || c.Names?.some((n: string) => n.includes("egress")));
        if (found) proxy = await docker("GET", `/containers/${found.Id}/json`);
      }
    }
  }

  if (proxy.status !== 200 || !proxy.data?.State?.Running ||
      proxy.data?.Config?.Labels?.["com.docker.compose.service"] !== "egress") {
    throw Object.assign(new Error("trusted egress proxy unavailable"), { code: 503 });
  }
  return proxy.data;
}

export async function attachEgressProxy(docker: (method: string, path: string, body?: unknown) => Promise<{status: number; data: any}>, networkId: string, proxyName = "agentcomputer-egress-1") {
  const proxy = await findEgressProxy(docker, proxyName);
  const net = await docker("GET", `/networks/${networkId}`);
  if (net.status === 200 && !net.data?.Containers?.[proxy.Id]) {
    const attached = await docker("POST", `/networks/${networkId}/connect`,
      { Container: proxy.Id, EndpointConfig: { Aliases: ["acp-egress"] } });
    if (attached.status !== 200) {
      throw Object.assign(new Error("egress proxy connection failed"), { code: 503 });
    }
  }
  return proxy.Id;
}

/** Each guest has its own internal, gateway-isolated bridge and a constrained web proxy. */
export async function createGuestNetwork(id: string, docker: (method: string, path: string, body?: unknown) => Promise<{status: number; data: any}>, proxyName: string) {
  const name = `acp-${id}-net`;
  const old = await docker("GET", `/networks/${name}`);
  if (old.status !== 404) throw Object.assign(new Error("network name unavailable"), { code: 409 });

  const proxy = await findEgressProxy(docker, proxyName);
  const network = await docker("POST", "/networks/create", { Name: name, Driver: "bridge", Internal: true,
    EnableIPv6: false, CheckDuplicate: true,
    Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
    Labels: { "acp.managed": "true", "acp.computer": id } });
  if (network.status !== 201 || !network.data.Id) throw Object.assign(new Error("isolated guest network creation failed; Docker 28+ required"), { code: 503 });
  const attached = await docker("POST", `/networks/${network.data.Id}/connect`,
    { Container: proxy.Id, EndpointConfig: { Aliases: ["acp-egress"] } });
  if (attached.status !== 200) {
    await docker("DELETE", `/networks/${network.data.Id}`);
    throw Object.assign(new Error("egress proxy connection failed"), { code: 503 });
  }
  return { id: network.data.Id, name, proxyId: proxy.Id };
}
