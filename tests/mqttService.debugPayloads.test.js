import test from "node:test";
import assert from "node:assert/strict";

import { EnvoyMqttService } from "../src/mqttService.js";

function createLog(level) {
  return {
    level,
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
}

function createService({ level, api = {} } = {}) {
  const service = new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      timeZoneName: "Europe/Paris",
      haAutodiscovery: false,
    },
    api,
    log: createLog(level),
  });

  const publishedTopics = [];
  service.publish = async (topic, payload) => {
    publishedTopics.push({ topic, payload });
  };

  return { service, publishedTopics };
}

test("publishDebugPayloads ne publie rien hors du niveau debug", async () => {
  const { service, publishedTopics } = createService({
    level: "info",
    api: { lastRawPayloads: { metersInfo: [{ eid: 1 }], metersReadings: [], consumptionReports: [], productionV1: {} } },
  });

  await service.publishDebugPayloads();

  assert.equal(publishedTopics.length, 0);
});

test("publishDebugPayloads republie chaque endpoint sur son propre sous-topic en mode debug", async () => {
  const { service, publishedTopics } = createService({
    level: "debug",
    api: {
      lastRawPayloads: {
        metersInfo: [{ eid: 704643328, measurementType: "production" }],
        metersReadings: [{ eid: 704643328, actEnergyDlvd: 123 }],
        consumptionReports: [{ reportType: "total-consumption", cumulative: { whDlvdCum: 456 } }],
        productionV1: { wattHoursToday: 789 },
      },
    },
  });

  await service.publishDebugPayloads();

  assert.equal(publishedTopics.length, 4);

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/debug/meters_info"], JSON.stringify([{ eid: 704643328, measurementType: "production" }]));
  assert.equal(byTopic["envoy/123456789/debug/meters_readings"], JSON.stringify([{ eid: 704643328, actEnergyDlvd: 123 }]));
  assert.equal(
    byTopic["envoy/123456789/debug/consumption_reports"],
    JSON.stringify([{ reportType: "total-consumption", cumulative: { whDlvdCum: 456 } }]),
  );
  assert.equal(byTopic["envoy/123456789/debug/production_v1"], JSON.stringify({ wattHoursToday: 789 }));
});

test("publishDebugPayloads republie le dernier payload brut du capteur général quand disponible", async () => {
  const { service, publishedTopics } = createService({
    level: "debug",
    api: { lastRawPayloads: {} },
  });

  service.generalMeter.state.lastRawPayload = '{"power":128,"energy":4770.36,"produced_energy":7.42}';

  await service.publishDebugPayloads();

  const generalMeterPublish = publishedTopics.find((p) => p.topic === "envoy/123456789/debug/general_meter");
  assert.equal(generalMeterPublish?.payload, '{"power":128,"energy":4770.36,"produced_energy":7.42}');
});

test("publishDebugPayloads n'envoie pas general_meter si aucun payload n'a encore ete recu", async () => {
  const { service, publishedTopics } = createService({
    level: "debug",
    api: { lastRawPayloads: {} },
  });

  await service.publishDebugPayloads();

  const generalMeterPublish = publishedTopics.find((p) => p.topic === "envoy/123456789/debug/general_meter");
  assert.equal(generalMeterPublish, undefined);
});
