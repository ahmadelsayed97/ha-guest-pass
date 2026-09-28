import type { Permission } from "./scope.ts";
import type { ScopeDefinition } from "./scope-definition.ts";

export interface AreaEntry {
  area_id: string;
  name: string;
}

export interface DeviceEntry {
  id: string;
  area_id: string | null;
  name?: string | null;
  name_by_user?: string | null;
}

export interface EntityEntry {
  entity_id: string;
  area_id: string | null;
  device_id: string | null;
  disabled_by: string | null;
  hidden_by: string | null;
  entity_category: string | null;
}

export interface Registries {
  areas: AreaEntry[];
  devices: DeviceEntry[];
  entities: EntityEntry[];
}

export interface ResolvedScope {
  dashboards: string[];
  entities: Record<string, Permission>;
  sources: Record<string, string>;
}

const EXCLUDED_CATEGORIES = new Set(["config", "diagnostic"]);
const OPERABLE_DOMAINS = new Set(["light", "switch", "fan", "cover", "media_player", "climate", "humidifier", "vacuum"]);

export interface SelectableEntity {
  entityId: string;
  areaId: string | null;
  deviceId: string | null;
}

export function selectableEntities(registries: Registries): SelectableEntity[] {
  const deviceAreas = new Map(registries.devices.map((d) => [d.id, d.area_id]));
  const selectable: SelectableEntity[] = [];
  for (const entry of registries.entities) {
    if (entry.disabled_by !== null || entry.hidden_by !== null) continue;
    if (entry.entity_category !== null && EXCLUDED_CATEGORIES.has(entry.entity_category)) continue;
    const areaId = entry.area_id ?? (entry.device_id !== null ? deviceAreas.get(entry.device_id) : null) ?? null;
    selectable.push({ entityId: entry.entity_id, areaId, deviceId: entry.device_id });
  }
  return selectable;
}

export function resolveScope(definition: ScopeDefinition, registries: Registries): ResolvedScope {
  const knownAreas = new Set(registries.areas.map((a) => a.area_id));
  for (const areaId of Object.keys(definition.areas)) {
    if (!knownAreas.has(areaId)) throw new Error(`unknown area: ${areaId}`);
  }

  const entities: Record<string, Permission> = {};
  const sources: Record<string, string> = {};

  for (const { entityId, areaId } of selectableEntities(registries)) {
    if (areaId === null) continue;
    const permission = definition.areas[areaId];
    if (permission === undefined) continue;
    const domain = entityId.slice(0, entityId.indexOf("."));
    entities[entityId] = permission === "control" && OPERABLE_DOMAINS.has(domain) ? "control" : "view";
    sources[entityId] = `area:${areaId}`;
  }

  for (const [entityId, permission] of Object.entries(definition.entities)) {
    if (permission === "none") {
      delete entities[entityId];
      delete sources[entityId];
      continue;
    }
    entities[entityId] = permission;
    sources[entityId] = "entity";
  }

  return { dashboards: definition.dashboards, entities, sources };
}
