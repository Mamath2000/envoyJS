import test from "node:test";
import assert from "node:assert/strict";

import { deriveEnvoyFields } from "../src/envoyDerivedFields.js";

test("deriveEnvoyFields sans capteur général: conso_net reste la valeur brute, aucun grid/eco instantane", () => {
  const base = {
    "conso_net/wNow": -400,
    "prod/wNow": 1200,
  };

  const out = deriveEnvoyFields(base);

  assert.equal(out["conso_net/wNow"], -400);
  assert.equal(out["to_grid/wNow"], undefined);
  assert.equal(out["to_grid/wNow_binary"], undefined);
  assert.equal(out["eco/wNow"], undefined);
});

test("deriveEnvoyFields calcule conso_net/grid/eco instantanes depuis generalMeterPowerW (export)", () => {
  const base = { "prod/wNow": 1200 };

  const out = deriveEnvoyFields(base, { generalMeterPowerW: -400 });

  assert.equal(out["conso_net/wNow"], -400);
  assert.equal(out["to_grid/wNow"], 400);
  assert.equal(out["to_grid/wNow_binary"], 0);
  assert.equal(out["from_grid/wNow"], 0); // export: rien tiré du réseau
  assert.equal(out["eco/wNow"], 800);
});

test("deriveEnvoyFields calcule conso_net/grid/eco instantanes depuis generalMeterPowerW (import)", () => {
  const base = { "prod/wNow": 1200 };

  const out = deriveEnvoyFields(base, { generalMeterPowerW: 700 });

  assert.equal(out["conso_net/wNow"], 700);
  assert.equal(out["to_grid/wNow"], 0);
  assert.equal(out["to_grid/wNow_binary"], 1);
  assert.equal(out["from_grid/wNow"], 700); // import: puissance tirée du réseau
  assert.equal(out["eco/wNow"], 1200);
});

test("deriveEnvoyFields republie generalMeterEnergyFlow tel quel dans conso_net/energy_flow", () => {
  const out = deriveEnvoyFields({}, { generalMeterPowerW: -400, generalMeterEnergyFlow: "producing" });

  assert.equal(out["conso_net/energy_flow"], "producing");
});

test("deriveEnvoyFields n'ajoute pas conso_net/energy_flow si absent des inputs", () => {
  const out = deriveEnvoyFields({}, { generalMeterPowerW: 700 });

  assert.equal(out["conso_net/energy_flow"], undefined);
});

test("deriveEnvoyFields recopie current depuis le capteur général, sans calcul I=P/U (voltage rationalisé sur prod/voltage)", () => {
  const out = deriveEnvoyFields({}, { generalMeterPowerW: 460, generalMeterCurrentA: 1.997 });

  assert.equal(out["conso_net/current"], 1.997);
  assert.equal(out["conso_net/voltage"], undefined);
});

test("deriveEnvoyFields recalcule conso_all/wNow depuis prod + solde net (au lieu du CT total-consumption Envoy, aveugle au tableau ext)", () => {
  const base = { "conso_all/wNow": 1500, "prod/wNow": 1200 };

  const out = deriveEnvoyFields(base, { generalMeterPowerW: 700 }); // import

  assert.equal(out["conso_all/wNow"], 1900); // prod(1200) + import(700), plus le CT brut (1500)
  assert.equal(out["conso_net/wNow"], 700);
});

test("deriveEnvoyFields: conso_all/wNow reste coherent avec conso_all_wNow (raw) meme a l'export", () => {
  const base = { "conso_all/wNow": 1500, "prod/wNow": 1200 };

  const out = deriveEnvoyFields(base, { generalMeterPowerW: -400 }); // export

  assert.equal(out["conso_all/wNow"], 800); // prod(1200) + netPowerW(-400), meme identite que le raw
});

test("deriveEnvoyFields laisse conso_all/wNow inchangé si prod/wNow est absent (aucune correction possible)", () => {
  const base = { "conso_all/wNow": 1500 };

  const out = deriveEnvoyFields(base, { generalMeterPowerW: 700 });

  assert.equal(out["conso_all/wNow"], 1500);
  assert.equal(out["conso_net/wNow"], 700);
});

test("deriveEnvoyFields calcule grid(togrid)/eco/conso_all/conso_net (whLifetime) depuis le capteur général — import n'est plus publié, seulement utilisé en interne", () => {
  const base = { "prod/whLifetime": 12_000 };

  const out = deriveEnvoyFields(base, {
    generalMeterImportWhLifetime: 15_000,
    generalMeterExportWhLifetime: 3_000,
  });

  assert.equal(out["import/whLifetime"], undefined); // plus de topic/sensor dedié
  assert.equal(out["to_grid/whLifetime"], 3_000); // export, lu directement
  assert.equal(out["eco/whLifetime"], 9_000); // prod(12_000) - export(3_000)
  assert.equal(out["conso_all/whLifetime"], 24_000); // import(15_000, interne) + eco(9_000)
  assert.equal(out["conso_net/whLifetime"], 12_000); // import(15_000, interne) - export(3_000)
});

test("deriveEnvoyFields ne calcule aucun whLifetime derive si le capteur général n'a pas encore de donnees", () => {
  const base = { "prod/whLifetime": 12_000 };

  const out = deriveEnvoyFields(base, {});

  assert.equal(out["import/whLifetime"], undefined);
  assert.equal(out["to_grid/whLifetime"], undefined);
  assert.equal(out["eco/whLifetime"], undefined);
  assert.equal(out["conso_all/whLifetime"], undefined);
  assert.equal(out["conso_net/whLifetime"], undefined);
});

test("deriveEnvoyFields: import seul (sans export) ne produit aucun champ whLifetime publié", () => {
  const out = deriveEnvoyFields({}, { generalMeterImportWhLifetime: 15_000 });

  assert.equal(out["import/whLifetime"], undefined);
  assert.equal(out["to_grid/whLifetime"], undefined);
  assert.equal(out["eco/whLifetime"], undefined);
  assert.equal(out["conso_all/whLifetime"], undefined);
  assert.equal(out["conso_net/whLifetime"], undefined);
});

test("deriveEnvoyFields ne clampe PAS eco/grid/conso_all (whLifetime) a 0: le decalage d'origine entre prod (Envoy) et export (capteur général) peut etre negatif, seul le delta _today compte", () => {
  // prod/whLifetime (Envoy) et grid/whLifetime (capteur général, rebaseline a
  // la pose) ne partent pas du meme "zero" — leur difference absolue n'a pas
  // de sens physique et peut legitimement etre negative. Un clamp a 0 ici
  // ecraserait ce decalage a chaque cycle et bloquerait definitivement
  // _today/_yesterday a 0 (meme classe d'incident que celui du 2026-07-23).
  const base = { "prod/whLifetime": 5_000 };

  const out = deriveEnvoyFields(base, {
    generalMeterImportWhLifetime: 9_000,
    generalMeterExportWhLifetime: 9_000,
  });

  assert.equal(out["eco/whLifetime"], -4_000); // 5_000 - 9_000, pas clampe
  assert.equal(out["conso_all/whLifetime"], 5_000); // import(9_000) + eco(-4_000), pas clampe
});

test("deriveEnvoyFields: le delta _today de eco reste correct malgre un decalage d'origine negatif", () => {
  const refCycle = deriveEnvoyFields(
    { "prod/whLifetime": 5_000 },
    { generalMeterImportWhLifetime: 9_000, generalMeterExportWhLifetime: 9_000 },
  );
  const laterCycle = deriveEnvoyFields(
    { "prod/whLifetime": 5_500 }, // +500 produits
    { generalMeterImportWhLifetime: 9_300, generalMeterExportWhLifetime: 9_200 }, // +300 importes, +200 exportes
  );

  const ecoToday = laterCycle["eco/whLifetime"] - refCycle["eco/whLifetime"];
  assert.equal(ecoToday, 300); // 500 produits - 200 exportes = 300 autoconsommes, malgre le decalage de -4_000
});

test("deriveEnvoyFields clampe le bruit de veille des micro-onduleurs (prod/wNow <= 3W -> 0)", () => {
  const out = deriveEnvoyFields({ "prod/wNow": 2 }, {});
  assert.equal(out["prod/wNow"], 0);
});

test("deriveEnvoyFields rebaseline prod en interne (prodBaselineWh) pour eco/conso_all, sans jamais toucher au champ publié prod/whLifetime", () => {
  const base = { "prod/whLifetime": 12_726_270 }; // gros compteur Envoy, vit depuis longtemps

  const out = deriveEnvoyFields(base, {
    prodBaselineWh: 12_726_270, // relevé au meme instant que les baselines du capteur général
    generalMeterImportWhLifetime: 1_080,
    generalMeterExportWhLifetime: 0,
  });

  // Le champ publié reste la vraie valeur absolue Envoy, inchangée.
  assert.equal(out["prod/whLifetime"], 12_726_270);

  // eco/conso_all utilisent prod - prodBaselineWh (≈0 ici) au lieu du gros
  // nombre absolu, pour rester coherents avec des index tout juste rebaselinés.
  assert.equal(out["eco/whLifetime"], 0); // (12_726_270 - 12_726_270) - export(0)
  assert.equal(out["conso_all/whLifetime"], 1_080); // import(1_080) + eco(0)
});

test("deriveEnvoyFields: sans prodBaselineWh configurée, eco/conso_all retombent sur prod/whLifetime brut (comportement inchangé)", () => {
  const base = { "prod/whLifetime": 12_000 };

  const out = deriveEnvoyFields(base, {
    generalMeterImportWhLifetime: 15_000,
    generalMeterExportWhLifetime: 3_000,
  });

  assert.equal(out["eco/whLifetime"], 9_000); // 12_000 - 3_000, comme avant
});
