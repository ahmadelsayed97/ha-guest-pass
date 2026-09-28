import { addonEnv } from "./addon.ts";
import { loadConfig } from "./config.ts";
import { tokenAuthenticator } from "./guest-auth.ts";
import { GuestStore } from "./guest-store.ts";
import { consoleLogger } from "./log.ts";
import { createServer, type IngressOptions } from "./server.ts";
import { fetchIngressPort, HOST_ADDRESS_ON_SUPERVISOR_NETWORK, SUPERVISOR_ADDRESS } from "./supervisor.ts";

const addon = addonEnv();
const config = loadConfig(addon?.env ?? process.env);
const store = await GuestStore.open(config.guestStoreFile, (error) => consoleLogger("error", "guest store write failed", { error: error.message }));
const auth = tokenAuthenticator(store, config.signingKey);

async function ingressOptions(): Promise<IngressOptions | undefined> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!addon || !token) return undefined;
  const port = await fetchIngressPort(token);
  if (!port) {
    consoleLogger("warn", "ingress port unavailable; the admin page needs the admin secret");
    return undefined;
  }
  return { hostname: HOST_ADDRESS_ON_SUPERVISOR_NETWORK, port, supervisorAddress: SUPERVISOR_ADDRESS };
}

const ingress = await ingressOptions();
const proxy = createServer(config, { auth, store }, { log: consoleLogger, ingress });
if (addon?.adminSecretGenerated && !ingress) {
  consoleLogger("info", `admin secret for this add-on: ${config.adminSecret}`);
}
consoleLogger("info", "ha-guest-pass listening", {
  url: proxy.server.url.toString(),
  ingress: proxy.ingress?.url.toString() ?? null,
  upstream: config.haUrl.origin,
  guests: store.list().length,
});
