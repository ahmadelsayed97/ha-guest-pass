import { join } from "node:path";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

function serve(name: string, contentType: string, status = 200): Response {
  return new Response(Bun.file(join(PUBLIC_DIR, name)), {
    status,
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}

export function page(name: string, status = 200): Response {
  return serve(name, "text/html; charset=utf-8", status);
}

export function script(name: string): Response {
  return serve(name, "application/javascript; charset=utf-8");
}
