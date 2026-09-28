import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./config.ts";

const SIGNING_KEY_BYTES = 32;
const ADMIN_SECRET_BYTES = 24;
const DEFAULT_HA_URL = "http://127.0.0.1:8123";
const SUPERVISOR_API_URL = "http://supervisor/core/api/";
const SUPERVISOR_WS_URL = "ws://supervisor/core/websocket";

export interface AddonEnv {
  env: Env;
  adminSecretGenerated: boolean;
}

function readOptions(dataDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(dataDir, "options.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("options.json must be an object");
  return parsed as Record<string, unknown>;
}

function optionalString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`Add-on option ${key} must be text`);
  return value.trim();
}

function keptSecret(dataDir: string, name: string, bytes: number): string {
  const file = join(dataDir, name);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function coreToken(options: Record<string, unknown>, env: Env): string {
  const configured = optionalString(options, "ha_token");
  const token = env.SUPERVISOR_TOKEN ?? configured;
  if (!token) throw new Error("Home Assistant access is unavailable: enable the add-on's Home Assistant API or set a long-lived token");
  return token;
}

export function addonEnv(dataDir = "/data", env: Env = process.env): AddonEnv | null {
  if (!existsSync(join(dataDir, "options.json"))) return null;
  const options = readOptions(dataDir);
  const configuredSecret = optionalString(options, "admin_secret");
  const viaSupervisor = env.SUPERVISOR_TOKEN !== undefined;

  return {
    adminSecretGenerated: configuredSecret === undefined,
    env: {
      HA_URL: optionalString(options, "ha_url") ?? DEFAULT_HA_URL,
      HA_API_URL: viaSupervisor ? SUPERVISOR_API_URL : undefined,
      HA_WS_URL: viaSupervisor ? SUPERVISOR_WS_URL : undefined,
      HA_TOKEN: coreToken(options, env),
      ADMIN_SECRET: configuredSecret ?? keptSecret(dataDir, "admin.secret", ADMIN_SECRET_BYTES),
      SIGNING_KEY: keptSecret(dataDir, "signing.key", SIGNING_KEY_BYTES),
      GUEST_STORE_FILE: join(dataDir, "guests.json"),
    },
  };
}
