import { loadConfig } from "./config.js";
import { EnvoyApi } from "./envoyApi.js";
import { EnvoyMqttService } from "./mqttService.js";

async function main() {
  const config = loadConfig();

  const api = new EnvoyApi({
    username: config.username,
    password: config.password,
    serialNumber: config.serialNumber,
    envoyHost: config.localEnvoyUrl,
    insecureTls: config.envoyInsecureTls,
    timeoutMs: config.httpTimeoutMs,
  });

  const service = new EnvoyMqttService({ config, api });

  const shutdown = async (signal) => {
    console.log(`Signal ${signal} reçu, arrêt...`);
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await service.start();
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
