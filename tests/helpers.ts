import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { tokenAuthenticator } from "../src/guest-auth.ts";
import { GuestStore, type Guest } from "../src/guest-store.ts";
import { silentLogger } from "../src/log.ts";
import { createServer } from "../src/server.ts";
import { signGuestToken } from "../src/token.ts";
import { startFakeHA, type FakeHA } from "./fake-ha.ts";

export const ADMIN_SECRET = "admin-secret-0123456789-0123456789-abcdef";
const SIGNING_KEY_HEX = "11".repeat(32);

export const TEST_DEFINITION = {
  dashboards: ["lovelace-guest"],
  areas: {},
  entities: { "light.kitchen": "control" as const, "sensor.temp": "view" as const, "camera.front": "view" as const },
};
export const TEST_SCOPE = {
  dashboards: ["lovelace-guest"],
  entities: { "light.kitchen": "control" as const, "sensor.temp": "view" as const, "camera.front": "view" as const },
};

export interface Harness {
  ha: FakeHA;
  config: Config;
  store: GuestStore;
  guest: Guest;
  token: string;
  proxyUrl: URL;
  wsUrl: string;
  stop(): Promise<void>;
}

export async function startHarness(peerIp = "192.168.1.50", expiresIn = 3600_000): Promise<Harness> {
  const ha = startFakeHA();
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  const config = loadConfig({
    HA_URL: ha.url.toString(),
    HA_TOKEN: ha.token,
    SIGNING_KEY: SIGNING_KEY_HEX,
    ADMIN_SECRET,
    GUEST_STORE_FILE: join(dir, "guests.json"),
    HOST: "127.0.0.1",
  });
  const store = await GuestStore.open(config.guestStoreFile);
  const guest = store.create({ name: "Guest", expiresAt: Date.now() + expiresIn, definition: TEST_DEFINITION, scope: TEST_SCOPE });
  const token = await signGuestToken({ guestId: guest.id, tokenId: guest.tokenId, expiresAt: guest.expiresAt }, config.signingKey);
  const auth = tokenAuthenticator(store, config.signingKey);
  const proxy = createServer(config, { auth, store }, { log: silentLogger, port: 0, requestIP: () => peerIp });
  const proxyUrl = new URL(`http://127.0.0.1:${proxy.port}`);
  return {
    ha,
    config,
    store,
    guest,
    token,
    proxyUrl,
    wsUrl: `ws://127.0.0.1:${proxy.port}/api/websocket`,
    async stop() {
      proxy.stop(true);
      ha.stop();
      await store.flush();
      rmSync(dir, { recursive: true, force: true });
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

export async function authenticatedSocket(h: Harness): Promise<{ ws: WebSocket; rec: ReturnType<typeof recordSocket> }> {
  const ws = new WebSocket(h.wsUrl);
  const rec = recordSocket(ws);
  await opened(ws);
  await rec.next();
  ws.send(JSON.stringify({ type: "auth", access_token: h.token }));
  await rec.next();
  return { ws, rec };
}

export function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
}
