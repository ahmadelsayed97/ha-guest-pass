import type { Config } from "./config.ts";
import type { Registries } from "./resolve.ts";
import { haWebSocketUrl } from "./ws-proxy.ts";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class HAClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => this.onMessage(String(event.data));
    ws.onclose = () => this.failAll(new Error("connection closed"));
    ws.onerror = () => this.failAll(new Error("connection error"));
  }

  static connect(config: Config): Promise<HAClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(haWebSocketUrl(config.haUrl));
      ws.onerror = () => reject(new Error("could not connect to Home Assistant"));
      ws.onclose = () => reject(new Error("Home Assistant closed the connection during auth"));
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as { type?: string };
        if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: config.haToken }));
        else if (msg.type === "auth_ok") resolve(new HAClient(ws));
        else reject(new Error("Home Assistant rejected the token during auth"));
      };
    });
  }

  call(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, ...params }));
    });
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(frame: string): void {
    const msg = JSON.parse(frame) as { id?: number; type?: string; success?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    if (msg.type !== "result" || msg.id === undefined) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.success) pending.resolve(msg.result);
    else pending.reject(new Error(`${msg.error?.code ?? "unknown_error"}: ${msg.error?.message ?? ""}`));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function fetchRegistries(client: HAClient): Promise<Registries> {
  const [areas, devices, entities] = await Promise.all([
    client.call("config/area_registry/list"),
    client.call("config/device_registry/list"),
    client.call("config/entity_registry/list"),
  ]);
  return { areas, devices, entities } as Registries;
}
