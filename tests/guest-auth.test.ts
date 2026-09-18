import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearerToken, tokenAuthenticator } from "../src/guest-auth.ts";
import { GuestStore } from "../src/guest-store.ts";
import { signGuestToken } from "../src/token.ts";

const key = new Uint8Array(32).fill(1);
const definition = { dashboards: ["lovelace-guest"], areas: {}, entities: { "light.kitchen": "control" as const } };
const scope = { dashboards: ["lovelace-guest"], entities: { "light.kitchen": "control" as const } };

let dir: string;
let store: GuestStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auth-"));
  store = await GuestStore.open(join(dir, "guests.json"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const future = () => Date.now() + 3600_000;

describe("tokenAuthenticator", () => {
  test("a signed token for a live guest yields a session", async () => {
    const guest = store.create({ name: "Ada", expiresAt: future(), definition, scope });
    const auth = tokenAuthenticator(store, key);
    const session = await auth.authenticate(await signGuestToken({ guestId: guest.id, tokenId: guest.tokenId, expiresAt: guest.expiresAt }, key));
    expect(session?.user).toEqual({ id: guest.id, name: "Ada" });
    expect(session?.expiresAt).toBe(guest.expiresAt);
    expect(session?.scope.canControl("light.kitchen")).toBe(true);
    expect(session?.scope.canView("light.other")).toBe(false);
  });

  test("the same guest resolves to the same scope object across calls", async () => {
    const guest = store.create({ name: "Ada", expiresAt: future(), definition, scope });
    const auth = tokenAuthenticator(store, key);
    const token = await signGuestToken({ guestId: guest.id, tokenId: guest.tokenId, expiresAt: guest.expiresAt }, key);
    expect((await auth.authenticate(token))?.scope).toBe((await auth.authenticate(token))?.scope);
  });

  test("revoked guest is refused immediately", async () => {
    const guest = store.create({ name: "Ada", expiresAt: future(), definition, scope });
    const auth = tokenAuthenticator(store, key);
    const token = await signGuestToken({ guestId: guest.id, tokenId: guest.tokenId, expiresAt: guest.expiresAt }, key);
    expect(await auth.authenticate(token)).not.toBeNull();
    store.revoke(guest.id);
    expect(await auth.authenticate(token)).toBeNull();
  });

  test("a token whose token id does not match the record is refused", async () => {
    const guest = store.create({ name: "Ada", expiresAt: future(), definition, scope });
    const auth = tokenAuthenticator(store, key);
    expect(await auth.authenticate(await signGuestToken({ guestId: guest.id, tokenId: "other", expiresAt: guest.expiresAt }, key))).toBeNull();
  });

  test("a token for an unknown guest is refused", async () => {
    const auth = tokenAuthenticator(store, key);
    expect(await auth.authenticate(await signGuestToken({ guestId: "ghost", tokenId: "t", expiresAt: future() }, key))).toBeNull();
  });

  test("a token signed with another key is refused", async () => {
    const guest = store.create({ name: "Ada", expiresAt: future(), definition, scope });
    const auth = tokenAuthenticator(store, key);
    const other = new Uint8Array(32).fill(2);
    expect(await auth.authenticate(await signGuestToken({ guestId: guest.id, tokenId: guest.tokenId, expiresAt: guest.expiresAt }, other))).toBeNull();
  });

  test("a valid token past the record's expiry is refused", async () => {
    const guest = store.create({ name: "Ada", expiresAt: Date.now() + 50, definition, scope });
    const auth = tokenAuthenticator(store, key);
    const token = await signGuestToken({ guestId: guest.id, tokenId: guest.tokenId, expiresAt: Date.now() + 3600_000 }, key);
    await Bun.sleep(60);
    expect(await auth.authenticate(token)).toBeNull();
  });

  test.each([null, undefined, "", 42, "garbage"])("%p is refused", async (credential) => {
    expect(await tokenAuthenticator(store, key).authenticate(credential)).toBeNull();
  });

  test("dashboards lists the union over live guests only", async () => {
    store.create({ name: "A", expiresAt: future(), definition, scope });
    const b = store.create({ name: "B", expiresAt: future(), definition: { ...definition, dashboards: ["lovelace"] }, scope: { ...scope, dashboards: ["lovelace"] } });
    store.create({ name: "C", expiresAt: Date.now() - 1, definition: { ...definition, dashboards: ["old"] }, scope: { ...scope, dashboards: ["old"] } });
    const auth = tokenAuthenticator(store, key);
    expect(auth.dashboards().sort()).toEqual(["lovelace", "lovelace-guest"]);
    store.revoke(b.id);
    expect(auth.dashboards()).toEqual(["lovelace-guest"]);
  });
});

describe("bearerToken", () => {
  test("parses Bearer", () => expect(bearerToken("Bearer abc")).toBe("abc"));
  test.each([null, "", "Basic abc", "Bearer", "Bearer a b", "abc"])("rejects %p", (v) => {
    expect(bearerToken(v)).toBeNull();
  });
});
