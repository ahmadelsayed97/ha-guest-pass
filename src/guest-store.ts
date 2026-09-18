import { rename } from "node:fs/promises";
import { parseScope, type Permission } from "./scope.ts";
import { parseScopeDefinition, type ScopeDefinition } from "./scope-definition.ts";

export interface ScopeInput {
  dashboards: string[];
  entities: Record<string, Permission>;
}

export interface Guest {
  id: string;
  tokenId: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  definition: ScopeDefinition;
  scope: ScopeInput;
}

export interface NewGuest {
  name: string;
  expiresAt: number;
  definition: ScopeDefinition;
  scope: ScopeInput;
}

function randomId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseGuest(input: unknown): Guest {
  if (typeof input !== "object" || input === null) throw new Error("guest record must be an object");
  const g = input as Record<string, unknown>;
  if (typeof g.id !== "string" || typeof g.tokenId !== "string" || typeof g.name !== "string") throw new Error("guest record missing ids or name");
  if (!isFiniteNumber(g.createdAt) || !isFiniteNumber(g.expiresAt)) throw new Error("guest record missing timestamps");
  if (g.revokedAt !== null && !isFiniteNumber(g.revokedAt)) throw new Error("guest record has bad revokedAt");
  const definition = parseScopeDefinition(g.definition);
  parseScope(g.scope);
  return {
    id: g.id,
    tokenId: g.tokenId,
    name: g.name,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    revokedAt: g.revokedAt as number | null,
    definition,
    scope: g.scope as ScopeInput,
  };
}

export class GuestStore {
  private readonly guests = new Map<string, Guest>();
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly onError: (error: Error) => void,
  ) {}

  static async open(path: string, onError: (error: Error) => void = () => {}): Promise<GuestStore> {
    const store = new GuestStore(path, onError);
    const file = Bun.file(path);
    if (await file.exists()) {
      const data = (await file.json()) as { guests?: unknown };
      if (!Array.isArray(data.guests)) throw new Error("guest store file has no guests array");
      for (const record of data.guests) {
        const guest = parseGuest(record);
        store.guests.set(guest.id, guest);
      }
    }
    return store;
  }

  list(): Guest[] {
    return [...this.guests.values()];
  }

  get(id: string): Guest | undefined {
    return this.guests.get(id);
  }

  create(input: NewGuest): Guest {
    const guest: Guest = {
      id: randomId(),
      tokenId: randomId(),
      name: input.name,
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
      revokedAt: null,
      definition: input.definition,
      scope: input.scope,
    };
    this.guests.set(guest.id, guest);
    this.save();
    return guest;
  }

  revoke(id: string): boolean {
    const guest = this.guests.get(id);
    if (!guest || guest.revokedAt !== null) return false;
    guest.revokedAt = Date.now();
    this.save();
    return true;
  }

  flush(): Promise<void> {
    return this.writing;
  }

  private save(): void {
    const snapshot = JSON.stringify({ guests: this.list() }, null, 2) + "\n";
    this.writing = this.writing
      .then(async () => {
        const tmp = `${this.path}.tmp`;
        await Bun.write(tmp, snapshot);
        await rename(tmp, this.path);
      })
      .catch((error: Error) => this.onError(error));
  }
}
