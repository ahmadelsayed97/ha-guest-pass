import { addonEnv } from "./addon.ts";
import { loadConfig } from "./config.ts";
import { tokenAuthenticator } from "./guest-auth.ts";
import { GuestStore } from "./guest-store.ts";
import { consoleLogger } from "./log.ts";
import { createServer } from "./server.ts";

const config = loadConfig(addonEnv() ?? process.env);
const store = await GuestStore.open(config.guestStoreFile, (error) => consoleLogger("error", "guest store write failed", { error: error.message }));
const auth = tokenAuthenticator(store, config.signingKey);
const server = createServer(config, { auth, store }, { log: consoleLogger });
consoleLogger("info", "ha-guest-pass listening", {
  url: server.url.toString(),
  upstream: config.haUrl.origin,
  guests: store.list().length,
});
