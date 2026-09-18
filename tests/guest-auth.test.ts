import { describe, expect, test } from "bun:test";
import { bearerToken, isValidGuestToken } from "../src/guest-auth.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("isValidGuestToken", () => {
  test("accepts exact secret", () => expect(isValidGuestToken(SECRET, SECRET)).toBe(true));
  test.each([
    ["", "empty"],
    [SECRET.slice(0, -1), "truncated"],
    [SECRET + "x", "extended"],
    [SECRET.toUpperCase(), "case changed"],
    [" " + SECRET, "leading space"],
    [null, "null"],
    [undefined, "undefined"],
    [123, "number"],
    [{ toString: () => SECRET }, "object"],
    [[SECRET], "array"],
  ])("rejects %p (%s)", (presented) => {
    expect(isValidGuestToken(presented, SECRET)).toBe(false);
  });
});

describe("bearerToken", () => {
  test("parses Bearer", () => expect(bearerToken("Bearer abc")).toBe("abc"));
  test("case-insensitive scheme", () => expect(bearerToken("bearer abc")).toBe("abc"));
  test.each([null, "", "Basic abc", "Bearer", "Bearer a b", "abc"])("rejects %p", (v) => {
    expect(bearerToken(v)).toBeNull();
  });
});
