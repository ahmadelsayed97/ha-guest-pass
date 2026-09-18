import { isEntityId } from "./scope.ts";

export type RequestKind = "static" | "deny" | { entityId: string };

const STATIC_FILES = new Set(["/manifest.json", "/service_worker.js", "/sw-modern.js", "/sw-legacy.js"]);
const STATIC_PREFIXES = ["/frontend_latest/", "/frontend_es5/", "/static/", "/local/", "/hacsfiles/"];
const ENTITY_API_ROUTES: Array<{ prefix: string; trailing: boolean }> = [
  { prefix: "/api/camera_proxy/", trailing: false },
  { prefix: "/api/media_player_proxy/", trailing: false },
  { prefix: "/api/image/serve/", trailing: true },
];

export function classifyRequest(method: string, path: string, isDashboard: (urlPath: string) => boolean): RequestKind {
  if (method !== "GET" && method !== "HEAD") return "deny";
  if (!isCleanPath(path)) return "deny";

  if (path === "/" || STATIC_FILES.has(path)) return "static";
  if (STATIC_PREFIXES.some((prefix) => path.startsWith(prefix))) return "static";

  const first = path.split("/")[1];
  if (first && isDashboard(first)) return "static";

  for (const route of ENTITY_API_ROUTES) {
    if (!path.startsWith(route.prefix)) continue;
    const [entityId, ...remainder] = path.slice(route.prefix.length).split("/");
    if (!isEntityId(entityId)) return "deny";
    if (route.trailing ? remainder.length === 0 : remainder.length > 0) return "deny";
    return { entityId };
  }

  return "deny";
}

function isCleanPath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("//")) return false;
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded === "." || decoded === "..") return false;
  }
  return true;
}
