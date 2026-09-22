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

function createService(configOverrides = {}) {
  const service = new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      timeZoneName: "Europe/Paris",
      logLevel: "silent",
      haAutodiscovery: false,
      ...configOverrides,
    },
    api: {},
    log: createSilentLog(),
  });

  const publishedTopics = [];
  service.publish = async (topic, payload) => {
    publishedTopics.push({ topic, payload });
  };

  return { service, publishedTopics };
}

test("le premier appel memorise le jour courant sans declencher de rollover", async () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-midnightrefs-${Date.now()}-${Math.random()}.json`);
  try {
    const { service, publishedTopics } = createService({ midnightReferencesStateFile: stateFilePath });
    service.getNowPartsInTz = () => ({ date: "2026-07-19", hour: 14, minute: 30, second: 0 });

    service.midnightReferences = { "conso_all/whLifetime": 1000 };

    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1200 });

    assert.equal(service.lastMidnightCheck, "2026-07-19");
    assert.equal(publishedTopics.length, 0);
    assert.equal(service.midnightReferences["conso_all/whLifetime"], 1000); // inchangé
  } finally {
    fs.rmSync(stateFilePath, { force: true });
  }
});

test("aucun rollover tant que la date ne change pas", async () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-midnightrefs-${Date.now()}-${Math.random()}.json`);
  try {
    const { service, publishedTopics } = createService({ midnightReferencesStateFile: stateFilePath });
    service.getNowPartsInTz = () => ({ date: "2026-07-19", hour: 14, minute: 30, second: 0 });
    service.midnightReferences = { "conso_all/whLifetime": 1000 };

    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1200 }); // seed
    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1300 }); // meme jour

    assert.equal(publishedTopics.length, 0);
    assert.equal(service.midnightReferences["conso_all/whLifetime"], 1000);
  } finally {
    fs.rmSync(stateFilePath, { force: true });
  }
});

test("le rollover se declenche des que le jour change, meme en pleine apres-midi (gros polling.interval_ms), et derive yesterday depuis _00h/_00h_veille", async () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-midnightrefs-${Date.now()}-${Math.random()}.json`);
  const { service, publishedTopics } = createService({ midnightReferencesStateFile: stateFilePath });

  try {
    service.getNowPartsInTz = () => ({ date: "2026-07-19", hour: 14, minute: 0, second: 0 });
    service.midnightReferences = {
      "conso_all/whLifetime": 1000,
      "conso_net/whLifetime": 500,
      "prod/whLifetime": 2000,
      "to_grid/whLifetime": 300,
      "eco/whLifetime": 700,
    };

    // Demarrage du service en milieu de journee: seed sans rollover.
    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1200 });
    assert.equal(publishedTopics.length, 0);

    // Le prochain cycle de la boucle tombe le lendemain a 14h (intervalle de polling long):
    // le rollover doit quand meme se declencher, sans dependre d'une fenetre d'horloge minuit.
    service.getNowPartsInTz = () => ({ date: "2026-07-20", hour: 14, minute: 0, second: 0 });
    const currentData = {
      "conso_all/whLifetime": 1800,
      "conso_net/whLifetime": 900,
      "prod/whLifetime": 3000,
      "to_grid/whLifetime": 450,
      "eco/whLifetime": 1100,
    };

    await service.checkAndUpdateMidnightReferences(currentData);

    assert.equal(service.lastMidnightCheck, "2026-07-20");

    // _00h_veille = l'ancien _00h, capturé tel quel juste avant d'etre ecrasé.
    assert.equal(service.midnightReferences["conso_all/whLifetime_veille"], 1000);
    assert.equal(service.midnightReferences["conso_net/whLifetime_veille"], 500);
    assert.equal(service.midnightReferences["prod/whLifetime_veille"], 2000);
    assert.equal(service.midnightReferences["to_grid/whLifetime_veille"], 300);
    assert.equal(service.midnightReferences["eco/whLifetime_veille"], 700);

    // Nouvelle reference _00h = valeur courante au moment de la detection.
    assert.equal(service.midnightReferences["conso_all/whLifetime"], 1800);
    assert.equal(service.midnightReferences["conso_net/whLifetime"], 900);

    // yesterday est derive (_00h - _00h_veille) et publié, jamais stocké comme son propre etat.
    const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
    assert.equal(byTopic[`${service.topicData}/conso_all/yesterday`], "800"); // 1800-1000
    assert.equal(byTopic[`${service.topicData}/conso_net/yesterday`], "400"); // 900-500
    assert.equal(byTopic[`${service.topicData}/prod/yesterday`], "1000"); // 3000-2000
    assert.equal(byTopic[`${service.topicData}/to_grid/yesterday`], "150"); // 450-300
    assert.equal(byTopic[`${service.topicData}/eco/yesterday`], "400"); // 1100-700
    assert.equal(service.midnightReferences["conso_all/yesterday"], undefined); // jamais stocké tel quel

    // 5 capteurs journaliers x 2 topics (_00h + yesterday) + 1 topic last_midnight_check = 11.
    assert.equal(publishedTopics.length, 11);
    const lastCheckPublish = publishedTopics.find((p) => p.topic === `${service.topicData}/last_midnight_check`);
    assert.equal(lastCheckPublish?.payload, "2026-07-20");
  } finally {
    fs.rmSync(stateFilePath, { force: true });
  }
});

test("les references minuit et le dernier jour de rollover sont restaurés depuis le fichier d'etat au demarrage", () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-midnightrefs-${Date.now()}-${Math.random()}.json`);

  try {
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        midnightReferences: {
          index_00h: { conso_all: 1000, prod: 2000 },
          index_00h_veille: { conso_all: 800 },
        },
        lastMidnightCheck: "2026-07-19",
      }),
    );

    const { service } = createService({ midnightReferencesStateFile: stateFilePath });
    service.loadMidnightReferencesFromDisk();

    assert.equal(service.lastMidnightCheck, "2026-07-19");
    assert.equal(service.midnightReferences["conso_all/whLifetime"], 1000);
    assert.equal(service.midnightReferences["prod/whLifetime"], 2000);
    assert.equal(service.midnightReferences["conso_all/whLifetime_veille"], 800);
  } finally {
    fs.rmSync(stateFilePath, { force: true });
  }
});

test("un fichier d'etat avec un lastMidnightCheck invalide est ignoré", () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-midnightrefs-${Date.now()}-${Math.random()}.json`);

  try {
    fs.writeFileSync(stateFilePath, JSON.stringify({ midnightReferences: {}, lastMidnightCheck: "pas-une-date" }));

    const { service } = createService({ midnightReferencesStateFile: stateFilePath });
    service.loadMidnightReferencesFromDisk();

    assert.equal(service.lastMidnightCheck, undefined);
  } finally {
    fs.rmSync(stateFilePath, { force: true });
  }
});

test("rollover minuit: une valeur figee a 0 (source amont invalide) est rejetée, l'ancien _00h est conservé et retenté au cycle suivant", async () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-midnightrefs-${Date.now()}-${Math.random()}.json`);
  const { service, publishedTopics } = createService({ midnightReferencesStateFile: stateFilePath });

  try {
    // Reproduit l'incident 2026-09-21/22: to_grid/conso_net figés à 0 côté
    // MQTT depuis ~12h avant minuit (source amont indisponible), pendant que
    // prod/conso_all (sources internes Envoy) restent valides.
    service.getNowPartsInTz = () => ({ date: "2026-09-21", hour: 14, minute: 0, second: 0 });
    service.midnightReferences = {
      "conso_all/whLifetime": 1000,
      "to_grid/whLifetime": 500,
    };
    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1200, "to_grid/whLifetime": 550 }); // seed

    service.getNowPartsInTz = () => ({ date: "2026-09-22", hour: 0, minute: 5, second: 0 });
    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1800, "to_grid/whLifetime": 0 });

    // conso_all (non affecté): rollover normal.
    assert.equal(service.midnightReferences["conso_all/whLifetime"], 1800);
    assert.equal(service.midnightReferences["conso_all/whLifetime_veille"], 1000);

    // to_grid (affecté): ancien _00h conservé, PAS de _veille, capteur toujours en attente.
    assert.equal(service.midnightReferences["to_grid/whLifetime"], 500);
    assert.equal(service.midnightReferences["to_grid/whLifetime_veille"], undefined);
    assert.equal(service.pendingMidnightSensors.has("to_grid/whLifetime"), true);

    const to_gridTopics = publishedTopics.filter((p) => p.topic.startsWith(`${service.topicData}/to_grid`));
    assert.equal(to_gridTopics.length, 0); // rien publié pour to_grid ce cycle

    // Plus tard le meme jour, la source amont revient enfin a une vraie valeur cumulee.
    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1810, "to_grid/whLifetime": 98_710 });

    assert.equal(service.midnightReferences["to_grid/whLifetime"], 98_710);
    assert.equal(service.midnightReferences["to_grid/whLifetime_veille"], 500);
    assert.equal(service.pendingMidnightSensors.has("to_grid/whLifetime"), false);
  } finally {
    fs.rmSync(stateFilePath, { force: true });
  }
});

test("calculateDailyValues rejette un 'today' aberrant (today > whLifetime_00h) et republie la derniere valeur plausible", () => {
  const { service } = createService();
  service.dailySensors = ["to_grid/whLifetime"];

  // whLifetime_00h gelé à 0 (donnée invalide au moment du snapshot, non
  // rattrapée par le garde-fou de checkAndUpdateMidnightReferences dans ce
  // test unitaire ciblé sur calculateDailyValues seul).
  service.midnightReferences = { "to_grid/whLifetime": 0 };

  const dailyValues = service.calculateDailyValues({ "to_grid/whLifetime": 100 });
  assert.equal(dailyValues["to_grid/today"], 100); // midnightRef=0: garde-fou desactive, valeur normale

  service.midnightReferences = { "to_grid/whLifetime": 50_000 };

  // Rattrapage brutal de la source amont: today calculé vaudrait 98710 (>
  // midnightRef), signe quasi certain d'un whLifetime_00h invalide ailleurs.
  const dailyValuesAfterCatchUp = service.calculateDailyValues({ "to_grid/whLifetime": 148_710 });
  assert.equal(dailyValuesAfterCatchUp["to_grid/today"], 100); // derniere valeur plausible republiée
});

test("checkAndUpdateMidnightReferences ecrit le fichier d'etat (index_00h + index_00h_veille) lors d'un rollover", async () => {
  const stateFilePath = path.join(os.tmpdir(), `envoyjs-midnightrefs-${Date.now()}-${Math.random()}.json`);

  try {
    const { service } = createService({ midnightReferencesStateFile: stateFilePath });
    service.getNowPartsInTz = () => ({ date: "2026-07-19", hour: 14, minute: 0, second: 0 });
    service.midnightReferences = { "conso_all/whLifetime": 1000 };

    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1200 }); // seed, pas de rollover
    assert.equal(fs.existsSync(stateFilePath), true); // le seed du jour courant est deja persisté

    service.getNowPartsInTz = () => ({ date: "2026-07-20", hour: 14, minute: 0, second: 0 });
    await service.checkAndUpdateMidnightReferences({ "conso_all/whLifetime": 1800 });

    const persisted = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
    assert.equal(persisted.lastMidnightCheck, "2026-07-20");
    assert.equal(persisted.midnightReferences.index_00h.conso_all, 1800);
    assert.equal(persisted.midnightReferences.index_00h_veille.conso_all, 1000); // ancien _00h devenu veille
  } finally {
    fs.rmSync(stateFilePath, { force: true });
  }
});
