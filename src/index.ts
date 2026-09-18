import { loadConfig } from "./config.ts";
import { sharedSecretAuthenticator } from "./guest-auth.ts";
import { consoleLogger } from "./log.ts";
import { loadScopeFile } from "./scope.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const scope = await loadScopeFile(config.scopeFile);
const server = createServer(config, sharedSecretAuthenticator(config.guestSecret, scope), { log: consoleLogger });
consoleLogger("info", "ha-guest-pass listening", {
  url: server.url.toString(),
  upstream: config.haUrl.origin,
  entities: scope.entityIds().length,
  dashboards: scope.dashboards(),
});
