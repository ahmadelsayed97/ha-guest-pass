import { timingSafeEqual } from "node:crypto";

export function isValidGuestToken(presented: unknown, secret: string): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return match?.[1] ?? null;
}
