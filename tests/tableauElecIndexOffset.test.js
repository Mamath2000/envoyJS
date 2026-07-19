import test from "node:test";
import assert from "node:assert/strict";

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

function createService() {
  return new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      tableauElecEnabled: true,
      tableauElecTopic: "zigbee2mqtt/charge_ve",
      tableauElecPowerField: "power",
      tableauElecIndexField: "energy",
      tableauElecIndexUnit: "kwh",
      tableauElecStateFile: "data/tableau-elec-state.test.json",
      tableauElecSign: 1,
      timeZoneName: "Europe/Paris",
      logLevel: "silent",
    },
    api: {},
    log: createSilentLog(),
  });
}

test("un payload glitché (0) isolé n'altère pas l'offset accumulé", () => {
  const service = createService();
  // Empêche l'écriture disque pendant le test.
  service.saveTableauElecStateToDisk = () => {};

  service.updateTableauElecIndexOffset(1000); // baseline initiale
  service.updateTableauElecIndexOffset(1001); // delta normal +1

  assert.equal(service.tableauElec.state.energyFromIndexWh, 1);

  service.updateTableauElecIndexOffset(0); // glitch: candidat de reset, non committé
  assert.equal(service.tableauElec.state.energyFromIndexWh, 1);
  assert.equal(service.tableauElec.state.lastIndexWh, 1001);
  assert.equal(service.tableauElec.state.pendingResetCount, 1);

  service.updateTableauElecIndexOffset(1002); // retour à la trajectoire normale: glitch ignoré
  assert.equal(service.tableauElec.state.energyFromIndexWh, 2);
  assert.equal(service.tableauElec.state.lastIndexWh, 1002);
  assert.equal(service.tableauElec.state.pendingResetCount, 0);
  assert.equal(service.tableauElec.state.pendingResetIndexWh, undefined);
});

test("un remplacement de capteur n'est committé qu'apres 3 lectures consecutives confirmees", () => {
  const service = createService();
  service.saveTableauElecStateToDisk = () => {};

  service.tableauElec.state.lastIndexWh = 32_323_000;
  service.tableauElec.state.energyFromIndexWh = 3_000_000;

  service.updateTableauElecIndexOffset(0); // 1ere lecture basse: candidat #1
  assert.equal(service.tableauElec.state.pendingResetCount, 1);
  assert.equal(service.tableauElec.state.energyFromIndexWh, 3_000_000);
  assert.equal(service.tableauElec.state.lastIndexWh, 32_323_000);

  service.updateTableauElecIndexOffset(500); // 2eme lecture: pas encore committé
  assert.equal(service.tableauElec.state.pendingResetCount, 2);
  assert.equal(service.tableauElec.state.energyFromIndexWh, 3_000_000);
  assert.equal(service.tableauElec.state.lastIndexWh, 32_323_000);

  service.updateTableauElecIndexOffset(1000); // 3eme lecture: reset confirmé et committé
  assert.equal(service.tableauElec.state.energyFromIndexWh, 3_001_000);
  assert.equal(service.tableauElec.state.lastIndexWh, 1000);
  assert.equal(service.tableauElec.state.pendingResetCount, 0);
  assert.equal(service.tableauElec.state.pendingResetIndexWh, undefined);
});

test("une baisse instable entre deux candidats redemarre la fenetre de confirmation", () => {
  const service = createService();
  service.saveTableauElecStateToDisk = () => {};

  service.tableauElec.state.lastIndexWh = 1000;
  service.tableauElec.state.energyFromIndexWh = 500;

  service.updateTableauElecIndexOffset(100); // candidat #1
  assert.equal(service.tableauElec.state.pendingResetCount, 1);
  assert.equal(service.tableauElec.state.pendingResetIndexWh, 100);

  service.updateTableauElecIndexOffset(50); // continue de baisser: fenetre redemarrée
  assert.equal(service.tableauElec.state.pendingResetCount, 1);
  assert.equal(service.tableauElec.state.pendingResetIndexWh, 50);
  assert.equal(service.tableauElec.state.energyFromIndexWh, 500);
});
