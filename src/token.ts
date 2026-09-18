import { jwtVerify, SignJWT } from "jose";

export interface GuestClaims {
  guestId: string;
  tokenId: string;
  expiresAt: number;
}

const ALG = "HS256";

export async function signGuestToken(claims: GuestClaims, key: Uint8Array): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.guestId)
    .setJti(claims.tokenId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(claims.expiresAt / 1000))
    .sign(key);
}

export async function verifyGuestToken(token: unknown, key: Uint8Array): Promise<GuestClaims | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: [ALG], requiredClaims: ["sub", "jti", "exp"] });
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string" || typeof payload.exp !== "number") return null;
    return { guestId: payload.sub, tokenId: payload.jti, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
}
