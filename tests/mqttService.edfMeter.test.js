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

function createService({ enabled = true } = {}) {
  const service = new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      timeZoneName: "Europe/Paris",
      haAutodiscovery: false,
      edfMeterEnabled: enabled,
      edfMeterTopic: "teleinfo/022061153159",
      edfMeterIndexField: "EAST.value",
    },
    api: {},
    log: createSilentLog(),
  });

  return service;
}

test("updateEdfMeterImport extrait EAST.value depuis un payload teleinfo reel", () => {
  const service = createService();
  const payload = JSON.stringify({ EAST: { raw: "064477430", value: 64_477_430 } });

  service.updateEdfMeterImport(payload);

  assert.equal(service.edfMeter.state.lastImportWh, 64_477_430);
});

test("updateEdfMeterImport ignore une baisse isolee et garde la derniere valeur connue", () => {
  const service = createService();

  service.updateEdfMeterImport(JSON.stringify({ EAST: { value: 64_477_430 } }));
  service.updateEdfMeterImport(JSON.stringify({ EAST: { value: 0 } })); // frame corrompu

  assert.equal(service.edfMeter.state.lastImportWh, 64_477_430);
});

test("updateEdfMeterImport accepte une progression normale", () => {
  const service = createService();

  service.updateEdfMeterImport(JSON.stringify({ EAST: { value: 64_477_430 } }));
  service.updateEdfMeterImport(JSON.stringify({ EAST: { value: 64_477_500 } }));

  assert.equal(service.edfMeter.state.lastImportWh, 64_477_500);
});

test("updateEdfMeterImport ignore un payload illisible sans planter", () => {
  const service = createService();

  service.updateEdfMeterImport("pas du json");

  assert.equal(service.edfMeter.state.lastImportWh, undefined);
});

test("getExternalCorrections expose edfImportWhLifetime quand actif", () => {
  const service = createService();
  service.edfMeter.state.lastImportWh = 12_345;

  const correction = service.getExternalCorrections();

  assert.equal(correction.edfImportWhLifetime, 12_345);
});

test("getExternalCorrections n'expose pas edfImportWhLifetime quand desactive", () => {
  const service = createService({ enabled: false });
  service.edfMeter.state.lastImportWh = 12_345; // ne devrait jamais arriver en pratique, mais on verifie le garde-fou

  const correction = service.getExternalCorrections();

  assert.equal(correction.edfImportWhLifetime, undefined);
});

test("deriveFullData integre edf_import/eco_edf/togrid_edf via getExternalCorrections", () => {
  const service = createService();
  service.edfMeter.state.lastImportWh = 15_000;

  const out = service.deriveFullData({
    conso_all_eim_whLifetime: 20_000,
    prod_eim_whLifetime: 12_000,
  });

  assert.equal(out.edf_import_whLifetime, 15_000);
  assert.equal(out.eco_edf_whLifetime, 5_000);
  assert.equal(out.togrid_edf_whLifetime, 7_000);
});

test("dailySensors inclut bien les nouveaux capteurs EDF pour le rollover _00h/_today/_yesterday", () => {
  const service = createService();

  assert.ok(service.dailySensors.includes("edf_import_whLifetime"));
  assert.ok(service.dailySensors.includes("eco_edf_whLifetime"));
  assert.ok(service.dailySensors.includes("togrid_edf_whLifetime"));
});
