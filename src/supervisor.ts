export const SUPERVISOR_ADDRESS = "172.30.32.2";
export const HOST_ADDRESS_ON_SUPERVISOR_NETWORK = "172.30.32.1";
const SUPERVISOR_URL = "http://supervisor";

export async function fetchIngressPort(token: string, baseUrl = SUPERVISOR_URL): Promise<number | null> {
  try {
    const res = await fetch(new URL("/addons/self/info", baseUrl), { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { ingress_port?: unknown } };
    const port = body.data?.ingress_port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}
