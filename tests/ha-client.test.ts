import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { fetchRegistries, HAClient } from "../src/ha-client.ts";
import { startFakeHA, type FakeHA } from "./fake-ha.ts";

let ha: FakeHA;
beforeEach(() => {
  ha = startFakeHA();
});
afterEach(() => {
  ha.stop();
});

const configFor = (token: string) =>
  loadConfig({ HA_URL: ha.url.toString(), HA_TOKEN: token, GUEST_SECRET: "x".repeat(32), GUEST_SCOPE_FILE: "s.json" });

describe("HAClient", () => {
  test("authenticates with the real token and answers calls", async () => {
    const client = await HAClient.connect(configFor(ha.token));
    const areas = await client.call("config/area_registry/list");
    expect(areas).toEqual([{ area_id: "kitchen", name: "Kitchen" }]);
    expect(ha.wsAuthTokens).toEqual([ha.token]);
    client.close();
  });

  test("calls can run concurrently and are matched by id", async () => {
    const client = await HAClient.connect(configFor(ha.token));
    const [a, d] = await Promise.all([client.call("config/area_registry/list"), client.call("config/device_registry/list")]);
    expect(a).toEqual([{ area_id: "kitchen", name: "Kitchen" }]);
    expect(d).toEqual([{ id: "dev-1", area_id: "kitchen" }]);
    client.close();
  });

  test("a failed result rejects without the token in the message", async () => {
    const client = await HAClient.connect(configFor(ha.token));
    await expect(client.call("fail/please")).rejects.toThrow(/boom/);
    client.close();
  });

  test("a rejected token fails to connect without exposing it", async () => {
    await expect(HAClient.connect(configFor("wrong-token"))).rejects.toThrow(/auth/);
  });
});

describe("fetchRegistries", () => {
  test("returns areas, devices and entities", async () => {
    const client = await HAClient.connect(configFor(ha.token));
    const registries = await fetchRegistries(client);
    expect(registries.areas).toHaveLength(1);
    expect(registries.devices).toHaveLength(1);
    expect(registries.entities.map((e) => e.entity_id)).toEqual(["light.kitchen", "sensor.temp"]);
    client.close();
  });
});
