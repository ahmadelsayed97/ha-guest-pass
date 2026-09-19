import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "../src/rate-limit.ts";

function limiterAt(clock: { now: number }, limit = 3, windowMs = 1000) {
  return createRateLimiter({ limit, windowMs, now: () => clock.now });
}

describe("createRateLimiter", () => {
  test("a key with no failures is never blocked", () => {
    const limiter = limiterAt({ now: 0 });
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(0);
  });

  test("failures below the limit do not block", () => {
    const limiter = limiterAt({ now: 0 });
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(0);
  });

  test("the limit blocks for the rest of the window", () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    for (let i = 0; i < 3; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(1000);
    clock.now = 400;
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(600);
  });

  test("the window expires and the key is allowed again", () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    for (let i = 0; i < 3; i++) limiter.recordFailure("1.2.3.4");
    clock.now = 1000;
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(0);
  });

  test("failures spread across windows do not accumulate", () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    clock.now = 1200;
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(0);
  });

  test("keys are counted independently", () => {
    const limiter = limiterAt({ now: 0 });
    for (let i = 0; i < 3; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.retryAfterMs("5.6.7.8")).toBe(0);
  });

  test("a success clears the failures of that key alone", () => {
    const limiter = limiterAt({ now: 0 });
    for (let i = 0; i < 2; i++) {
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("5.6.7.8");
    }
    limiter.clear("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("5.6.7.8");
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(0);
    expect(limiter.retryAfterMs("5.6.7.8")).toBe(1000);
  });

  test("blocking keeps holding while the caller keeps trying", () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    for (let i = 0; i < 3; i++) limiter.recordFailure("1.2.3.4");
    clock.now = 900;
    limiter.recordFailure("1.2.3.4");
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(100);
  });

  test("tracked keys stay bounded", () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    for (let i = 0; i < 20000; i++) limiter.recordFailure(`10.0.${i >> 8}.${i & 255}`);
    expect(limiter.size()).toBeLessThanOrEqual(10000);
    for (let i = 0; i < 3; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.retryAfterMs("1.2.3.4")).toBe(1000);
  });
});
