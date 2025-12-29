import { loadConfig } from "./config.js";
import { EnvoyApi } from "./envoyApi.js";
import { EnvoyMqttService } from "./mqttService.js";
import { createLogger } from "./logger.js";

async function main() {
  const config = loadConfig();

  const log = createLogger({ level: process.env.LOG_LEVEL ?? config.logLevel, component: "main" });

  const api = new EnvoyApi({
    username: config.username,
    password: config.password,
    serialNumber: config.serialNumber,
    envoyHost: config.localEnvoyUrl,
    insecureTls: config.envoyInsecureTls,
    timeoutMs: config.httpTimeoutMs,
    log: log.child("envoyApi"),
  });

  const service = new EnvoyMqttService({ config, api, log: log.child("service") });

  const shutdown = async (signal) => {
    log.info(`Signal ${signal} reçu, arrêt...`);
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await service.start();
}

main().catch((err) => {
  const log = createLogger({ level: process.env.LOG_LEVEL ?? "info", component: "main" });
  log.error("Erreur fatale", { message: err?.message ?? String(err), stack: err?.stack });
  process.exit(1);
});
