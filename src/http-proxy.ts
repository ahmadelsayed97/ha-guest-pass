import type { Config } from "./config.ts";

const HOP_BY_HOP_REQUEST_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
];

const GUEST_IDENTITY_HEADERS = [
  "authorization",
  "origin",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
];

const HOP_BY_HOP_RESPONSE_HEADERS = ["connection", "keep-alive", "transfer-encoding"];

const DECODED_BODY_HEADERS = ["content-encoding", "content-length"];

const STRIPPED_REQUEST_HEADERS = [...HOP_BY_HOP_REQUEST_HEADERS, ...GUEST_IDENTITY_HEADERS];
const STRIPPED_RESPONSE_HEADERS = [...HOP_BY_HOP_RESPONSE_HEADERS, ...DECODED_BODY_HEADERS];

export interface ForwardOptions {
  withToken: boolean;
}

export async function forwardToHA(req: Request, config: Config, opts: ForwardOptions): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(incoming.pathname + incoming.search, config.haUrl);

  const headers = new Headers(req.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  if (opts.withToken) headers.set("authorization", `Bearer ${config.haToken}`);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : null,
      redirect: "manual",
    });
  } catch {
    return new Response("Upstream unavailable", { status: 502 });
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
