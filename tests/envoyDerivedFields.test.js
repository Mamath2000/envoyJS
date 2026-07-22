import test from "node:test";
import assert from "node:assert/strict";

import { deriveEnvoyFields } from "../src/envoyDerivedFields.js";

test("deriveEnvoyFields sans correction calcule grid/eco instantanes a partir des champs bruts", () => {
  const base = {
    "conso_net/wNow": -400,
    "prod/wNow": 1200,
  };

  const out = deriveEnvoyFields(base);

  assert.equal(out["conso_net/wNow"], -400);
  assert.equal(out["grid/wNow"], 400);
  assert.equal(out["grid/wNow_binary"], 0);
  assert.equal(out["eco/wNow"], 800);
});

test("deriveEnvoyFields avec correction positive decale la puissance instantanee", () => {
  const base = {
    "conso_net/wNow": 500,
    "prod/wNow": 1200,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 200, energyOffsetWh: 1_000 });

  assert.equal(out["conso_net/wNow"], 700);
  assert.equal(out["grid/wNow"], 0);
  assert.equal(out["grid/wNow_binary"], 1);
  assert.equal(out["eco/wNow"], 1200);
});

test("deriveEnvoyFields calcule grid/eco (whLifetime) a partir du compteur EDF (conservation d'energie)", () => {
  const base = {
    "conso_all/whLifetime": 20_000,
    "prod/whLifetime": 12_000,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 0, energyOffsetWh: 0, edfImportWhLifetime: 15_000 });

  assert.equal(out["import/whLifetime"], 15_000);
  assert.equal(out["eco/whLifetime"], 5_000); // 20_000 (conso totale) - 15_000 (importe)
  assert.equal(out["grid/whLifetime"], 7_000); // 12_000 (prod) - 5_000 (eco)
});

test("deriveEnvoyFields ne calcule pas grid/eco (whLifetime) si edfImportWhLifetime n'est pas fourni", () => {
  const base = {
    "conso_all/whLifetime": 20_000,
    "prod/whLifetime": 12_000,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 0, energyOffsetWh: 0 });

  assert.equal(out["import/whLifetime"], undefined);
  assert.equal(out["eco/whLifetime"], undefined);
  assert.equal(out["grid/whLifetime"], undefined);
});

test("deriveEnvoyFields ne clampe PAS grid/eco (whLifetime) a 0: le decalage d'origine entre compteurs peut etre negatif, seul le delta _today compte", () => {
  // conso_all/whLifetime et import/whLifetime (Linky) ne partent pas du
  // meme "zero" (compteurs installes a des dates differentes) — leur difference
  // absolue n'a pas de sens physique et peut legitimement etre negative. Un
  // clamp a 0 ici ecraserait ce decalage a chaque cycle et bloquerait
  // definitivement _today/_yesterday a 0 (incident reel du 2026-07-23).
  const base = {
    "conso_all/whLifetime": 5_000,
    "prod/whLifetime": 12_000,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 0, energyOffsetWh: 0, edfImportWhLifetime: 9_000 });

  assert.equal(out["eco/whLifetime"], -4_000); // 5_000 - 9_000, pas clampe
  assert.equal(out["grid/whLifetime"], 16_000); // 12_000 - (-4_000), pas clampe
});

test("deriveEnvoyFields: le delta _today de eco reste correct malgre un decalage d'origine negatif", () => {
  // Meme decalage d'origine (-4_000) aux deux instants: le _today doit refleter
  // uniquement la vraie autoconsommation depuis la reference _00h, pas le
  // decalage arbitraire entre les deux compteurs.
  const refCycle = deriveEnvoyFields(
    { "conso_all/whLifetime": 5_000, "prod/whLifetime": 12_000 },
    { signedPowerW: 0, energyOffsetWh: 0, edfImportWhLifetime: 9_000 },
  );
  const laterCycle = deriveEnvoyFields(
    { "conso_all/whLifetime": 5_800, "prod/whLifetime": 12_500 }, // +800 conso, dont 300 importes
    { signedPowerW: 0, energyOffsetWh: 0, edfImportWhLifetime: 9_300 },
  );

  const ecoToday = laterCycle["eco/whLifetime"] - refCycle["eco/whLifetime"];
  assert.equal(ecoToday, 500); // 800 consommes - 300 importes = 500 autoconsommes, malgre le decalage de -4_000
});

test("deriveEnvoyFields recalcule le courant via I = P / U", () => {
  const base = {
    "conso_net/wNow": 460,
    "conso_net/voltage": 230,
  };

  const out = deriveEnvoyFields(base, { signedPowerW: 230 });

  assert.equal(out["conso_net/wNow"], 690);
  assert.equal(out["conso_net/current"], 3);
});
