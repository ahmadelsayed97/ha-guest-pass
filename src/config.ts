export interface Config {
  haUrl: URL;
  readonly haToken: string;
  readonly signingKey: Uint8Array;
  readonly adminSecret: string;
  guestStoreFile: string;
  host: string;
  port: number;
}

const MIN_SECRET_LENGTH = 32;
const SIGNING_KEY_BYTES = 32;

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

function hidden(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const haUrl = new URL(required(env, "HA_URL"));
  if (haUrl.protocol !== "http:" && haUrl.protocol !== "https:") throw new Error("HA_URL must be http:// or https://");
  const haToken = required(env, "HA_TOKEN");

  const signingKeyHex = required(env, "SIGNING_KEY");
  if (!/^[0-9a-fA-F]+$/.test(signingKeyHex) || signingKeyHex.length < SIGNING_KEY_BYTES * 2) {
    throw new Error(`SIGNING_KEY must be at least ${SIGNING_KEY_BYTES} bytes as hex`);
  }
  const signingKey = Uint8Array.from(Buffer.from(signingKeyHex, "hex"));

  const adminSecret = required(env, "ADMIN_SECRET");
  if (adminSecret.length < MIN_SECRET_LENGTH) throw new Error(`ADMIN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);

  const guestStoreFile = required(env, "GUEST_STORE_FILE");
  const port = Number(env.PORT ?? "8124");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be 1-65535");

  const config = { haUrl, guestStoreFile, host: env.HOST ?? "0.0.0.0", port } as Config;
  hidden(config, "haToken", haToken);
  hidden(config, "signingKey", signingKey);
  hidden(config, "adminSecret", adminSecret);
  return config;
}
