export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

export interface RateLimiter {
  retryAfterMs(key: string): number;
  recordFailure(key: string): void;
  clear(key: string): void;
  size(): number;
}

interface Window {
  failures: number;
  endsAt: number;
}

const DEFAULT_MAX_KEYS = 10000;

export const ADMIN_FAILURE_LIMIT = 10;
export const ADMIN_WINDOW_MS = 300_000;
export const GUEST_FAILURE_LIMIT = 20;
export const GUEST_WINDOW_MS = 60_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();

  function current(key: string): Window | undefined {
    const window = windows.get(key);
    if (!window) return undefined;
    if (window.endsAt > now()) return window;
    windows.delete(key);
    return undefined;
  }

  function evictExpired(): void {
    const time = now();
    for (const [key, window] of windows) if (window.endsAt <= time) windows.delete(key);
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done) return;
      windows.delete(oldest.value);
    }
  }

  return {
    retryAfterMs(key) {
      const window = current(key);
      return window && window.failures >= limit ? window.endsAt - now() : 0;
    },

    recordFailure(key) {
      const window = current(key);
      if (window) {
        window.failures += 1;
        return;
      }
      if (windows.size >= maxKeys) evictExpired();
      windows.set(key, { failures: 1, endsAt: now() + windowMs });
    },

    clear(key) {
      windows.delete(key);
    },

    size() {
      return windows.size;
    },
  };
}
