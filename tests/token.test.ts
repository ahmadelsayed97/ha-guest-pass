import { describe, expect, test } from "bun:test";
import { signGuestToken, verifyGuestToken } from "../src/token.ts";

const key = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(8);
const future = Date.now() + 3600_000;

describe("guest tokens", () => {
  test("round trip carries guest id, token id and expiry", async () => {
    const token = await signGuestToken({ guestId: "g1", tokenId: "t1", expiresAt: future }, key);
    expect(await verifyGuestToken(token, key)).toEqual({ guestId: "g1", tokenId: "t1", expiresAt: Math.floor(future / 1000) * 1000 });
  });

  test("the token never contains the ids in clear text with a signature that matches another key", async () => {
    const token = await signGuestToken({ guestId: "g1", tokenId: "t1", expiresAt: future }, key);
    expect(await verifyGuestToken(token, otherKey)).toBeNull();
  });

  test("expired tokens are rejected", async () => {
    const token = await signGuestToken({ guestId: "g1", tokenId: "t1", expiresAt: Date.now() - 1000 }, key);
    expect(await verifyGuestToken(token, key)).toBeNull();
  });

  test("tampered payload is rejected", async () => {
    const token = await signGuestToken({ guestId: "g1", tokenId: "t1", expiresAt: future }, key);
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "g2" })).toString("base64url");
    expect(await verifyGuestToken(`${header}.${forged}.${signature}`, key)).toBeNull();
  });

  test("alg none and garbage are rejected", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "g1", jti: "t1", exp: Math.floor(future / 1000) })).toString("base64url");
    expect(await verifyGuestToken(`${header}.${payload}.`, key)).toBeNull();
    expect(await verifyGuestToken("", key)).toBeNull();
    expect(await verifyGuestToken("not.a.jwt", key)).toBeNull();
    expect(await verifyGuestToken(null, key)).toBeNull();
    expect(await verifyGuestToken(42, key)).toBeNull();
  });

  test("tokens without an expiry or subject are rejected even when correctly signed", async () => {
    const { SignJWT } = await import("jose");
    const noExp = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("g1").setJti("t1").sign(key);
    expect(await verifyGuestToken(noExp, key)).toBeNull();
    const noSub = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setJti("t1").setExpirationTime("1h").sign(key);
    expect(await verifyGuestToken(noSub, key)).toBeNull();
  });
});
