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

function createService({ sign = 1 } = {}) {
  const service = new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      tableauElecEnabled: true,
      tableauElecTopic: "zigbee2mqtt/charge_ve",
      tableauElecPowerField: "power",
      tableauElecIndexField: "energy",
      tableauElecIndexUnit: "kwh",
      tableauElecStateFile: "data/tableau-elec-state.test.json",
      tableauElecSign: sign,
      timeZoneName: "Europe/Paris",
      logLevel: "silent",
    },
    api: {},
    log: createSilentLog(),
  });

  return service;
}

test("deriveFullData corrige conso_net/conso_all avec offset positif", () => {
  const service = createService({ sign: 1 });
  service.tableauElec.state.currentPowerW = 200;
  service.tableauElec.state.lastIndexWh = 1_000_000;
  service.tableauElec.state.energyFromIndexWh = 1_000;

  const base = {
    "conso_net/wNow": 500,
    "conso_all/wNow": 1500,
    "prod/wNow": 1200,
    "conso_net/voltage": 230,

    "conso_net/whLifetime": 10_000,
    "conso_all/whLifetime": 20_000,

    "prod/whLifetime": 12_000,
  };

  const out = service.deriveFullData(base);

  assert.equal(out["conso_net/wNow"], 700);
  assert.equal(out["conso_all/wNow"], 1700);

  assert.equal(out["conso_net/whLifetime"], 11_000);
  assert.equal(out["conso_all/whLifetime"], 21_000);

  assert.equal(out["tableau_ext/whOffset"], 1_000);
});

test("deriveFullData corrige conso_net/conso_all avec offset negatif", () => {
  const service = createService({ sign: 1 });
  service.tableauElec.state.currentPowerW = -100;
  service.tableauElec.state.lastIndexWh = 2_000_000;
  service.tableauElec.state.energyFromIndexWh = -800;

  const base = {
    "conso_net/wNow": 300,
    "conso_all/wNow": 1300,
    "prod/wNow": 900,
    "conso_net/voltage": 230,

    "conso_net/whLifetime": 10_000,
    "conso_all/whLifetime": 20_000,

    "prod/whLifetime": 12_000,
  };

  const out = service.deriveFullData(base);

  assert.equal(out["conso_net/wNow"], 200);
  assert.equal(out["conso_all/wNow"], 1200);

  assert.equal(out["conso_net/whLifetime"], 9_200);
  assert.equal(out["conso_all/whLifetime"], 19_200);

  assert.equal(out["tableau_ext/whOffset"], -800);
});

test("deriveFullData n'ajoute pas les champs tableau_ext/* quand desactive", () => {
  const service = createService({ sign: 1 });
  service.tableauElec.enabled = false;
  service.tableauElec.state.currentPowerW = 200;
  service.tableauElec.state.lastIndexWh = 1_000_000;
  service.tableauElec.state.energyFromIndexWh = 1_000;

  const base = {
    "conso_net/wNow": 500,
    "conso_all/wNow": 1500,
    "prod/wNow": 1200,
    "conso_net/voltage": 230,
    "prod/whLifetime": 12_000,
  };

  const out = service.deriveFullData(base);

  assert.equal(out["conso_net/wNow"], 500);
  assert.equal(out["tableau_ext/wNow"], undefined);
  assert.equal(out["tableau_ext/whOffset"], undefined);
});
