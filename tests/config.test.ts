import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const base = {
  HA_URL: "http://ha.local:8123",
  HA_TOKEN: "real-token",
  SIGNING_KEY: "a".repeat(64),
  ADMIN_SECRET: "0123456789abcdef0123456789abcdef",
  GUEST_STORE_FILE: "./guests.json",
};

describe("loadConfig", () => {
  test("loads valid env", () => {
    const c = loadConfig(base);
    expect(c.haUrl.origin).toBe("http://ha.local:8123");
    expect(c.haToken).toBe("real-token");
    expect(c.signingKey).toEqual(new Uint8Array(32).fill(0xaa));
    expect(c.adminSecret).toBe(base.ADMIN_SECRET);
    expect(c.guestStoreFile).toBe("./guests.json");
    expect(c.port).toBe(8124);
  });

  test("secrets are not enumerable", () => {
    const c = loadConfig(base);
    const text = JSON.stringify(c);
    expect(text).not.toContain("real-token");
    expect(text).not.toContain(base.ADMIN_SECRET);
    expect(text).not.toContain("aaaa");
    expect(Object.keys(c)).not.toContain("haToken");
    expect(Object.keys(c)).not.toContain("signingKey");
    expect(Object.keys(c)).not.toContain("adminSecret");
  });

  test.each([
    [{ ...base, HA_URL: undefined }, "missing HA_URL"],
    [{ ...base, HA_TOKEN: " " }, "blank HA_TOKEN"],
    [{ ...base, SIGNING_KEY: "a".repeat(63) }, "short SIGNING_KEY"],
    [{ ...base, SIGNING_KEY: "z".repeat(64) }, "non-hex SIGNING_KEY"],
    [{ ...base, ADMIN_SECRET: "short" }, "short ADMIN_SECRET"],
    [{ ...base, GUEST_STORE_FILE: "" }, "missing GUEST_STORE_FILE"],
    [{ ...base, HA_URL: "ftp://x" }, "bad scheme"],
    [{ ...base, PORT: "99999" }, "bad port"],
  ])("rejects %p (%s)", (env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});
