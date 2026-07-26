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

test("le rollover se declenche des que le jour change, meme en pleine apres-midi (gros polling.interval_ms)", async () => {
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

    // "_yesterday" = valeur courante - ancienne reference _00h (au moment de la detection)
    assert.equal(service.midnightReferences["conso_all/yesterday"], 800); // 1800-1000
    assert.equal(service.midnightReferences["conso_net/yesterday"], 400); // 900-500
    assert.equal(service.midnightReferences["prod/yesterday"], 1000); // 3000-2000
    assert.equal(service.midnightReferences["to_grid/yesterday"], 150); // 450-300
    assert.equal(service.midnightReferences["eco/yesterday"], 400); // 1100-700

    // Nouvelle reference _00h = valeur courante au moment de la detection.
    assert.equal(service.midnightReferences["conso_all/whLifetime"], 1800);
    assert.equal(service.midnightReferences["conso_net/whLifetime"], 900);

    // 5 capteurs journaliers x 2 topics (_yesterday + _00h) + 1 topic last_midnight_check = 11.
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
        midnightReferences: { "conso_all/whLifetime": 1000, "prod/whLifetime": 2000 },
        lastMidnightCheck: "2026-07-19",
      }),
    );

    const { service } = createService({ midnightReferencesStateFile: stateFilePath });
    service.loadMidnightReferencesFromDisk();

    assert.equal(service.lastMidnightCheck, "2026-07-19");
    assert.equal(service.midnightReferences["conso_all/whLifetime"], 1000);
    assert.equal(service.midnightReferences["prod/whLifetime"], 2000);
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

test("checkAndUpdateMidnightReferences ecrit le fichier d'etat lors d'un rollover", async () => {
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
    assert.equal(persisted.midnightReferences["conso_all/whLifetime"], 1800);
  } finally {
    fs.rmSync(stateFilePath, { force: true });
  }
});
