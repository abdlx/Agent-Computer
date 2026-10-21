/**
 * Client for the ACP Docker Supervisor (see supervisor/src/server.ts),
 * plus a DockerDriver implementation so the lifecycle engine performs
 * all container operations through the supervisor — never Docker itself.
 */
import * as http from "node:http";
import type { DockerDriver } from "./lifecycle.ts";

export interface CreateResult {
  computerId: string;
  container: string;
  volume: string;
  guestToken: string;
  socketPath: string;
  limitsEnforced: boolean;
}

export interface InspectResult {
  running: boolean;
  status: string;
  startedAt: string;
  image: string;
  privileged: boolean;
}

export interface StatsResult {
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  networkRxMb: number;
  networkTxMb: number;
}

export class SupervisorClient {
  private sock: string;
  private secret: string;

  constructor(sock: string, secret: string) {
    this.sock = sock;
    this.secret = secret;
  }

  call<T>(route: string, body: Record<string, unknown>, timeoutMs = 90000): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: this.sock, method: "POST", path: route, timeout: timeoutMs,
          headers: { "content-type": "application/json", "x-supervisor-secret": this.secret } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(text); } catch { /* handled below */ }
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`supervisor ${route} -> ${res.statusCode}: ${parsed.error ?? text.slice(0, 200)}`));
            } else {
              resolve(parsed as T);
            }
          });
        });
      req.on("timeout", () => req.destroy(new Error("supervisor call timed out")));
      req.on("error", reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  ping(): Promise<{ ok: boolean }> { return this.call("/ping", {}); }
  create(body: { computerId: string; displayName: string; cpuMillis: number; memoryMb: number }): Promise<CreateResult> {
    return this.call("/create", body);
  }
  start(computerId: string): Promise<{ ok: boolean }> { return this.call("/start", { computerId }); }
  stop(computerId: string, graceS: number): Promise<{ ok: boolean }> {
    return this.call("/stop", { computerId, graceS }, (graceS + 30) * 1000);
  }
  remove(computerId: string, removeVolume: boolean): Promise<{ ok: boolean }> {
    return this.call("/remove", { computerId, removeVolume });
  }
  inspect(computerId: string): Promise<InspectResult> { return this.call("/inspect", { computerId }); }
  stats(computerId: string): Promise<StatsResult> { return this.call("/stats", { computerId }, 45000); }
}

/** The engine knows containers by name (`acp-<id>`); the supervisor by id. */
export class SupervisorDriver implements DockerDriver {
  private client: SupervisorClient;
  constructor(client: SupervisorClient) { this.client = client; }
  private idOf(container: string): string {
    if (!container.startsWith("acp-")) throw new Error(`not an ACP container name: ${container}`);
    return container.slice(4);
  }
  async isRunning(container: string): Promise<boolean> {
    try {
      return (await this.client.inspect(this.idOf(container))).running;
    } catch {
      return false;
    }
  }
  async start(container: string): Promise<void> { await this.client.start(this.idOf(container)); }
  async stop(container: string, graceS: number): Promise<void> { await this.client.stop(this.idOf(container), graceS); }
}
