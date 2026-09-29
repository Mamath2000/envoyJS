import test from "node:test";
import assert from "node:assert/strict";

import { EnvoyMqttService } from "../src/mqttService.js";

function createLog() {
  return {
    level: "info",
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
}

function createService({ api = {}, configOverrides = {} } = {}) {
  const service = new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      timeZoneName: "Europe/Paris",
      haAutodiscovery: false,
      ...configOverrides,
    },
    api,
    log: createLog(),
  });

  const publishedTopics = [];
  service.publish = async (topic, payload) => {
    publishedTopics.push({ topic, payload });
  };

  return { service, publishedTopics };
}

test("recordPollSuccess réinitialise consecutiveFailures/lastError et fixe lastSuccessAt", () => {
  const { service } = createService();
  service.health.consecutiveFailures = 4;
  service.health.lastError = "boom";

  const before = Date.now();
  service.recordPollSuccess();

  assert.equal(service.health.consecutiveFailures, 0);
  assert.equal(service.health.lastError, undefined);
  assert.equal(service.health.lastSuccessAt >= before, true);
});

test("recordPollFailure incrémente consecutiveFailures et mémorise le message d'erreur", () => {
  const { service } = createService();

  service.recordPollFailure(new Error("Envoy injoignable"));
  assert.equal(service.health.consecutiveFailures, 1);
  assert.equal(service.health.lastError, "Envoy injoignable");

  service.recordPollFailure(new Error("toujours en panne"));
  assert.equal(service.health.consecutiveFailures, 2);
  assert.equal(service.health.lastError, "toujours en panne");
});

test("publishHealth publie consecutive_failures/problem/last_error, problem reste OFF sous le seuil", async () => {
  const { service, publishedTopics } = createService({ configOverrides: { healthFailureThreshold: 3 } });
  service.health.consecutiveFailures = 2;
  service.health.lastError = "timeout";

  await service.publishHealth();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/data/health/consecutive_failures"], "2");
  assert.equal(byTopic["envoy/123456789/data/health/problem"], "OFF");
  assert.equal(byTopic["envoy/123456789/data/health/last_error"], "timeout");
  assert.equal(byTopic["envoy/123456789/data/health/last_success_ts"], undefined);
});

test("publishHealth passe problem à ON dès que consecutiveFailures atteint le seuil configuré", async () => {
  const { service, publishedTopics } = createService({ configOverrides: { healthFailureThreshold: 2 } });
  service.health.consecutiveFailures = 2;

  await service.publishHealth();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/data/health/problem"], "ON");
});

test("publishHealth applique le seuil par défaut (3) quand healthFailureThreshold n'est pas configuré", async () => {
  const { service, publishedTopics } = createService();
  service.health.consecutiveFailures = 2;
  await service.publishHealth();
  let byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/data/health/problem"], "OFF");

  publishedTopics.length = 0;
  service.health.consecutiveFailures = 3;
  await service.publishHealth();
  byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/data/health/problem"], "ON");
});

test("publishHealth publie last_success_ts (figé) une fois qu'un succès a eu lieu, et réinitialise last_error à 'none'", async () => {
  const { service, publishedTopics } = createService();
  service.recordPollSuccess();

  await service.publishHealth();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  const ts = Number(byTopic["envoy/123456789/data/health/last_success_ts"]);
  assert.equal(Number.isFinite(ts), true);
  assert.equal(Math.abs(ts - Math.floor(Date.now() / 1000)) <= 2, true);
  assert.equal(byTopic["envoy/123456789/data/health/last_error"], "none");
});

test("publishFullLoop: un cycle réussi remet la santé à zéro (problem=OFF)", async () => {
  const { service, publishedTopics } = createService({
    configOverrides: { pollingIntervalMs: 1 },
    api: {
      getAllEnvoyData: async () => {
        service.running = false;
        return {};
      },
    },
  });
  service.running = true;

  await service.publishFullLoop();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/data/health/consecutive_failures"], "0");
  assert.equal(byTopic["envoy/123456789/data/health/problem"], "OFF");
});

test("publishFullLoop: un cycle en échec incrémente consecutive_failures et mémorise last_error", async () => {
  const { service, publishedTopics } = createService({
    configOverrides: { pollingIntervalMs: 1 },
    api: {
      getAllEnvoyData: async () => {
        service.running = false;
        throw new Error("Envoy indisponible");
      },
    },
  });
  service.running = true;

  await service.publishFullLoop();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/data/health/consecutive_failures"], "1");
  assert.equal(byTopic["envoy/123456789/data/health/last_error"], "Envoy indisponible");
});
