import { describe, expect, test } from "bun:test";
import { isLanAddress } from "../src/lan.ts";

describe("isLanAddress", () => {
  test.each([
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.255.255",
    "127.0.0.1",
    "169.254.10.10",
    "::1",
    "fe80::1",
    "fe80::1%en0",
    "fd12:3456::1",
    "fc00::1",
    "::ffff:192.168.1.5",
    "::FFFF:10.0.0.9",
  ])("allows %s", (ip) => {
    expect(isLanAddress(ip)).toBe(true);
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "100.64.0.1",
    "2001:db8::1",
    "2a00:1450::1",
    "::ffff:8.8.8.8",
    "::ffff:2001:db8::1",
    "fe00::1",
    "fb00::1",
    "",
    "not-an-ip",
    "192.168.1",
    "192.168.1.256",
    "10.0.0.1.5",
    " 8.8.8.8 ",
    null,
    undefined,
  ])("denies %p", (ip) => {
    expect(isLanAddress(ip as string)).toBe(false);
  });
});
