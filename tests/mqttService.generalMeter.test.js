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

function createService({
  api = {},
  generalMeterTopic = "zigbee2mqtt/general",
  generalMeterImportBaselineWh,
  generalMeterExportBaselineWh,
  prodBaselineWh,
} = {}) {
  const service = new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      generalMeterTopic,
      generalMeterPowerField: "power",
      generalMeterImportBaselineWh,
      generalMeterExportBaselineWh,
      prodBaselineWh,
      highFrequencyIntervalMs: 250,
      timeZoneName: "Europe/Paris",
      logLevel: "silent",
    },
    api,
    log: createSilentLog(),
  });

  const publishedTopics = [];
  service.publish = async (topic, payload) => {
    publishedTopics.push({ topic, payload });
  };

  return { service, publishedTopics };
}

const SAMPLE_PAYLOAD = JSON.stringify({
  current: 14.47,
  elapsed: 3110,
  energy: 4769.55,
  energy_flow: "consuming",
  linkquality: 112,
  power: 3260,
  produced_energy: 7.42,
  voltage: 226.8,
});

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("parseGeneralMeterPayload extrait la puissance depuis le payload reel du capteur", () => {
  const { service } = createService();
  const { powerW } = service.parseGeneralMeterPayload(SAMPLE_PAYLOAD);
  assert.equal(powerW, 3260);
});

test("parseGeneralMeterPayload signe power negativement quand energy_flow vaut producing", () => {
  const { service } = createService();
  const payload = JSON.stringify({ power: 3260, energy_flow: "producing" });

  const { powerW, energyFlow } = service.parseGeneralMeterPayload(payload);

  assert.equal(powerW, -3260);
  assert.equal(energyFlow, "producing");
});

test("parseGeneralMeterPayload garde power positif quand energy_flow vaut consuming", () => {
  const { powerW, energyFlow } = new EnvoyMqttService({
    config: {
      mqttBaseTopic: "envoy",
      serialNumber: "123456789",
      generalMeterTopic: "zigbee2mqtt/general",
      logLevel: "silent",
    },
    log: createSilentLog(),
  }).parseGeneralMeterPayload(SAMPLE_PAYLOAD);

  assert.equal(powerW, 3260);
  assert.equal(energyFlow, "consuming");
});

test("parseGeneralMeterPayload force la magnitude meme si power arrive deja negatif du capteur", () => {
  const { service } = createService();
  const payload = JSON.stringify({ power: -3260, energy_flow: "producing" });

  const { powerW } = service.parseGeneralMeterPayload(payload);

  assert.equal(powerW, -3260);
});

test("un message MQTT du capteur general applique le signe de energy_flow sur currentPowerW", () => {
  const { service } = createService();

  let messageHandler;
  service.installMqttListeners({
    subscribe() {},
    on(event, handler) {
      if (event === "message") messageHandler = handler;
    },
  });

  const producingPayload = JSON.stringify({ power: 500, energy_flow: "producing" });
  messageHandler(Buffer.from("zigbee2mqtt/general"), Buffer.from(producingPayload));

  assert.equal(service.generalMeter.state.currentPowerW, -500);
  assert.equal(service.generalMeter.state.energyFlow, "producing");
});

test("getExternalInputs expose generalMeterEnergyFlow depuis le dernier message recu", () => {
  const { service } = createService();
  service.generalMeter.state.energyFlow = "producing";

  assert.equal(service.getExternalInputs().generalMeterEnergyFlow, "producing");
});

test("parseGeneralMeterPayload renvoie NaN sur un payload illisible", () => {
  const { service } = createService();
  const { powerW } = service.parseGeneralMeterPayload("pas du json");
  assert.equal(Number.isFinite(powerW), false);
});

test("parseGeneralMeterPayload extrait voltage/current/import/export (kWh -> Wh) depuis le payload reel", () => {
  const { service } = createService();
  const { voltageV, currentA, importWh, exportWh } = service.parseGeneralMeterPayload(SAMPLE_PAYLOAD);

  assert.equal(voltageV, 226.8);
  assert.equal(currentA, 14.47);
  assert.equal(importWh, 4_769_550); // energy: 4769.55 kWh
  assert.equal(exportWh, 7_420); // produced_energy: 7.42 kWh
});

test("applyGeneralMeterReading: sans baseline configurée, la lecture est ignorée", () => {
  const { service } = createService(); // pas de baseline
  service.applyGeneralMeterReading(service.generalMeter.state.import, 4_769_550, "import");

  assert.equal(service.generalMeter.state.import.energyWh, 0);
});

test("applyGeneralMeterReading: la baseline est une constante de config, jamais capturée/modifiée par le code", () => {
  const { service } = createService({ generalMeterImportBaselineWh: 4_769_550 });
  const register = service.generalMeter.state.import;

  assert.equal(register.baselineWh, 4_769_550); // deja fixée à la construction

  service.applyGeneralMeterReading(register, 4_769_700, "import"); // +150 Wh
  assert.equal(register.energyWh, 150);
  assert.equal(register.baselineWh, 4_769_550); // inchangée

  service.applyGeneralMeterReading(register, 4_770_000, "import"); // +450 depuis la baseline
  assert.equal(register.energyWh, 450);
  assert.equal(register.baselineWh, 4_769_550); // toujours inchangée
});

test("applyGeneralMeterReading: une lecture qui ferait baisser energyWh est ignorée (glitch), jamais publiée", () => {
  const { service } = createService({ generalMeterImportBaselineWh: 4_769_550 });
  const register = service.generalMeter.state.import;

  service.applyGeneralMeterReading(register, 4_769_700, "import"); // +150
  assert.equal(register.energyWh, 150);

  // Glitch isole (ex: capteur qui redemarre et publie 0 un instant): tant que
  // la baseline ne change pas, energyWh ne peut physiquement pas baisser —
  // la lecture est rejetée, la valeur precedente reste en place.
  service.applyGeneralMeterReading(register, 0, "import");
  assert.equal(register.energyWh, 150);
  assert.equal(register.baselineWh, 4_769_550);

  // Le capteur revient sur sa trajectoire normale: reprend depuis la derniere
  // valeur acceptée, comme si le glitch n'avait jamais eu lieu.
  service.applyGeneralMeterReading(register, 4_769_750, "import"); // +200 depuis la baseline
  assert.equal(register.energyWh, 200);
});

test("les registres import et export sont completement independants", () => {
  const { service } = createService({
    generalMeterImportBaselineWh: 4_769_550,
    generalMeterExportBaselineWh: 7_420,
  });

  service.applyGeneralMeterReading(service.generalMeter.state.import, 4_769_700, "import"); // +150
  service.applyGeneralMeterReading(service.generalMeter.state.export, 7_500, "export"); // +80

  assert.equal(service.generalMeter.state.import.energyWh, 150);
  assert.equal(service.generalMeter.state.export.energyWh, 80);
  assert.equal(service.generalMeter.state.import.baselineWh, 4_769_550);
  assert.equal(service.generalMeter.state.export.baselineWh, 7_420);
});

test("publishGeneralMeterRawPower calcule conso_net/conso_all a partir de la puissance et de prod en cache", async () => {
  const { service, publishedTopics } = createService();
  service.generalMeter.state.lastProdEimWNow = 500;

  await service.publishGeneralMeterRawPower(3260);

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/raw/conso_net_eim_wNow"], "3260");
  assert.equal(byTopic["envoy/123456789/raw/conso_all_eim_wNow"], "3760");
});

test("publishGeneralMeterRawPower republie aussi conso_net_energy_flow si connu", async () => {
  const { service, publishedTopics } = createService();
  service.generalMeter.state.lastProdEimWNow = 500;
  service.generalMeter.state.energyFlow = "producing";

  await service.publishGeneralMeterRawPower(-3260);

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/raw/conso_net_energy_flow"], "producing");
});

test("publishGeneralMeterRawPower n'ecrit pas conso_net_energy_flow tant qu'aucun message n'a ete recu", async () => {
  const { service, publishedTopics } = createService();
  service.generalMeter.state.lastProdEimWNow = 500;

  await service.publishGeneralMeterRawPower(3260);

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/raw/conso_net_energy_flow"], undefined);
});

test("un message MQTT du capteur general met a jour l'etat et publie immediatement, sans attendre le tick Envoy", async () => {
  const { service, publishedTopics } = createService();
  service.generalMeter.state.lastProdEimWNow = 500;

  let messageHandler;
  const fakeClient = {
    subscribe() {},
    on(event, handler) {
      if (event === "message") messageHandler = handler;
    },
  };

  service.installMqttListeners(fakeClient);
  assert.equal(typeof messageHandler, "function");

  messageHandler(Buffer.from("zigbee2mqtt/general"), Buffer.from(SAMPLE_PAYLOAD));

  assert.equal(service.generalMeter.state.currentPowerW, 3260);

  // publishGeneralMeterRawPower est declenche en fire-and-forget depuis le
  // handler: laisser les microtasks se resoudre avant de verifier les publish.
  await flushMicrotasks();
  await flushMicrotasks();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/raw/conso_net_eim_wNow"], "3260");
  assert.equal(byTopic["envoy/123456789/raw/conso_all_eim_wNow"], "3760");
});

test("un message MQTT du capteur general met a jour voltage/current et calcule import/export depuis la baseline configurée", () => {
  const { service } = createService({
    generalMeterImportBaselineWh: 4_769_550,
    generalMeterExportBaselineWh: 7_420,
  });

  let messageHandler;
  service.installMqttListeners({
    subscribe() {},
    on(event, handler) {
      if (event === "message") messageHandler = handler;
    },
  });

  messageHandler(Buffer.from("zigbee2mqtt/general"), Buffer.from(SAMPLE_PAYLOAD));

  assert.equal(service.generalMeter.state.voltageV, 226.8);
  assert.equal(service.generalMeter.state.currentA, 14.47);
  // energy: 4769.55 kWh == baseline exactement -> 0 pour ce premier message.
  assert.equal(service.generalMeter.state.import.energyWh, 0);
  assert.equal(service.generalMeter.state.export.energyWh, 0);

  const nextPayload = JSON.stringify({
    power: 3300,
    voltage: 227.1,
    current: 14.5,
    energy: 4769.65, // +100 Wh depuis la baseline
    produced_energy: 7.43, // +10 Wh depuis la baseline
  });
  messageHandler(Buffer.from("zigbee2mqtt/general"), Buffer.from(nextPayload));

  assert.equal(service.generalMeter.state.import.energyWh, 100);
  assert.equal(service.generalMeter.state.export.energyWh, 10);
});

test("un message sur un autre topic n'affecte pas l'etat du capteur general", () => {
  const { service } = createService();
  service.generalMeter.state.currentPowerW = 42;

  let messageHandler;
  service.installMqttListeners({
    subscribe() {},
    on(event, handler) {
      if (event === "message") messageHandler = handler;
    },
  });

  messageHandler(Buffer.from("some/other/topic"), Buffer.from(SAMPLE_PAYLOAD));

  assert.equal(service.generalMeter.state.currentPowerW, 42);
});

test("publishRawLoop republie prod/conso_net/conso_all et met a jour lastProdEimWNow", async () => {
  const { service, publishedTopics } = createService({
    api: {
      getRawData: async () => {
        service.running = false; // une seule iteration de la boucle
        return {
          prod_eim_wNow: 1200,
          conso_net_eim_wNow: -999, // valeur TOR, doit etre ecrasee
          conso_all_eim_wNow: -999, // idem
          timestamp: 1720000000,
        };
      },
    },
  });
  service.generalMeter.state.currentPowerW = 300; // dernier connu du capteur general
  service.running = true;

  await service.publishRawLoop();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/raw/prod_eim_wNow"], "1200");
  assert.equal(byTopic["envoy/123456789/raw/conso_net_eim_wNow"], "300");
  assert.equal(byTopic["envoy/123456789/raw/conso_all_eim_wNow"], "1500");
  assert.equal(byTopic["envoy/123456789/raw/timestamp"], "1720000000");
  assert.equal(service.generalMeter.state.lastProdEimWNow, 1200);
});

test("publishRawLoop republie conso_net_energy_flow en heartbeat depuis le dernier etat connu", async () => {
  const { service, publishedTopics } = createService({
    api: {
      getRawData: async () => {
        service.running = false;
        return { prod_eim_wNow: 1200 };
      },
    },
  });
  service.generalMeter.state.currentPowerW = -300;
  service.generalMeter.state.energyFlow = "producing";
  service.running = true;

  await service.publishRawLoop();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/raw/conso_net_energy_flow"], "producing");
});

test("publishRawLoop n'ecrit pas conso_net_energy_flow tant qu'aucun message du capteur n'a ete recu", async () => {
  const { service, publishedTopics } = createService({
    api: {
      getRawData: async () => {
        service.running = false;
        return { prod_eim_wNow: 1200 };
      },
    },
  });
  service.running = true;

  await service.publishRawLoop();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/raw/conso_net_energy_flow"], undefined);
});

test("publishRawLoop clampe prod_eim_wNow sous 5W a 0, repercute sur conso_all", async () => {
  const { service, publishedTopics } = createService({
    api: {
      getRawData: async () => {
        service.running = false;
        return { prod_eim_wNow: 3, conso_net_eim_wNow: 0, conso_all_eim_wNow: 0 };
      },
    },
  });
  service.generalMeter.state.currentPowerW = 100;
  service.running = true;

  await service.publishRawLoop();

  const byTopic = Object.fromEntries(publishedTopics.map((p) => [p.topic, p.payload]));
  assert.equal(byTopic["envoy/123456789/raw/prod_eim_wNow"], "0");
  assert.equal(byTopic["envoy/123456789/raw/conso_all_eim_wNow"], "100");
  assert.equal(service.generalMeter.state.lastProdEimWNow, 0);
});

test("deriveFullData integre conso_net/current/grid/eco/conso_all depuis l'etat du capteur général — voltage et import ne sont plus publiés", () => {
  const { service } = createService({
    generalMeterImportBaselineWh: 1_000_000,
    generalMeterExportBaselineWh: 200_000,
  });

  service.generalMeter.state.currentPowerW = 320;
  service.generalMeter.state.voltageV = 231.5; // toujours suivi en interne, plus publié
  service.generalMeter.state.currentA = 1.38;
  service.generalMeter.state.import.energyWh = 5_000;
  service.generalMeter.state.export.energyWh = 1_200;

  const out = service.deriveFullData({ "prod/wNow": 1000, "prod/whLifetime": 50_000 });

  assert.equal(out["conso_net/wNow"], 320);
  assert.equal(out["conso_net/voltage"], undefined); // rationalisé sur prod/voltage
  assert.equal(out["conso_net/current"], 1.38);

  assert.equal(out["import/whLifetime"], undefined); // plus de topic/sensor dedié
  assert.equal(out["to_grid/whLifetime"], 1_200);
  assert.equal(out["eco/whLifetime"], 48_800); // prod(50000) - to_grid(1200)
  assert.equal(out["conso_all/whLifetime"], 53_800); // import(5000, interne) + eco(48800)
  assert.equal(out["conso_net/whLifetime"], 3_800); // import(5000, interne) - to_grid(1200)
});

test("deriveFullData applique prodBaselineWh a eco/conso_all sans toucher au prod/whLifetime publié", () => {
  const { service } = createService({
    generalMeterImportBaselineWh: 1_000_000,
    generalMeterExportBaselineWh: 200_000,
    prodBaselineWh: 12_726_270,
  });

  service.generalMeter.state.currentPowerW = 0;
  service.generalMeter.state.import.energyWh = 1_080;
  service.generalMeter.state.export.energyWh = 0;

  const out = service.deriveFullData({ "prod/whLifetime": 12_726_270 });

  assert.equal(out["prod/whLifetime"], 12_726_270); // inchangé, valeur absolue Envoy
  assert.equal(out["eco/whLifetime"], 0); // (12_726_270 - 12_726_270) - export(0)
  assert.equal(out["conso_all/whLifetime"], 1_080); // import(1080) + eco(0)
});

test("deriveFullData ne produit aucun champ derive du capteur général tant qu'aucune baseline n'est configurée", () => {
  const { service } = createService();

  const out = service.deriveFullData({ "prod/wNow": 1000 });

  assert.equal(out["conso_net/wNow"], undefined);
  assert.equal(out["import/whLifetime"], undefined);
  assert.equal(out["to_grid/whLifetime"], undefined);
  assert.equal(out["eco/whLifetime"], undefined);
  assert.equal(out["conso_all/whLifetime"], undefined);
});
