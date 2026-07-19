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
  const service = new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      timeZoneName: "Europe/Paris",
      logLevel: "silent",
      haAutodiscovery: false,
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
  const { service, publishedTopics } = createService();
  service.getNowPartsInTz = () => ({ date: "2026-07-19", hour: 14, minute: 30, second: 0 });

  service.midnightReferences = { conso_all_eim_whLifetime: 1000 };

  await service.checkAndUpdateMidnightReferences({ conso_all_eim_whLifetime: 1200 });

  assert.equal(service.lastMidnightCheck, "2026-07-19");
  assert.equal(publishedTopics.length, 0);
  assert.equal(service.midnightReferences.conso_all_eim_whLifetime, 1000); // inchangé
});

test("aucun rollover tant que la date ne change pas", async () => {
  const { service, publishedTopics } = createService();
  service.getNowPartsInTz = () => ({ date: "2026-07-19", hour: 14, minute: 30, second: 0 });
  service.midnightReferences = { conso_all_eim_whLifetime: 1000 };

  await service.checkAndUpdateMidnightReferences({ conso_all_eim_whLifetime: 1200 }); // seed
  await service.checkAndUpdateMidnightReferences({ conso_all_eim_whLifetime: 1300 }); // meme jour

  assert.equal(publishedTopics.length, 0);
  assert.equal(service.midnightReferences.conso_all_eim_whLifetime, 1000);
});

test("le rollover se declenche des que le jour change, meme en pleine apres-midi (gros polling.interval_ms)", async () => {
  const { service, publishedTopics } = createService();

  service.getNowPartsInTz = () => ({ date: "2026-07-19", hour: 14, minute: 0, second: 0 });
  service.midnightReferences = {
    conso_all_eim_whLifetime: 1000,
    conso_net_eim_whLifetime: 500,
    prod_eim_whLifetime: 2000,
    grid_eim_whLifetime: 300,
    eco_eim_whLifetime: 700,
  };

  // Demarrage du service en milieu de journee: seed sans rollover.
  await service.checkAndUpdateMidnightReferences({ conso_all_eim_whLifetime: 1200 });
  assert.equal(publishedTopics.length, 0);

  // Le prochain cycle de la boucle tombe le lendemain a 14h (intervalle de polling long):
  // le rollover doit quand meme se declencher, sans dependre d'une fenetre d'horloge minuit.
  service.getNowPartsInTz = () => ({ date: "2026-07-20", hour: 14, minute: 0, second: 0 });
  const currentData = {
    conso_all_eim_whLifetime: 1800,
    conso_net_eim_whLifetime: 900,
    prod_eim_whLifetime: 3000,
    grid_eim_whLifetime: 450,
    eco_eim_whLifetime: 1100,
  };

  await service.checkAndUpdateMidnightReferences(currentData);

  assert.equal(service.lastMidnightCheck, "2026-07-20");

  // "_yesterday" = valeur courante - ancienne reference _00h (au moment de la detection)
  assert.equal(service.midnightReferences.conso_all_eim_yesterday, 800); // 1800-1000
  assert.equal(service.midnightReferences.conso_net_eim_yesterday, 400); // 900-500
  assert.equal(service.midnightReferences.prod_eim_yesterday, 1000); // 3000-2000
  assert.equal(service.midnightReferences.grid_eim_yesterday, 150); // 450-300
  assert.equal(service.midnightReferences.eco_eim_yesterday, 400); // 1100-700

  // Nouvelle reference _00h = valeur courante au moment de la detection.
  assert.equal(service.midnightReferences.conso_all_eim_whLifetime, 1800);
  assert.equal(service.midnightReferences.conso_net_eim_whLifetime, 900);

  // 5 capteurs journaliers x 2 topics (_yesterday + _00h) + 1 topic last_midnight_check = 11.
  assert.equal(publishedTopics.length, 11);
  const lastCheckPublish = publishedTopics.find((p) => p.topic === `${service.topicData}/last_midnight_check`);
  assert.equal(lastCheckPublish?.payload, "2026-07-20");
});

test("le dernier jour de rollover est restauré depuis un message MQTT retained au demarrage", () => {
  const { service } = createService();

  const handlers = {};
  const fakeClient = {
    subscribe() {},
    on(event, handler) {
      handlers[event] = handler;
    },
  };

  service.installMqttListeners(fakeClient);
  assert.equal(service.lastMidnightCheck, undefined);

  const topic = `${service.topicData}/last_midnight_check`;
  handlers.message(Buffer.from(topic), Buffer.from("2026-07-19"));

  assert.equal(service.lastMidnightCheck, "2026-07-19");
});

test("un message retained invalide sur last_midnight_check est ignoré", () => {
  const { service } = createService();

  const handlers = {};
  const fakeClient = {
    subscribe() {},
    on(event, handler) {
      handlers[event] = handler;
    },
  };

  service.installMqttListeners(fakeClient);

  const topic = `${service.topicData}/last_midnight_check`;
  handlers.message(Buffer.from(topic), Buffer.from("pas-une-date"));

  assert.equal(service.lastMidnightCheck, undefined);
});
