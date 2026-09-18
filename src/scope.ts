export type Permission = "view" | "control";

export interface Scope {
  canView(entityId: string): boolean;
  canControl(entityId: string): boolean;
  canOpenDashboard(urlPath: string): boolean;
  entityIds(): string[];
  dashboards(): string[];
}

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const DASHBOARD_PATH = /^[a-z0-9_-]+$/;

export function isEntityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID.test(value);
}

export function parseScope(input: unknown): Scope {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("scope must be an object");
  }
  const { dashboards, entities } = input as Record<string, unknown>;

  if (!Array.isArray(dashboards)) throw new Error("scope.dashboards must be an array");
  const dashboardSet = new Set<string>();
  for (const path of dashboards) {
    if (typeof path !== "string" || !DASHBOARD_PATH.test(path)) throw new Error(`invalid dashboard path: ${path}`);
    dashboardSet.add(path);
  }

  if (typeof entities !== "object" || entities === null || Array.isArray(entities)) {
    throw new Error("scope.entities must be an object");
  }
  const permissions = new Map<string, Permission>();
  for (const [entityId, permission] of Object.entries(entities)) {
    if (!isEntityId(entityId)) throw new Error(`invalid entity id: ${entityId}`);
    if (permission !== "view" && permission !== "control") throw new Error(`invalid permission for ${entityId}`);
    permissions.set(entityId, permission);
  }
  if (permissions.size === 0 && dashboardSet.size === 0) throw new Error("scope is empty");

  return {
    canView: (id) => typeof id === "string" && permissions.has(id),
    canControl: (id) => typeof id === "string" && permissions.get(id) === "control",
    canOpenDashboard: (path) => typeof path === "string" && dashboardSet.has(path),
    entityIds: () => [...permissions.keys()],
    dashboards: () => [...dashboardSet],
  };
}

export async function loadScopeFile(path: string): Promise<Scope> {
  return parseScope(await Bun.file(path).json());
}
