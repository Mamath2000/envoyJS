import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EnvoyMqttService } from "../src/mqttService.js";

function createSilentLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
}

function createService(stateFilePath) {
  return new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      tableauElecEnabled: true,
      tableauElecTopic: "zigbee2mqtt/charge_ve",
      tableauElecPowerField: "power",
      tableauElecIndexField: "energy",
      tableauElecIndexUnit: "kwh",
      tableauElecStateFile: stateFilePath,
      tableauElecSign: 1,
      timeZoneName: "Europe/Paris",
      logLevel: "silent",
    },
    api: {},
    log: createSilentLog(),
  });
}

function readPersistedEnergyFromIndexWh(stateFilePath) {
  const raw = fs.readFileSync(stateFilePath, "utf-8");
  return JSON.parse(raw).energyFromIndexWh;
}

test("les sauvegardes non critiques sont throttlées, sauf appel forcé", () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-tableauelec-${Date.now()}-${Math.random()}.json`);

  try {
    const service = createService(stateFilePath);
    service.tableauElec.state.lastIndexWh = 100;
    service.tableauElec.state.energyFromIndexWh = 10;

    service.saveTableauElecStateToDisk(); // 1er appel: jamais throttlé (lastSavedAt initial = 0)
    assert.equal(readPersistedEnergyFromIndexWh(stateFilePath), 10);

    service.tableauElec.state.energyFromIndexWh = 20;
    service.saveTableauElecStateToDisk(); // non forcé, appelé immédiatement après: doit être ignoré
    assert.equal(readPersistedEnergyFromIndexWh(stateFilePath), 10);

    service.saveTableauElecStateToDisk(true); // forcé: doit écrire malgré le throttle
    assert.equal(readPersistedEnergyFromIndexWh(stateFilePath), 20);
  } finally {
    fs.rmSync(stateFilePath, { force: true });
    fs.rmSync(`${stateFilePath}.tmp`, { force: true });
  }
});

test("updateTableauElecIndexOffset ne throttle jamais les transitions de reset, seulement la progression normale", () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-tableauelec-${Date.now()}-${Math.random()}.json`);

  try {
    const service = createService(stateFilePath);

    service.updateTableauElecIndexOffset(1000); // baseline: force=true, doit écrire immédiatement
    assert.equal(fs.existsSync(stateFilePath), true);
    assert.equal(readPersistedEnergyFromIndexWh(stateFilePath), 0);

    service.updateTableauElecIndexOffset(1001); // delta normal: throttlé, appelé juste après la baseline
    assert.equal(service.tableauElec.state.energyFromIndexWh, 1); // état mémoire correct
    assert.equal(readPersistedEnergyFromIndexWh(stateFilePath), 0); // mais pas encore persisté (throttle)
  } finally {
    fs.rmSync(stateFilePath, { force: true });
    fs.rmSync(`${stateFilePath}.tmp`, { force: true });
  }
});
