import test from "node:test";
import assert from "node:assert/strict";

import { deriveEnvoyFields } from "../src/envoyDerivedFields.js";

test("deriveEnvoyFields sans correction calcule grid/eco a partir des champs bruts", () => {
  const base = {
    conso_net_eim_wNow: -400,
    conso_all_eim_wNow: 1300,
    prod_eim_wNow: 1200,
    conso_net_eim_voltage: 230,
    grid_eim_whLifetime: 5_000,
    grid_eim_kwhLifetime: 5,
    prod_eim_whLifetime: 12_000,
    prod_eim_kwhLifetime: 12,
  };

  const out = deriveEnvoyFields(base);

  assert.equal(out.conso_net_eim_wNow, -400);
  assert.equal(out.grid_eim_wNow, 400);
  assert.equal(out.grid_eim_wNow_binary, 0);
  assert.equal(out.eco_eim_wNow, 800);
  assert.equal(out.eco_eim_whLifetime, 7_000);
  assert.equal(out.eco_eim_kwhLifetime, 7);
});

test("deriveEnvoyFields avec correction positive decale la puissance et l'energie", () => {
  const base = {
    conso_net_eim_wNow: 500,
    conso_all_eim_wNow: 1500,
    prod_eim_wNow: 1200,
    conso_net_eim_voltage: 230,
    grid_eim_whLifetime: 5_000,
    grid_eim_kwhLifetime: 5,
    prod_eim_whLifetime: 12_000,
    prod_eim_kwhLifetime: 12,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 200, energyOffsetWh: 1_000 });

  assert.equal(out.conso_net_eim_wNow, 700);
  assert.equal(out.grid_eim_wNow, 0);
  assert.equal(out.grid_eim_wNow_binary, 1);
  assert.equal(out.eco_eim_wNow, 1200);
  assert.equal(out.grid_eim_whLifetime, 4_000);
  assert.equal(out.eco_eim_whLifetime, 8_000);
});

test("deriveEnvoyFields clampe a 0 quand l'offset depasse le grid_eim_whLifetime", () => {
  const base = {
    conso_net_eim_wNow: 100,
    grid_eim_whLifetime: 500,
    grid_eim_kwhLifetime: 0.5,
    prod_eim_whLifetime: 12_000,
    prod_eim_kwhLifetime: 12,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 0, energyOffsetWh: 2_000 });

  assert.equal(out.grid_eim_whLifetime, 0);
  assert.equal(out.grid_eim_kwhLifetime, 0);
  assert.equal(out.eco_eim_whLifetime, 12_000);
});

test("deriveEnvoyFields recalcule le courant via I = P / U", () => {
  const base = {
    conso_net_eim_wNow: 460,
    conso_net_eim_voltage: 230,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 230 });

  assert.equal(out.conso_net_eim_wNow, 690);
  assert.equal(out.conso_net_eim_current, 3);
});
