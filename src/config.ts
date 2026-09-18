export interface Config {
  haUrl: URL;
  readonly haToken: string;
  readonly guestSecret: string;
  host: string;
  port: number;
}

const MIN_SECRET_LENGTH = 32;

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const haUrl = new URL(required(env, "HA_URL"));
  if (haUrl.protocol !== "http:" && haUrl.protocol !== "https:") {
    throw new Error("HA_URL must be http:// or https://");
  }
  const haToken = required(env, "HA_TOKEN");
  const guestSecret = required(env, "GUEST_SECRET");
  if (guestSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`GUEST_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const port = Number(env.PORT ?? "8124");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be 1-65535");

  const config = { haUrl, host: env.HOST ?? "0.0.0.0", port } as Config;
  Object.defineProperty(config, "haToken", { value: haToken, enumerable: false, writable: false });
  Object.defineProperty(config, "guestSecret", { value: guestSecret, enumerable: false, writable: false });
  return config;
}
