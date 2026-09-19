import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./config.ts";

const SIGNING_KEY_BYTES = 32;

function readOptions(dataDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(dataDir, "options.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("options.json must be an object");
  return parsed as Record<string, unknown>;
}

function requiredString(options: Record<string, unknown>, key: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Add-on option ${key} is required`);
  return value;
}

function signingKey(dataDir: string): string {
  const file = join(dataDir, "signing.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(SIGNING_KEY_BYTES))).toString("hex");
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export function addonEnv(dataDir = "/data"): Env | null {
  if (!existsSync(join(dataDir, "options.json"))) return null;
  const options = readOptions(dataDir);
  return {
    HA_URL: requiredString(options, "ha_url"),
    HA_TOKEN: requiredString(options, "ha_token"),
    ADMIN_SECRET: requiredString(options, "admin_secret"),
    SIGNING_KEY: signingKey(dataDir),
    GUEST_STORE_FILE: join(dataDir, "guests.json"),
  };
}
