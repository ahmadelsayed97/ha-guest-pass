import { isEntityId, type Permission } from "./scope.ts";

export interface ScopeDefinition {
  dashboards: string[];
  areas: Record<string, Permission>;
  entities: Record<string, Permission | "none">;
}

const DASHBOARD_PATH = /^[a-z0-9_-]+$/;
const AREA_ID = /^[a-z0-9_]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseScopeDefinition(input: unknown): ScopeDefinition {
  if (!isRecord(input)) throw new Error("scope definition must be an object");

  if (!Array.isArray(input.dashboards)) throw new Error("dashboards must be an array");
  const dashboards: string[] = [];
  for (const path of input.dashboards) {
    if (typeof path !== "string" || !DASHBOARD_PATH.test(path)) throw new Error(`invalid dashboard path: ${path}`);
    dashboards.push(path);
  }

  const areas: Record<string, Permission> = {};
  if (input.areas !== undefined) {
    if (!isRecord(input.areas)) throw new Error("areas must be an object");
    for (const [areaId, permission] of Object.entries(input.areas)) {
      if (!AREA_ID.test(areaId)) throw new Error(`invalid area id: ${areaId}`);
      if (permission !== "view" && permission !== "control") throw new Error(`invalid permission for area ${areaId}`);
      areas[areaId] = permission;
    }
  }

  const entities: Record<string, Permission | "none"> = {};
  if (input.entities !== undefined) {
    if (!isRecord(input.entities)) throw new Error("entities must be an object");
    for (const [entityId, permission] of Object.entries(input.entities)) {
      if (!isEntityId(entityId)) throw new Error(`invalid entity id: ${entityId}`);
      if (permission !== "view" && permission !== "control" && permission !== "none") {
        throw new Error(`invalid permission for ${entityId}`);
      }
      entities[entityId] = permission;
    }
  }

  if (Object.keys(areas).length === 0 && Object.keys(entities).length === 0) throw new Error("scope definition grants nothing");
  return { dashboards, areas, entities };
}
