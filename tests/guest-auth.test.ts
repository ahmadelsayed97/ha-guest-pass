import { describe, expect, test } from "bun:test";
import { bearerToken, sharedSecretAuthenticator } from "../src/guest-auth.ts";
import { parseScope } from "../src/scope.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const scope = parseScope({ dashboards: ["lovelace-guest"], entities: { "light.kitchen": "control" } });
const auth = sharedSecretAuthenticator(SECRET, scope);

describe("sharedSecretAuthenticator", () => {
  test("exact secret yields a guest session with the scope", () => {
    const session = auth.authenticate(SECRET);
    expect(session?.user).toEqual({ id: "guest", name: "Guest" });
    expect(session?.scope).toBe(scope);
  });

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
    expect(auth.authenticate(presented)).toBeNull();
  });

  test("lists the dashboards any session may open", () => {
    expect(auth.dashboards()).toEqual(["lovelace-guest"]);
  });
});

describe("bearerToken", () => {
  test("parses Bearer", () => expect(bearerToken("Bearer abc")).toBe("abc"));
  test("case-insensitive scheme", () => expect(bearerToken("bearer abc")).toBe("abc"));
  test.each([null, "", "Basic abc", "Bearer", "Bearer a b", "abc"])("rejects %p", (v) => {
    expect(bearerToken(v)).toBeNull();
  });
});
