import { loadConfig } from "./config.ts";
import { consoleLogger } from "./log.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const server = createServer(config, { log: consoleLogger });
consoleLogger("info", "ha-guest-pass listening", {
  url: server.url.toString(),
  upstream: config.haUrl.origin,
});
