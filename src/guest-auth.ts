import { timingSafeEqual } from "node:crypto";
import type { GuestStore } from "./guest-store.ts";
import { parseScope, type Scope } from "./scope.ts";
import { verifyGuestToken } from "./token.ts";

export interface GuestUser {
  id: string;
  name: string;
}

export interface Session {
  user: GuestUser;
  scope: Scope;
  expiresAt: number;
}

export interface Authenticator {
  authenticate(credential: unknown): Promise<Session | null>;
  dashboards(): string[];
}

export function tokenAuthenticator(store: GuestStore, key: Uint8Array): Authenticator {
  const scopes = new WeakMap<object, Scope>();

  return {
    async authenticate(credential) {
      const claims = await verifyGuestToken(credential, key);
      if (!claims) return null;
      const guest = store.get(claims.guestId);
      if (!guest || guest.revokedAt !== null || guest.expiresAt <= Date.now()) return null;
      if (!constantTimeEquals(claims.tokenId, guest.tokenId)) return null;
      let scope = scopes.get(guest.scope);
      if (!scope) {
        scope = parseScope(guest.scope);
        scopes.set(guest.scope, scope);
      }
      return { user: { id: guest.id, name: guest.name }, scope, expiresAt: guest.expiresAt };
    },
    dashboards() {
      const now = Date.now();
      const paths = new Set<string>();
      for (const guest of store.list()) {
        if (guest.revokedAt !== null || guest.expiresAt <= now) continue;
        for (const path of guest.scope.dashboards) paths.add(path);
      }
      return [...paths];
    },
  };
}

export function constantTimeEquals(presented: unknown, secret: string): boolean {
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
