import type { Scope } from "./scope.ts";

const CONFIG_KEYS_KEPT = new Set([
  "unit_system",
  "location_name",
  "time_zone",
  "components",
  "version",
  "state",
  "currency",
  "country",
  "language",
]);

const COMPONENTS_KEPT = new Set(["frontend", "lovelace"]);

const EMBEDDED_ENTITY_ID = /(?<![a-z0-9_./:@-])([a-z_][a-z0-9_]*\.[a-z0-9_]+)(?![a-z0-9_./:@-])/g;
const ENTITY_ID_ANYWHERE = new RegExp(EMBEDDED_ENTITY_ID.source);

const UNSCOPED = Symbol("unscoped");
const EMPTY = Symbol("empty");

export function redactConfig(config: unknown): Record<string, unknown> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!CONFIG_KEYS_KEPT.has(key)) continue;
    out[key] = key === "components" ? filterComponents(value) : structuredClone(value);
  }
  return out;
}

function filterComponents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is string => typeof c === "string" && COMPONENTS_KEPT.has(c));
}

const CONTAINER_LIST_KEYS = ["views", "sections", "cards", "elements"];

export function filterDashboard(config: unknown, scope: Scope, guestId: string): unknown {
  const out = prune(config, scope, guestId);
  return out === UNSCOPED || out === EMPTY ? {} : out;
}

function prune(value: unknown, scope: Scope, guestId: string): unknown {
  if (typeof value === "string") return mentionsUnscoped(value, scope) ? UNSCOPED : value;
  if (Array.isArray(value)) {
    return value.map((item) => prune(item, scope, guestId)).filter((item) => item !== UNSCOPED && item !== EMPTY);
  }
  if (typeof value === "object" && value !== null) {
    if ("visibility" in value && !visibleToGuest(value.visibility, guestId)) return UNSCOPED;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (mentionsUnscoped(key, scope)) continue;
      const pruned = prune(item, scope, guestId);
      if (pruned === UNSCOPED) return UNSCOPED;
      if (pruned === EMPTY) continue;
      out[key] = pruned;
    }
    if (isContainer(out) && !mentionsEntity(out)) return EMPTY;
    return out;
  }
  return value;
}

function visibleToGuest(visibility: unknown, guestId: string): boolean {
  if (!Array.isArray(visibility)) return false;
  for (const condition of visibility) {
    if (typeof condition !== "object" || condition === null) return false;
    if ((condition as Record<string, unknown>).condition !== "user") continue;
    const users = (condition as Record<string, unknown>).users;
    if (!Array.isArray(users) || !users.includes(guestId)) return false;
  }
  return true;
}

function isContainer(node: Record<string, unknown>): boolean {
  return node.type === "conditional" || CONTAINER_LIST_KEYS.some((key) => Array.isArray(node[key]));
}

function mentionsEntity(value: unknown): boolean {
  if (typeof value === "string") return ENTITY_ID_ANYWHERE.test(value);
  if (Array.isArray(value)) return value.some(mentionsEntity);
  if (typeof value === "object" && value !== null) return Object.values(value).some(mentionsEntity);
  return false;
}

function mentionsUnscoped(text: string, scope: Scope): boolean {
  for (const match of text.matchAll(EMBEDDED_ENTITY_ID)) {
    if (!scope.canView(match[1]!)) return true;
  }
  return false;
}
