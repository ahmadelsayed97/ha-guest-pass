import { timingSafeEqual } from "node:crypto";
import type { Scope } from "./scope.ts";

export interface GuestUser {
  id: string;
  name: string;
}

export interface Session {
  user: GuestUser;
  scope: Scope;
}

export interface Authenticator {
  authenticate(credential: unknown): Session | null;
  dashboards(): string[];
}

export function sharedSecretAuthenticator(secret: string, scope: Scope): Authenticator {
  const session: Session = { user: { id: "guest", name: "Guest" }, scope };
  return {
    authenticate: (credential) => (constantTimeEquals(credential, secret) ? session : null),
    dashboards: () => scope.dashboards(),
  };
}

function constantTimeEquals(presented: unknown, secret: string): boolean {
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
