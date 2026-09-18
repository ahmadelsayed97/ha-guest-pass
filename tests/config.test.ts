import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const base = {
  HA_URL: "http://ha.local:8123",
  HA_TOKEN: "real-token",
  GUEST_SECRET: "0123456789abcdef0123456789abcdef",
  GUEST_SCOPE_FILE: "./scope.json",
};

describe("loadConfig", () => {
  test("loads valid env", () => {
    const c = loadConfig(base);
    expect(c.haUrl.origin).toBe("http://ha.local:8123");
    expect(c.haToken).toBe("real-token");
    expect(c.port).toBe(8124);
  });

  test("secrets are not enumerable (no accidental log/serialise leak)", () => {
    const c = loadConfig(base);
    expect(JSON.stringify(c)).not.toContain("real-token");
    expect(JSON.stringify(c)).not.toContain(base.GUEST_SECRET);
    expect(Object.keys(c)).not.toContain("haToken");
  });

  test.each([
    [{ ...base, HA_URL: undefined }, "missing HA_URL"],
    [{ ...base, HA_TOKEN: " " }, "blank HA_TOKEN"],
    [{ ...base, GUEST_SECRET: "short" }, "short GUEST_SECRET"],
    [{ ...base, GUEST_SCOPE_FILE: "" }, "missing GUEST_SCOPE_FILE"],
    [{ ...base, HA_URL: "ftp://x" }, "bad scheme"],
    [{ ...base, PORT: "99999" }, "bad port"],
  ])("rejects %p (%s)", (env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});
