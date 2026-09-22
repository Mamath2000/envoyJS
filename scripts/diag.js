import mqtt from "mqtt";

import { loadConfig } from "../src/config.js";
import { EnvoyApi } from "../src/envoyApi.js";
import { createLogger } from "../src/logger.js";

// Diagnostique chaque service externe appelé par le programme (MQTT, Envoy
// local) indépendamment, sans jamais lancer la boucle principale ni
// solliciter le cloud Enphase (Enlighten/Entrez) — un login cloud raté
// déclenche un backoff pouvant aller jusqu'à 30min côté service (voir
// envoyApi.js), donc ce script ne doit surtout pas en ajouter un de plus.
//
// Le token d'accès Envoy est récupéré via une requête/réponse MQTT ponctuelle
// (topic debug/access_token/request -> debug/access_token, jamais retained,
// voir EnvoyMqttService.handleAccessTokenRequest): le service principal doit
// être en train de tourner avec un token valide pour répondre. Sans ça, les
// tests Envoy local sont marqués SKIP.

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const TOKEN_WAIT_MS = 3000;
const GENERAL_METER_WAIT_MS = 5000;

const isTty = process.stdout.isTTY;
const color = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m" };
const c = (code, text) => (isTty ? `${code}${text}${color.reset}` : text);

const results = [];

async function step(name, fn, { skip } = {}) {
  if (skip) {
    console.log(`${c(color.yellow, "SKIP")} ${name} — ${skip}`);
    results.push({ name, status: "SKIP", detail: skip });
    return { ok: false, skipped: true };
  }

  const start = Date.now();
  try {
    const detail = await fn();
    const durationMs = Date.now() - start;
    console.log(`${c(color.green, "OK  ")} ${name} ${c(color.dim, `(${durationMs}ms)`)}${detail ? ` — ${detail}` : ""}`);
    results.push({ name, status: "OK", durationMs, detail });
    return { ok: true, detail };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err?.message ?? String(err);
    console.log(`${c(color.red, "FAIL")} ${name} ${c(color.dim, `(${durationMs}ms)`)} — ${message}`);
    results.push({ name, status: "FAIL", durationMs, message });
    return { ok: false, error: err };
  }
}

function section(title) {
  console.log(c(color.bold, `\n-- ${title} --`));
}

async function main() {
  console.log(c(color.bold, "=== envoyJS — diagnostic des services ===\n"));

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.log(`${c(color.red, "FAIL")} Configuration — ${err?.message ?? String(err)}`);
    process.exit(1);
  }
  const prodMqttHost = process.env.PROD_MQTT_HOST?.trim();
  const mqttHost = prodMqttHost || config.mqttHost;
  const mqttHostSource = prodMqttHost ? "PROD_MQTT_HOST" : "mqtt.host (config.yaml)";

  console.log(
    `config OK — serial=${config.serialNumber} envoy=${config.localEnvoyUrl} mqtt=${mqttHost}:${config.mqttPort} (source: ${mqttHostSource})`,
  );

  const log = createLogger({ level: VERBOSE ? "debug" : "error", component: "diag" });
  const api = new EnvoyApi({
    username: config.username,
    password: config.password,
    serialNumber: config.serialNumber,
    envoyHost: config.localEnvoyUrl,
    insecureTls: config.envoyInsecureTls,
    timeoutMs: config.httpTimeoutMs,
    log,
  });

  const topicDebug = `${config.mqttBaseTopic}/${config.serialNumber}/debug`;
  const topicAccessToken = `${topicDebug}/access_token`;
  const topicAccessTokenRequest = `${topicAccessToken}/request`;
  const mqttUrl = `mqtt://${mqttHost}:${config.mqttPort}`;

  section("MQTT");

  let mqttClient;
  const connectResult = await step(`MQTT — connexion (${mqttUrl})`, async () => {
    mqttClient = mqtt.connect(mqttUrl, {
      username: config.mqttUsername,
      password: config.mqttPassword,
      reconnectPeriod: 0,
      connectTimeout: 8000,
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout de connexion (8s)")), 8000);
      mqttClient.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
      mqttClient.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    return "connecté";
  });

  let tokenSnapshot;
  const tokenResult = await step(
    `MQTT — demande du token d'accès Envoy au service (${topicAccessTokenRequest})`,
    async () => {
      const raw = await new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`pas de réponse en ${TOKEN_WAIT_MS}ms — le service principal ne semble pas actif sur ce broker`)),
          TOKEN_WAIT_MS,
        );
        mqttClient.subscribe(topicAccessToken, (err) => {
          if (err) {
            clearTimeout(t);
            reject(err);
            return;
          }
          mqttClient.publish(topicAccessTokenRequest, "1", { retain: false });
        });
        mqttClient.once("message", (_topic, payload) => {
          clearTimeout(t);
          resolve(payload.toString());
        });
      });

      const parsed = JSON.parse(raw);
      if (parsed?.error) throw new Error(parsed.error);
      if (!parsed?.token || !Number.isFinite(parsed?.expiresAt)) {
        throw new Error("réponse invalide (token/expiresAt manquant)");
      }
      if (parsed.expiresAt <= Date.now()) {
        throw new Error(`token expiré depuis ${new Date(parsed.expiresAt).toISOString()} — relance le service principal`);
      }

      tokenSnapshot = { authToken: parsed.token, tokenExpiresAt: parsed.expiresAt };
      return `valide jusqu'à ${new Date(parsed.expiresAt).toISOString()}`;
    },
    { skip: connectResult.ok ? undefined : "MQTT non connecté" },
  );

  if (tokenSnapshot) api.restoreAuthSnapshot(tokenSnapshot);
  const envoySkipReason = tokenSnapshot ? undefined : "pas de token d'accès disponible (voir étape précédente)";

  section("Envoy (local)");

  await step(
    "Envoy local — /ivp/meters (mapping compteurs)",
    async () => {
      const info = await api.getMetersInfo({ debug: false });
      const n = Object.keys(info).length;
      if (n === 0) throw new Error("réponse vide ou mapping production/net-consumption introuvable");
      return `${n} compteur(s) mappé(s)`;
    },
    { skip: envoySkipReason },
  );

  await step(
    "Envoy local — /ivp/meters/readings",
    async () => {
      const readings = await api.makeRequest("/ivp/meters/readings", { debug: false });
      if (!Array.isArray(readings) || readings.length === 0) throw new Error("réponse vide");
      return `${readings.length} entrée(s)`;
    },
    { skip: envoySkipReason },
  );

  await step(
    "Envoy local — /ivp/meters/reports/consumption",
    async () => {
      const reports = await api.makeRequest("/ivp/meters/reports/consumption", { debug: false });
      if (!Array.isArray(reports) || reports.length === 0) throw new Error("réponse vide");
      return `${reports.length} rapport(s)`;
    },
    { skip: envoySkipReason },
  );

  await step(
    "Envoy local — /api/v1/production",
    async () => {
      const data = await api.getProductionV1({ debug: false });
      if (!data || typeof data.wattHoursToday !== "number") throw new Error("champ wattHoursToday manquant");
      return `wattHoursToday=${data.wattHoursToday}`;
    },
    { skip: envoySkipReason },
  );

  section("MQTT — publication");

  await step(
    "MQTT — publish test",
    async () => {
      const topic = `${topicDebug}/diag_test`;
      await new Promise((resolve, reject) => {
        mqttClient.publish(topic, new Date().toISOString(), { retain: false }, (err) => (err ? reject(err) : resolve()));
      });
      return `publié sur ${topic}`;
    },
    { skip: connectResult.ok ? undefined : "MQTT non connecté" },
  );

  const generalTopic = config.generalMeterTopic;
  await step(
    `MQTT — capteur général (écoute ${GENERAL_METER_WAIT_MS}ms sur ${generalTopic || "?"})`,
    async () => {
      const message = await new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`aucun message reçu en ${GENERAL_METER_WAIT_MS}ms`)),
          GENERAL_METER_WAIT_MS,
        );
        mqttClient.subscribe(generalTopic, (err) => {
          if (err) {
            clearTimeout(t);
            reject(err);
          }
        });
        mqttClient.once("message", (_topic, payload) => {
          clearTimeout(t);
          resolve(payload.toString().slice(0, 120));
        });
      });
      return `message reçu: ${message}`;
    },
    { skip: !connectResult.ok ? "MQTT non connecté" : !generalTopic ? "non configuré (sensors.general_meter.topic absent)" : undefined },
  );

  if (mqttClient) await new Promise((resolve) => mqttClient.end(true, {}, resolve));

  console.log(c(color.bold, "\n=== Résumé ==="));
  const oks = results.filter((r) => r.status === "OK");
  const skips = results.filter((r) => r.status === "SKIP");
  const fails = results.filter((r) => r.status === "FAIL");
  console.log(`${oks.length} OK, ${skips.length} SKIP, ${fails.length} FAIL`);

  if (fails.length) {
    console.log(c(color.red, "\nÉchecs:"));
    for (const f of fails) console.log(`  - ${f.name}: ${f.message}`);
  }

  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(c(color.red, "Erreur fatale du diagnostic:"), err?.message ?? String(err));
  if (VERBOSE) console.error(err?.stack);
  process.exit(1);
});
