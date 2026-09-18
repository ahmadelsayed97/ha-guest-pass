import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { opened, recordSocket, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.stop());

async function wsAuth(token: string) {
  const ws = new WebSocket(h.wsUrl);
  const rec = recordSocket(ws);
  await opened(ws);
  const first = JSON.parse(await rec.next());
  expect(first.type).toBe("auth_required");
  ws.send(JSON.stringify({ type: "auth", access_token: token }));
  return { ws, rec };
}

describe("WebSocket bridge", () => {
  test("valid guest auth: proxy authenticates upstream with real token and relays", async () => {
    const { ws, rec } = await wsAuth(h.token);
    const authOk = JSON.parse(await rec.next());
    expect(authOk).toEqual({ type: "auth_ok", ha_version: h.ha.haVersion });

    ws.send(JSON.stringify({ id: 1, type: "ping" }));
    expect(JSON.parse(await rec.next())).toEqual({ id: 1, type: "pong" });

    expect(h.ha.wsConnections).toBe(1);
    expect(h.ha.wsAuthTokens).toEqual([h.ha.token]);
    for (const frame of rec.frames) expect(frame).not.toContain(h.ha.token);
    ws.close();
    await rec.closed;
  });

  test("wrong guest token: auth_invalid, socket closed, upstream never contacted", async () => {
    const { rec } = await wsAuth("wrong-token");
    const reply = JSON.parse(await rec.next());
    expect(reply.type).toBe("auth_invalid");
    await rec.closed;
    expect(h.ha.wsConnections).toBe(0);
    for (const frame of rec.frames) expect(frame).not.toContain(h.ha.token);
  });

  test("token with one signature character changed is rejected", async () => {
    const [header, payload, signature] = h.token.split(".") as [string, string, string];
    const forged = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const { rec } = await wsAuth(forged);
    expect(JSON.parse(await rec.next()).type).toBe("auth_invalid");
    await rec.closed;
    expect(h.ha.wsConnections).toBe(0);
  });

  test("command before auth: closed, upstream never contacted", async () => {
    const ws = new WebSocket(h.wsUrl);
    const rec = recordSocket(ws);
    await opened(ws);
    await rec.next();
    ws.send(JSON.stringify({ id: 1, type: "ping" }));
    const closed = await rec.closed;
    expect(closed.code).toBe(1008);
    expect(h.ha.wsConnections).toBe(0);
  });

  test("auth frame with real HA token is not a valid guest credential", async () => {
    const { rec } = await wsAuth(h.ha.token);
    expect(JSON.parse(await rec.next()).type).toBe("auth_invalid");
    await rec.closed;
    expect(h.ha.wsConnections).toBe(0);
  });

  test("garbage frame before auth closes", async () => {
    const ws = new WebSocket(h.wsUrl);
    const rec = recordSocket(ws);
    await opened(ws);
    await rec.next();
    ws.send("not json");
    expect((await rec.closed).code).toBe(1008);
    expect(h.ha.wsConnections).toBe(0);
  });

  test("binary frame closes", async () => {
    const ws = new WebSocket(h.wsUrl);
    const rec = recordSocket(ws);
    await opened(ws);
    await rec.next();
    ws.send(new Uint8Array([1, 2, 3]));
    expect((await rec.closed).code).toBe(1008);
    expect(h.ha.wsConnections).toBe(0);
  });

  test("second auth frame after authentication closes and is not forwarded", async () => {
    const { ws, rec } = await wsAuth(h.token);
    await rec.next();
    ws.send(JSON.stringify({ type: "auth", access_token: "anything" }));
    expect((await rec.closed).code).toBe(1008);
    expect(h.ha.wsAuthTokens).toEqual([h.ha.token]);
  });

  test("frontend/subscribe_user_data is answered locally with a result and an event", async () => {
    const { ws, rec } = await wsAuth(h.token);
    await rec.next();
    ws.send(JSON.stringify({ id: 1, type: "frontend/subscribe_user_data", key: "sidebar" }));
    expect(JSON.parse(await rec.next())).toEqual({ id: 1, type: "result", success: true, result: null });
    expect(JSON.parse(await rec.next())).toEqual({ id: 1, type: "event", event: { value: null } });
    ws.send(JSON.stringify({ id: 2, type: "unsubscribe_events", subscription: 1 }));
    expect(JSON.parse(await rec.next())).toEqual({ id: 2, type: "result", success: true, result: null });
    expect(h.ha.received.map((m) => m.type)).not.toContain("frontend/subscribe_user_data");
    ws.close();
    await rec.closed;
  });

  test("guest close closes upstream", async () => {
    const { ws, rec } = await wsAuth(h.token);
    await rec.next();
    ws.close();
    await rec.closed;
    await Bun.sleep(50);
    expect(h.ha.wsAuthTokens).toHaveLength(1);
  });
});

describe("REST", () => {
  test("/api with valid guest bearer: forwarded with real token, guest token stripped", async () => {
    const res = await fetch(new URL("/api/camera_proxy/camera.front", h.proxyUrl), {
      headers: {
        authorization: `Bearer ${h.token}`,
        origin: "http://evil.example",
        "x-forwarded-for": "8.8.8.8",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("/api/camera_proxy/camera.front");
    expect(body.origin).toBeNull();
    expect(body.xff).toBeNull();
    expect(h.ha.httpAuth).toEqual([{ path: "/api/camera_proxy/camera.front", authorization: `Bearer ${h.ha.token}` }]);
  });

  test.each([
    ["no header", {}],
    ["wrong token", { authorization: "Bearer nope" }],
    ["real HA token", { authorization: "Bearer __REAL__" }],
    ["basic auth", { authorization: "Basic abc" }],
  ])("/api without valid guest bearer (%s): 401, HA not contacted", async (_, headers) => {
    const hdrs = { ...headers };
    if (hdrs.authorization === "Bearer __REAL__") hdrs.authorization = `Bearer ${h.ha.token}`;
    const res = await fetch(new URL("/api/camera_proxy/camera.front", h.proxyUrl), { headers: hdrs });
    expect(res.status).toBe(401);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("frontend root forwarded without any Authorization", async () => {
    const res = await fetch(new URL("/", h.proxyUrl), { headers: { authorization: `Bearer ${h.token}` } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("HA index");
    expect(h.ha.httpAuth).toEqual([{ path: "/", authorization: null }]);
  });

  test("other HA auth pages are not reachable", async () => {
    const res = await fetch(new URL("/auth/login_flow", h.proxyUrl));
    expect(res.status).toBe(404);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("/guest page contains no secrets", async () => {
    const res = await fetch(new URL("/guest", h.proxyUrl));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("hassTokens");
    expect(html).not.toContain(h.ha.token);
    expect(html).not.toContain(h.token);
    expect(html).not.toContain(h.config.adminSecret);
  });

  test("/auth/authorize shows the access-ended page", async () => {
    const res = await fetch(new URL("/auth/authorize?client_id=x", h.proxyUrl));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ended");
    expect(h.ha.httpAuth).toHaveLength(0);
  });
});

describe("/auth/token (handled locally)", () => {
  function post(form: Record<string, string>) {
    return fetch(new URL("/auth/token", h.proxyUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  }

  test("refresh with a valid token returns it with the remaining lifetime, never the real token", async () => {
    const res = await post({ grant_type: "refresh_token", refresh_token: h.token, client_id: "x" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(h.ha.token);
    const body = JSON.parse(text);
    expect(body.access_token).toBe(h.token);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(3500);
    expect(body.expires_in).toBeLessThanOrEqual(3600);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("refresh for a revoked guest is refused", async () => {
    h.store.revoke(h.guest.id);
    const res = await post({ grant_type: "refresh_token", refresh_token: h.token, client_id: "x" });
    expect(res.status).toBe(400);
  });

  test("refresh with invalid credential: 400", async () => {
    const res = await post({ grant_type: "refresh_token", refresh_token: "bad", client_id: "x" });
    expect(res.status).toBe(400);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("unsupported grant: 400", async () => {
    const res = await post({ grant_type: "authorization_code", code: "x", client_id: "x" });
    expect(res.status).toBe(400);
  });

  test("revoke: 200 and HA not contacted", async () => {
    const res = await post({ action: "revoke", token: h.token });
    expect(res.status).toBe(200);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("GET not allowed", async () => {
    const res = await fetch(new URL("/auth/token", h.proxyUrl));
    expect(res.status).toBe(405);
  });
});

describe("LAN-only", () => {
  test("non-LAN peer is refused everywhere, including with valid credentials", async () => {
    const wan = await startHarness("203.0.113.7");
    try {
      const res = await fetch(new URL("/api/camera_proxy/camera.front", wan.proxyUrl), {
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(403);
      expect((await fetch(new URL("/", wan.proxyUrl))).status).toBe(403);
      expect((await fetch(new URL("/guest", wan.proxyUrl))).status).toBe(403);
      expect(wan.ha.httpAuth).toHaveLength(0);

      const ws = new WebSocket(wan.wsUrl);
      const failed = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(false);
        ws.onerror = () => resolve(true);
        ws.onclose = () => resolve(true);
      });
      expect(failed).toBe(true);
      expect(wan.ha.wsConnections).toBe(0);
    } finally {
      await wan.stop();
    }
  });

  test("X-Forwarded-For from a LAN peer cannot change the decision", async () => {
    const wan = await startHarness("203.0.113.7");
    try {
      const res = await fetch(new URL("/", wan.proxyUrl), { headers: { "x-forwarded-for": "192.168.1.1" } });
      expect(res.status).toBe(403);
    } finally {
      await wan.stop();
    }
  });
});
