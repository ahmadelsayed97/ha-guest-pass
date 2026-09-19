import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addonEnv } from "../src/addon.ts";
import { loadConfig } from "../src/config.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "addon-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const options = {
  ha_url: "http://127.0.0.1:8123",
  ha_token: "long-lived-token",
  admin_secret: "0123456789abcdef0123456789abcdef",
};

function writeOptions(value: unknown) {
  writeFileSync(join(dataDir, "options.json"), JSON.stringify(value));
}

describe("addonEnv", () => {
  test("is null when there is no options file", () => {
    expect(addonEnv(dataDir)).toBeNull();
  });

  test("maps options to the environment the proxy expects", () => {
    writeOptions(options);
    const env = addonEnv(dataDir)!;
    expect(env.HA_URL).toBe("http://127.0.0.1:8123");
    expect(env.HA_TOKEN).toBe("long-lived-token");
    expect(env.ADMIN_SECRET).toBe(options.admin_secret);
    expect(env.GUEST_STORE_FILE).toBe(join(dataDir, "guests.json"));
  });

  test("generates a signing key on first run and keeps it", () => {
    writeOptions(options);
    const first = addonEnv(dataDir)!;
    expect(first.SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/);
    const keyFile = join(dataDir, "signing.key");
    expect(readFileSync(keyFile, "utf8")).toBe(first.SIGNING_KEY!);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const second = addonEnv(dataDir)!;
    expect(second.SIGNING_KEY).toBe(first.SIGNING_KEY);
  });

  test("two data dirs get different keys", () => {
    writeOptions(options);
    const other = mkdtempSync(join(tmpdir(), "addon-"));
    writeFileSync(join(other, "options.json"), JSON.stringify(options));
    try {
      expect(addonEnv(dataDir)!.SIGNING_KEY).not.toBe(addonEnv(other)!.SIGNING_KEY);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("the result loads as a full config", () => {
    writeOptions(options);
    const config = loadConfig(addonEnv(dataDir)!);
    expect(config.port).toBe(8124);
    expect(config.haToken).toBe("long-lived-token");
  });

  test.each([
    ["non-object options", [1]],
    ["numeric token", { ...options, ha_token: 5 }],
    ["missing admin secret", { ha_url: options.ha_url, ha_token: options.ha_token }],
  ])("refuses %s", (_name, value) => {
    writeOptions(value);
    expect(() => addonEnv(dataDir)).toThrow();
  });
});
