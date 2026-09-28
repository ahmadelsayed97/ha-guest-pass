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

const options = { admin_secret: "0123456789abcdef0123456789abcdef" };
const supervisor = { SUPERVISOR_TOKEN: "supervisor-token" };

function writeOptions(value: unknown) {
  writeFileSync(join(dataDir, "options.json"), JSON.stringify(value));
}

describe("addonEnv", () => {
  test("is null when there is no options file", () => {
    expect(addonEnv(dataDir, supervisor)).toBeNull();
  });

  test("talks to Home Assistant through the Supervisor, with no token of its own", () => {
    writeOptions(options);
    const { env } = addonEnv(dataDir, supervisor)!;
    expect(env.HA_TOKEN).toBe("supervisor-token");
    expect(env.HA_API_URL).toBe("http://supervisor/core/api/");
    expect(env.HA_WS_URL).toBe("ws://supervisor/core/websocket");
    expect(env.HA_URL).toBe("http://127.0.0.1:8123");
    expect(env.ADMIN_SECRET).toBe(options.admin_secret);
    expect(env.GUEST_STORE_FILE).toBe(join(dataDir, "guests.json"));
  });

  test("a configured Home Assistant URL overrides the default frontend upstream", () => {
    writeOptions({ ...options, ha_url: "http://192.168.1.9:8123" });
    expect(addonEnv(dataDir, supervisor)!.env.HA_URL).toBe("http://192.168.1.9:8123");
  });

  test("without a Supervisor token it falls back to a configured long-lived token", () => {
    writeOptions({ ...options, ha_token: "long-lived-token" });
    const { env } = addonEnv(dataDir, {})!;
    expect(env.HA_TOKEN).toBe("long-lived-token");
    expect(env.HA_API_URL).toBeUndefined();
    expect(env.HA_WS_URL).toBeUndefined();
  });

  test("without a Supervisor token and without a configured one it refuses to start", () => {
    writeOptions(options);
    expect(() => addonEnv(dataDir, {})).toThrow();
  });

  describe("admin secret", () => {
    test("a blank one is generated, kept and reported", () => {
      writeOptions({ admin_secret: "" });
      const first = addonEnv(dataDir, supervisor)!;
      expect(first.adminSecretGenerated).toBe(true);
      expect(first.env.ADMIN_SECRET).toMatch(/^[0-9a-f]{48}$/);
      const file = join(dataDir, "admin.secret");
      expect(readFileSync(file, "utf8")).toBe(first.env.ADMIN_SECRET!);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const second = addonEnv(dataDir, supervisor)!;
      expect(second.env.ADMIN_SECRET).toBe(first.env.ADMIN_SECRET);
      expect(second.adminSecretGenerated).toBe(true);
    });

    test("a missing one is generated too", () => {
      writeOptions({});
      expect(addonEnv(dataDir, supervisor)!.env.ADMIN_SECRET).toMatch(/^[0-9a-f]{48}$/);
    });

    test("a configured one wins and is not reported", () => {
      writeOptions(options);
      const result = addonEnv(dataDir, supervisor)!;
      expect(result.env.ADMIN_SECRET).toBe(options.admin_secret);
      expect(result.adminSecretGenerated).toBe(false);
    });

    test("the generated one is long enough for the config", () => {
      writeOptions({});
      expect(() => loadConfig(addonEnv(dataDir, supervisor)!.env)).not.toThrow();
    });
  });

  test("generates a signing key on first run and keeps it", () => {
    writeOptions(options);
    const first = addonEnv(dataDir, supervisor)!.env;
    expect(first.SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/);
    const keyFile = join(dataDir, "signing.key");
    expect(readFileSync(keyFile, "utf8")).toBe(first.SIGNING_KEY!);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const second = addonEnv(dataDir, supervisor)!.env;
    expect(second.SIGNING_KEY).toBe(first.SIGNING_KEY);
  });

  test("two data dirs get different keys", () => {
    writeOptions(options);
    const other = mkdtempSync(join(tmpdir(), "addon-"));
    writeFileSync(join(other, "options.json"), JSON.stringify(options));
    try {
      expect(addonEnv(dataDir, supervisor)!.env.SIGNING_KEY).not.toBe(addonEnv(other, supervisor)!.env.SIGNING_KEY);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("the result loads as a full config", () => {
    writeOptions(options);
    const config = loadConfig(addonEnv(dataDir, supervisor)!.env);
    expect(config.port).toBe(8124);
    expect(config.haToken).toBe("supervisor-token");
    expect(config.wsUrl).toBe("ws://supervisor/core/websocket");
  });

  test.each([
    ["non-object options", [1]],
    ["a numeric token", { ...options, ha_token: 5 }],
    ["a numeric url", { ...options, ha_url: 8123 }],
    ["a numeric admin secret", { admin_secret: 5 }],
  ])("refuses %s", (_name, value) => {
    writeOptions(value);
    expect(() => addonEnv(dataDir, supervisor)).toThrow();
  });
});
