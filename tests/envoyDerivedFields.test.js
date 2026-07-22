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

test("deriveEnvoyFields ne laisse jamais grid_eim_whLifetime redescendre sous son maximum precedent", () => {
  // Cas reel: le tableau ext (borne de recharge) consomme plus vite que le
  // brut d'export ne progresse -> la soustraction ferait chuter grid_eim de
  // 2 435 232 a 2 417 821 sans le clamp. L'export ne peut physiquement pas
  // redescendre: on doit rester a 2 435 232, et eco doit rester <= prod.
  const base = {
    grid_eim_whLifetime: 2_462_775, // brut actEnergyRcvd (avant correction)
    prod_eim_whLifetime: 12_677_653,
  };

  const out = deriveEnvoyFields(base, {
    signedPowerW: 0,
    energyOffsetWh: 44_954, // fait chuter le corrige a 2_417_821 sans clamp
    previousGridEimWhLifetime: 2_435_232,
  });

  assert.equal(out.grid_eim_whLifetime, 2_435_232); // fige au maximum precedent, pas 2_417_821
  assert.ok(out.eco_eim_whLifetime <= out.prod_eim_whLifetime);
});

test("deriveEnvoyFields laisse grid_eim_whLifetime progresser normalement une fois le brut revenu au-dessus du maximum", () => {
  const base = {
    grid_eim_whLifetime: 2_500_000,
    prod_eim_whLifetime: 12_700_000,
  };

  const out = deriveEnvoyFields(base, {
    signedPowerW: 0,
    energyOffsetWh: 44_954,
    previousGridEimWhLifetime: 2_435_232,
  });

  assert.equal(out.grid_eim_whLifetime, 2_455_046); // 2_500_000 - 44_954, superieur au maximum precedent
});

test("deriveEnvoyFields augmente import_eim de l'offset tableau ext (sens oppose de grid_eim)", () => {
  const base = {
    import_eim_whLifetime: 3_000,
    import_eim_kwhLifetime: 3,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 0, energyOffsetWh: 1_000 });

  assert.equal(out.import_eim_whLifetime, 4_000);
  assert.equal(out.import_eim_kwhLifetime, 4);
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

test("deriveEnvoyFields calcule eco_edf/togrid_edf a partir du compteur EDF (conservation d'energie)", () => {
  const base = {
    conso_all_eim_whLifetime: 20_000,
    prod_eim_whLifetime: 12_000,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 0, energyOffsetWh: 0, edfImportWhLifetime: 15_000 });

  assert.equal(out.edf_import_whLifetime, 15_000);
  assert.equal(out.edf_import_kwhLifetime, 15);
  assert.equal(out.eco_edf_whLifetime, 5_000); // 20_000 (conso totale) - 15_000 (importe)
  assert.equal(out.eco_edf_kwhLifetime, 5);
  assert.equal(out.togrid_edf_whLifetime, 7_000); // 12_000 (prod) - 5_000 (eco)
  assert.equal(out.togrid_edf_kwhLifetime, 7);
});

test("deriveEnvoyFields ne calcule pas eco_edf/togrid_edf si edfImportWhLifetime n'est pas fourni", () => {
  const base = {
    conso_all_eim_whLifetime: 20_000,
    prod_eim_whLifetime: 12_000,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 0, energyOffsetWh: 0 });

  assert.equal(out.edf_import_whLifetime, undefined);
  assert.equal(out.eco_edf_whLifetime, undefined);
  assert.equal(out.togrid_edf_whLifetime, undefined);
});

test("deriveEnvoyFields ne clampe PAS eco_edf/togrid_edf a 0: le decalage d'origine entre compteurs peut etre negatif, seul le delta _today compte", () => {
  // conso_all_eim_whLifetime et edf_import_whLifetime (Linky) ne partent pas du
  // meme "zero" (compteurs installes a des dates differentes) — leur difference
  // absolue n'a pas de sens physique et peut legitimement etre negative. Un
  // clamp a 0 ici ecraserait ce decalage a chaque cycle et bloquerait
  // definitivement _today/_yesterday a 0 (incident reel du 2026-07-23).
  const base = {
    conso_all_eim_whLifetime: 5_000,
    prod_eim_whLifetime: 12_000,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 0, energyOffsetWh: 0, edfImportWhLifetime: 9_000 });

  assert.equal(out.eco_edf_whLifetime, -4_000); // 5_000 - 9_000, pas clampe
  assert.equal(out.togrid_edf_whLifetime, 16_000); // 12_000 - (-4_000), pas clampe
});

test("deriveEnvoyFields: le delta _today de eco_edf reste correct malgre un decalage d'origine negatif", () => {
  // Meme decalage d'origine (-4_000) aux deux instants: le _today doit refleter
  // uniquement la vraie autoconsommation depuis la reference _00h, pas le
  // decalage arbitraire entre les deux compteurs.
  const refCycle = deriveEnvoyFields(
    { conso_all_eim_whLifetime: 5_000, prod_eim_whLifetime: 12_000 },
    { signedPowerW: 0, energyOffsetWh: 0, edfImportWhLifetime: 9_000 },
  );
  const laterCycle = deriveEnvoyFields(
    { conso_all_eim_whLifetime: 5_800, prod_eim_whLifetime: 12_500 }, // +800 conso, dont 300 importes
    { signedPowerW: 0, energyOffsetWh: 0, edfImportWhLifetime: 9_300 },
  );

  const ecoToday = laterCycle.eco_edf_whLifetime - refCycle.eco_edf_whLifetime;
  assert.equal(ecoToday, 500); // 800 consommes - 300 importes = 500 autoconsommes, malgre le decalage de -4_000
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
