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

test("deriveFullData corrige to_grid et economie avec offset positif", () => {
  const service = createService({ sign: 1 });
  service.tableauElec.state.currentPowerW = 200;
  service.tableauElec.state.lastIndexWh = 1_000_000;
  service.tableauElec.state.energyFromIndexWh = 1_000;

  const base = {
    conso_net_eim_wNow: 500,
    conso_all_eim_wNow: 1500,
    prod_eim_wNow: 1200,
    conso_net_eim_voltage: 230,

    conso_net_eim_whLifetime: 10_000,
    conso_net_eim_kwhLifetime: 10,
    conso_all_eim_whLifetime: 20_000,
    conso_all_eim_kwhLifetime: 20,

    grid_eim_whLifetime: 5_000,
    grid_eim_kwhLifetime: 5,
    prod_eim_whLifetime: 12_000,
    prod_eim_kwhLifetime: 12,
  };

  const out = service.deriveFullData(base);

  assert.equal(out.conso_net_eim_wNow, 700);
  assert.equal(out.conso_all_eim_wNow, 1700);

  assert.equal(out.conso_net_eim_whLifetime, 11_000);
  assert.equal(out.conso_all_eim_whLifetime, 21_000);
  assert.equal(out.grid_eim_whLifetime, 4_000);
  assert.equal(out.eco_eim_whLifetime, 8_000);

  assert.equal(out.conso_net_eim_kwhLifetime, 11);
  assert.equal(out.conso_all_eim_kwhLifetime, 21);
  assert.equal(out.grid_eim_kwhLifetime, 4);
  assert.equal(out.eco_eim_kwhLifetime, 8);

  assert.equal(out.tableau_elec_whOffset, 1_000);
});

test("deriveFullData corrige to_grid et economie avec offset negatif", () => {
  const service = createService({ sign: 1 });
  service.tableauElec.state.currentPowerW = -100;
  service.tableauElec.state.lastIndexWh = 2_000_000;
  service.tableauElec.state.energyFromIndexWh = -800;

  const base = {
    conso_net_eim_wNow: 300,
    conso_all_eim_wNow: 1300,
    prod_eim_wNow: 900,
    conso_net_eim_voltage: 230,

    conso_net_eim_whLifetime: 10_000,
    conso_net_eim_kwhLifetime: 10,
    conso_all_eim_whLifetime: 20_000,
    conso_all_eim_kwhLifetime: 20,

    grid_eim_whLifetime: 5_000,
    grid_eim_kwhLifetime: 5,
    prod_eim_whLifetime: 12_000,
    prod_eim_kwhLifetime: 12,
  };

  const out = service.deriveFullData(base);

  assert.equal(out.conso_net_eim_wNow, 200);
  assert.equal(out.conso_all_eim_wNow, 1200);

  assert.equal(out.conso_net_eim_whLifetime, 9_200);
  assert.equal(out.conso_all_eim_whLifetime, 19_200);
  assert.equal(out.grid_eim_whLifetime, 5_800);
  assert.equal(out.eco_eim_whLifetime, 6_200);

  assert.equal(out.conso_net_eim_kwhLifetime, 9.2);
  assert.equal(out.conso_all_eim_kwhLifetime, 19.2);
  assert.equal(out.grid_eim_kwhLifetime, 5.8);
  assert.equal(out.eco_eim_kwhLifetime, 6.2);

  assert.equal(out.tableau_elec_whOffset, -800);
});

test("deriveFullData n'ajoute pas les champs tableau_elec_* quand desactive", () => {
  const service = createService({ sign: 1 });
  service.tableauElec.enabled = false;
  service.tableauElec.state.currentPowerW = 200;
  service.tableauElec.state.lastIndexWh = 1_000_000;
  service.tableauElec.state.energyFromIndexWh = 1_000;

  const base = {
    conso_net_eim_wNow: 500,
    conso_all_eim_wNow: 1500,
    prod_eim_wNow: 1200,
    conso_net_eim_voltage: 230,
    grid_eim_whLifetime: 5_000,
    prod_eim_whLifetime: 12_000,
  };

  const out = service.deriveFullData(base);

  assert.equal(out.conso_net_eim_wNow, 500);
  assert.equal(out.tableau_elec_wNow, undefined);
  assert.equal(out.tableau_elec_whOffset, undefined);
});
