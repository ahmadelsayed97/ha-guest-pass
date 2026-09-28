import { afterEach, describe, expect, test } from "bun:test";
import { fetchIngressPort } from "../src/supervisor.ts";

let fake: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => fake?.stop(true));

function fakeSupervisor(handler: (req: Request) => Response) {
  fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return `http://127.0.0.1:${fake.port}`;
}

describe("fetchIngressPort", () => {
  test("reads the dynamic port from the add-on's own info", async () => {
    let seen: string | null = null;
    const base = fakeSupervisor((req) => {
      seen = req.headers.get("authorization");
      return Response.json({ result: "ok", data: { ingress_port: 40123, ingress: true } });
    });
    expect(await fetchIngressPort("sup-token", base)).toBe(40123);
    expect(seen as string | null).toBe("Bearer sup-token");
  });

  test("is null when Supervisor refuses", async () => {
    const base = fakeSupervisor(() => new Response("nope", { status: 401 }));
    expect(await fetchIngressPort("sup-token", base)).toBeNull();
  });

  test("is null when the port is missing or not a number", async () => {
    const base = fakeSupervisor(() => Response.json({ result: "ok", data: { ingress_port: "40123" } }));
    expect(await fetchIngressPort("sup-token", base)).toBeNull();
  });

  test("is null when Supervisor is unreachable", async () => {
    expect(await fetchIngressPort("sup-token", "http://127.0.0.1:1")).toBeNull();
  });
});
