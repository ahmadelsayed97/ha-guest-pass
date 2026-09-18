import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { createServer } from "../src/server.ts";
import { startFakeHA, type FakeHA } from "./fake-ha.ts";

export const GUEST_SECRET = "guest-secret-0123456789-0123456789-abcdef";

export interface Harness {
  ha: FakeHA;
  config: Config;
  proxyUrl: URL;
  wsUrl: string;
  stop(): void;
}

export function startHarness(peerIp = "192.168.1.50"): Harness {
  const ha = startFakeHA();
  const config = loadConfig({
    HA_URL: ha.url.toString(),
    HA_TOKEN: ha.token,
    GUEST_SECRET,
    HOST: "127.0.0.1",
  });
  const proxy = createServer(config, { log: silentLogger, port: 0, requestIP: () => peerIp });
  const proxyUrl = new URL(`http://127.0.0.1:${proxy.port}`);
  return {
    ha,
    config,
    proxyUrl,
    wsUrl: `ws://127.0.0.1:${proxy.port}/api/websocket`,
    stop() {
      proxy.stop(true);
      ha.stop();
    },
  };
}

export function recordSocket(ws: WebSocket): { frames: string[]; closed: Promise<CloseEvent>; next(): Promise<string> } {
  const frames: string[] = [];
  let cursor = 0;
  const waiters: Array<(f: string) => void> = [];
  ws.onmessage = (e) => {
    const f = String(e.data);
    frames.push(f);
    const waiter = waiters.shift();
    if (waiter) {
      cursor++;
      waiter(f);
    }
  };
  const closed = new Promise<CloseEvent>((resolve) => {
    ws.onclose = (e) => resolve(e);
  });
  return {
    frames,
    closed,
    next: () =>
      new Promise<string>((resolve, reject) => {
        if (cursor < frames.length) {
          resolve(frames[cursor++]!);
          return;
        }
        waiters.push(resolve);
        setTimeout(() => reject(new Error("timed out waiting for frame")), 2000);
      }),
  };
}

export function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
}
