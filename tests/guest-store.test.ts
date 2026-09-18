import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuestStore } from "../src/guest-store.ts";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "guests-"));
  file = join(dir, "guests.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const definition = { dashboards: ["lovelace-guest"], areas: {}, entities: { "light.kitchen": "control" as const } };
const scope = { dashboards: ["lovelace-guest"], entities: { "light.kitchen": "control" as const } };

describe("GuestStore", () => {
  test("starts empty when the file does not exist", async () => {
    const store = await GuestStore.open(file);
    expect(store.list()).toEqual([]);
  });

  test("create assigns ids and persists", async () => {
    const store = await GuestStore.open(file);
    const guest = store.create({ name: "Ada", expiresAt: 1_800_000_000_000, definition, scope });
    await store.flush();
    expect(guest.id).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(guest.tokenId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(guest.id).not.toBe(guest.tokenId);
    const reopened = await GuestStore.open(file);
    expect(reopened.get(guest.id)).toEqual(guest);
  });

  test("revoke marks the guest and persists", async () => {
    const store = await GuestStore.open(file);
    const guest = store.create({ name: "Ada", expiresAt: 1_800_000_000_000, definition, scope });
    expect(store.revoke(guest.id)).toBe(true);
    expect(store.revoke("missing")).toBe(false);
    await store.flush();
    expect((await GuestStore.open(file)).get(guest.id)?.revokedAt).toBeNumber();
  });

  test("a corrupt file fails to open rather than starting empty", async () => {
    await Bun.write(file, "{not json");
    await expect(GuestStore.open(file)).rejects.toThrow();
  });

  test("a file with an invalid record fails to open", async () => {
    await Bun.write(file, JSON.stringify({ guests: [{ id: "x" }] }));
    await expect(GuestStore.open(file)).rejects.toThrow();
  });

  test("a failed write is reported and later writes are still attempted", async () => {
    const blocker = join(dir, "blocker");
    await Bun.write(blocker, "not a directory");
    const errors: Error[] = [];
    const store = await GuestStore.open(join(blocker, "guests.json"), (e) => errors.push(e));
    store.create({ name: "One", expiresAt: 1_800_000_000_000, definition, scope });
    await store.flush();
    expect(errors).toHaveLength(1);
    store.create({ name: "Two", expiresAt: 1_800_000_000_000, definition, scope });
    await store.flush();
    expect(errors).toHaveLength(2);
    expect(store.list().map((g) => g.name)).toEqual(["One", "Two"]);
  });

  test("the file never contains a token", async () => {
    const store = await GuestStore.open(file);
    store.create({ name: "Ada", expiresAt: 1_800_000_000_000, definition, scope });
    await store.flush();
    const text = await Bun.file(file).text();
    expect(text).not.toMatch(/eyJ/);
    expect(text).toContain('"tokenId"');
  });
});
