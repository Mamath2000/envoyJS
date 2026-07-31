import fs from "node:fs";
import path from "node:path";
import mqtt from "mqtt";

import { sleep } from "./utils.js";
import { publishHaAutodiscoveryDynamic } from "./ha/discovery.js";
import { createLogger } from "./logger.js";
import {
  publishConsumptionSensors,
  publishEnergySensorDiscovery,
  publishPvProductionSensors,
} from "./ha/energySensors.js";
import { deriveEnvoyFields } from "./envoyDerivedFields.js";

export class EnvoyMqttService {
  constructor({ config, api, log } = {}) {
    this.config = config;
    this.api = api;

    this.log =
      log ??
      createLogger({ level: process.env.LOG_LEVEL ?? this.config?.logLevel, component: "service" });

    this.mqttClient = undefined;
    this.running = false;

    this.haDiscoveryPublished = false;

    this.baseTopic = this.config.mqttBaseTopic;
    this.serial = this.config.serialNumber;
    this.topicRaw = `${this.baseTopic}/${this.serial}/raw`;
    this.topicData = `${this.baseTopic}/${this.serial}/data`;
    this.topicDebug = `${this.baseTopic}/${this.serial}/debug`;

    this.dailySensors = [
      "conso_all/whLifetime",
      "conso_net/whLifetime",
      "prod/whLifetime",
      "eco/whLifetime",
      "to_grid/whLifetime",
    ];

    this.midnightReferences = {};
    this.lastMidnightCheck = undefined;
    // Dernier relevé complet du tick precedent (voir publishFullLoop /
    // checkAndUpdateMidnightReferences) — jamais persisté, RAM neuve a chaque
    // redemarrage.
    this.previousFullData = undefined;
    this.midnightReferencesStateFilePath = this.resolveStateFilePath(
      this.config.midnightReferencesStateFile,
      "midnight-references-state.json",
    );

    // Capteur general (zigbee bidirectionnel), place sur "le general" (meme
    // point que l'ancien compteur EDF, en amont de la scission maison/tableau
    // ext): il voit l'integralite du flux reseau de l'installation, en
    // instantane (power/voltage/current) comme en cumule (deux registres
    // materiels independants, import et export/"to_grid"). Remplace a la fois
    // le TOR net-consumption de l'Envoy, le tableau elec (capteur relocalise
    // sur le general) et le compteur EDF/Linky (tous deux retires).
    //
    // La baseline de chaque registre est une CONSTANTE de configuration
    // (sensors.general_meter.import_baseline_wh/export_baseline_wh), relevée
    // une seule fois par l'utilisateur a l'installation physique du capteur —
    // le code ne la capture jamais tout seul et ne la met jamais a jour
    // ensuite (voir applyGeneralMeterReading: `energyWh = brut - baseline`,
    // garde-fou monotone contre les glitches, mais la baseline elle-meme est
    // figee pour toute la duree de vie du capteur). Aucune persistance disque
    // necessaire: rien d'autre qu'une constante de config n'a besoin de
    // survivre a un redemarrage.
    this.generalMeter = {
      topic: this.config.generalMeterTopic,
      powerField: this.config.generalMeterPowerField || "power",
      voltageField: this.config.generalMeterVoltageField || "voltage",
      currentField: this.config.generalMeterCurrentField || "current",
      energyFlowField: this.config.generalMeterEnergyFlowField || "energy_flow",
      importIndexField: this.config.generalMeterImportIndexField || "energy",
      exportIndexField: this.config.generalMeterExportIndexField || "produced_energy",
      indexUnit: this.config.generalMeterIndexUnit || "kwh",
      state: {
        currentPowerW: undefined,
        voltageV: undefined,
        currentA: undefined,
        // Sens du flux tel que remonté par le capteur ("producing"/"consuming"),
        // utilisé pour signer currentPowerW dès la lecture du payload (voir
        // parseGeneralMeterPayload) et republié tel quel jusqu'à HA (voir
        // getExternalInputs / deriveEnvoyFields).
        energyFlow: undefined,
        // Dernier prod_wNow connu (rafraichi par publishRawLoop au rythme
        // du polling Envoy), utilise pour calculer conso_all_wNow des
        // qu'un nouveau message du capteur general arrive.
        lastProdWNow: 0,
        // Dernier payload brut recu (avant parsing), pour publication en mode
        // debug (voir publishDebugPayloads). Non persisté.
        lastRawPayload: undefined,
        import: { baselineWh: this.config.generalMeterImportBaselineWh, energyWh: 0 },
        export: { baselineWh: this.config.generalMeterExportBaselineWh, energyWh: 0 },
      },
    };

    this.haDevice = {
      identifiers: [this.serial],
      manufacturer: "Enphase",
      model: "Envoy S Meter",
      name: "Envoy",
    };

    this.sensorsDef = {};
    const sensorsPath = path.join(process.cwd(), "src", "device-def", "sensors-def.json");
    try {
      if (fs.existsSync(sensorsPath)) {
        const content = fs.readFileSync(sensorsPath, "utf-8");
        this.sensorsDef = JSON.parse(content);
      }
    } catch {
      this.sensorsDef = {};
    }
  }

  async waitForMqttConnect(client, timeoutMs) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`Timeout connexion MQTT après ${timeoutMs}ms`));
      }, timeoutMs);

      client.once("connect", () => {
        clearTimeout(t);
        resolve();
      });

      client.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
  }

  getNowPartsInTz() {
    const tz = this.config.timeZoneName || "Europe/Paris";
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // Important: certains environnements retournent "24" à minuit.
      // En forçant h23, on obtient 00..23. (Et on garde un fallback plus bas.)
      hourCycle: "h23",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    let hour = Number(get("hour") || 0);
    const minute = Number(get("minute") || 0);
    const second = Number(get("second") || 0);

    let date = year && month && day ? `${year}-${month}-${day}` : new Date().toISOString().slice(0, 10);

    // Fallback robuste: si l'heure arrive à 24 (observé sur certains runtimes à minuit),
    // on la ramène à 0 et on avance la date d'un jour.
    if (hour === 24 && year && month && day) {
      hour = 0;
      const base = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      const next = new Date(base.getTime() + 24 * 60 * 60 * 1000);
      date = next.toISOString().slice(0, 10);
    }

    return { date, hour, minute, second };
  }

  resolveStateFilePath(configuredPath, defaultFileName) {
    const fallback = path.join(process.cwd(), "data", defaultFileName);
    const p = String(configuredPath ?? "").trim();
    if (!p) return fallback;
    if (path.isAbsolute(p)) return p;
    return path.join(process.cwd(), p);
  }

  loadMidnightReferencesFromDisk() {
    const stateFilePath = this.midnightReferencesStateFilePath;
    if (!stateFilePath || !fs.existsSync(stateFilePath)) return;

    try {
      const raw = fs.readFileSync(stateFilePath, "utf-8");
      const persisted = JSON.parse(raw);

      // Format sur disque: midnightReferences.index_00h/conso_yesterday, cles
      // = nom court du capteur (ex: "conso_all"), plus lisible que le format
      // interne a plat ("conso_all/whLifetime"/"conso_all/yesterday") utilisé
      // en memoire (voir dailySensors, calculateDailyValues).
      const index00h = persisted?.midnightReferences?.index_00h;
      if (index00h && typeof index00h === "object") {
        for (const [sensor, value] of Object.entries(index00h)) {
          const numeric = Number(value);
          if (Number.isFinite(numeric)) this.midnightReferences[`${sensor}/whLifetime`] = numeric;
        }
      }

      const consoYesterday = persisted?.midnightReferences?.conso_yesterday;
      if (consoYesterday && typeof consoYesterday === "object") {
        for (const [sensor, value] of Object.entries(consoYesterday)) {
          const numeric = Number(value);
          if (Number.isFinite(numeric)) this.midnightReferences[`${sensor}/yesterday`] = numeric;
        }
      }

      if (/^\d{4}-\d{2}-\d{2}$/.test(String(persisted?.lastMidnightCheck ?? ""))) {
        this.lastMidnightCheck = persisted.lastMidnightCheck;
      }

      this.log.info("references minuit restaurées depuis disque", {
        stateFilePath,
        sensors: Object.keys(this.midnightReferences).length,
        lastMidnightCheck: this.lastMidnightCheck,
      });
    } catch (err) {
      this.log.warn("impossible de lire les references minuit", {
        stateFilePath,
        message: err?.message ?? String(err),
      });
    }
  }

  async republishMidnightReferencesToMqtt() {
    for (const sensor of this.dailySensors) {
      const refValue = this.midnightReferences[sensor];
      if (refValue != null) {
        await this.publish(`${this.topicData}/${sensor}_00h`, String(refValue), { retain: true });
      }

      const yesterdayField = sensor.replace("whLifetime", "yesterday");
      const yesterdayValue = this.midnightReferences[yesterdayField];
      if (yesterdayValue != null) {
        await this.publish(`${this.topicData}/${yesterdayField}`, String(yesterdayValue), { retain: true });
      }
    }

    if (this.lastMidnightCheck != null) {
      await this.publish(`${this.topicData}/last_midnight_check`, this.lastMidnightCheck, { retain: true });
    }
  }

  saveMidnightReferencesToDisk() {
    const stateFilePath = this.midnightReferencesStateFilePath;
    if (!stateFilePath) return;

    try {
      fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });

      // Re-derive index_00h/conso_yesterday (nom court) depuis le format
      // interne a plat — voir loadMidnightReferencesFromDisk.
      const index00h = {};
      const consoYesterday = {};
      for (const [key, value] of Object.entries(this.midnightReferences)) {
        if (key.endsWith("/whLifetime")) {
          index00h[key.slice(0, -"/whLifetime".length)] = value;
        } else if (key.endsWith("/yesterday")) {
          consoYesterday[key.slice(0, -"/yesterday".length)] = value;
        }
      }

      const payload = {
        midnightReferences: { index_00h: index00h, conso_yesterday: consoYesterday },
        lastMidnightCheck: this.lastMidnightCheck ?? null,
      };
      fs.writeFileSync(stateFilePath, JSON.stringify(payload), "utf-8");
    } catch (err) {
      this.log.warn("impossible de sauvegarder les references minuit", {
        stateFilePath,
        message: err?.message ?? String(err),
      });
    }
  }

  async start() {
    this.running = true;

    const url = `mqtt://${this.config.mqttHost}:${this.config.mqttPort}`;
    this.log.info(`connexion MQTT à ${url} ...`);
    const client = mqtt.connect(url, {
      username: this.config.mqttUsername,
      password: this.config.mqttPassword,
      reconnectPeriod: 2000,
      connectTimeout: 60_000,
    });
    this.mqttClient = client;

    client.on("connect", () => this.log.info("MQTT connecté"));
    client.on("reconnect", () => this.log.warn("MQTT reconnect..."));
    client.on("offline", () => this.log.warn("MQTT offline"));
    client.on("close", () => this.log.warn("MQTT close"));
    client.on("error", (err) => this.log.error("MQTT error", { message: err?.message ?? String(err) }));

    await this.waitForMqttConnect(client, 60_000);

    await this.publishStatus("online");

    this.installMqttListeners(client);
    this.loadMidnightReferencesFromDisk();
    // Le fichier disque est la source de verite au demarrage: on republie
    // immediatement en retained pour resynchroniser MQTT/HA, sans attendre un
    // eventuel rollover (qui peut n'arriver que 24h plus tard).
    await this.republishMidnightReferencesToMqtt();

    if (!this.generalMeter.topic) {
      this.log.warn(
        "capteur général non configuré (sensors.general_meter.topic): conso_net, import, to_grid/from_grid et eco ne seront pas produits",
      );
    } else {
      if (!Number.isFinite(this.generalMeter.state.import.baselineWh)) {
        this.log.warn(
          "sensors.general_meter.import_baseline_wh manquant: import/whLifetime ne sera pas produit",
        );
      }
      if (!Number.isFinite(this.generalMeter.state.export.baselineWh)) {
        this.log.warn(
          "sensors.general_meter.export_baseline_wh manquant: to_grid/eco/conso_all (whLifetime) ne seront pas produits",
        );
      }
    }

    try {
      const currentData = await this.getCorrectedFullData();
      await this.initializeMissingReferences(currentData);

      if (this.config.haAutodiscovery) {
        const dailyKeys = Object.keys(this.calculateDailyValues(currentData));
        const yesterdayKeys = dailyKeys.map((k) => k.replace("today", "yesterday"));
        const allFields = [...Object.keys(currentData), ...dailyKeys, ...yesterdayKeys];

        await publishHaAutodiscoveryDynamic({
          mqtt: client,
          device: this.haDevice,
          topicData: this.topicData,
          fields: allFields,
          sensorsDef: this.sensorsDef,
          configTopicOverride: this.config.haDiscoveryTopic,
          qos: this.config.haDiscoveryQos,
          log: this.log.child("ha"),
        });

        if (this.config.pvProdSensorEnabled) {
          await publishEnergySensorDiscovery({
            mqtt: client,
            baseTopic: this.config.pvProdTopic,
            name: this.config.pvProdSensorName,
            field: "energy",
            log: this.log.child("ha"),
          });
        }

        if (this.config.consoNetSensorEnabled) {
          await publishEnergySensorDiscovery({
            mqtt: client,
            baseTopic: this.config.consoNetTopic,
            name: this.config.consoNetSensorName,
            field: "energy",
            log: this.log.child("ha"),
          });
        }

        this.haDiscoveryPublished = true;
      }
    } catch (err) {
      this.log.warn("lecture initiale Envoy impossible (le service continue)", { message: err?.message ?? String(err) });
    }

    const tasks = [];
    if (this.config.highFrequencyEnabled) tasks.push(this.publishRawLoop());
    tasks.push(this.publishFullLoop());

    await Promise.all(tasks);
  }

  async stop() {
    this.running = false;

    if (this.mqttClient) {
      try {
        await this.publishStatus("offline");
      } catch {
        // ignore
      }

      await new Promise((resolve) => {
        this.mqttClient?.end(true, {}, () => resolve());
      });
    }
  }

  installMqttListeners(client) {
    if (this.generalMeter.topic) {
      client.subscribe(this.generalMeter.topic);
      this.log.info("capteur général MQTT activé", {
        topic: this.generalMeter.topic,
        powerField: this.generalMeter.powerField,
        voltageField: this.generalMeter.voltageField,
        currentField: this.generalMeter.currentField,
        importIndexField: this.generalMeter.importIndexField,
        exportIndexField: this.generalMeter.exportIndexField,
        indexUnit: this.generalMeter.indexUnit,
        importBaselineWh: this.generalMeter.state.import.baselineWh,
        exportBaselineWh: this.generalMeter.state.export.baselineWh,
      });
    }

    client.on("message", (topicBuf, payloadBuf) => {
      const topic = String(topicBuf);
      const payload = payloadBuf.toString();

      if (this.generalMeter.topic && topic === this.generalMeter.topic) {
        this.generalMeter.state.lastRawPayload = payload;

        const { powerW, voltageV, currentA, energyFlow, importWh, exportWh } =
          this.parseGeneralMeterPayload(payload);
        if (!Number.isFinite(powerW)) return;

        this.generalMeter.state.currentPowerW = powerW;
        if (Number.isFinite(voltageV)) this.generalMeter.state.voltageV = voltageV;
        if (Number.isFinite(currentA)) this.generalMeter.state.currentA = currentA;
        if (energyFlow != null) this.generalMeter.state.energyFlow = energyFlow;

        // energyWh = brut - baseline, calcule des la lecture du payload (voir
        // applyGeneralMeterReading) — la baseline elle-meme est une constante
        // de config, jamais touchee ici.
        if (Number.isFinite(importWh)) {
          this.applyGeneralMeterReading(this.generalMeter.state.import, importWh, "capteur général (import)");
        }
        if (Number.isFinite(exportWh)) {
          this.applyGeneralMeterReading(this.generalMeter.state.export, exportWh, "capteur général (export)");
        }

        // Publication immediate (pas d'attente du tick de publishRawLoop): le
        // capteur general pousse ses messages bien plus vite (~3/s) que le
        // polling Envoy — decoupler leur publication du timer permet a
        // conso_net_wNow/conso_all_wNow de suivre ce rythme.
        this.publishGeneralMeterRawPower(powerW).catch((err) => {
          this.log.warn("publication raw capteur général échouée", {
            message: err?.message ?? String(err),
          });
        });
      }
    });
  }

  async publishGeneralMeterRawPower(powerW) {
    const netW = Math.round(powerW);
    const allW = Math.round(this.generalMeter.state.lastProdWNow + powerW);

    await this.publish(`${this.topicRaw}/conso_net_wNow`, String(netW), { retain: false, debug: false });
    await this.publish(`${this.topicRaw}/conso_all_wNow`, String(allW), { retain: false, debug: false });

    if (this.generalMeter.state.energyFlow != null) {
      await this.publish(`${this.topicRaw}/conso_net_energy_flow`, this.generalMeter.state.energyFlow, {
        retain: false,
        debug: false,
      });
    }
  }

  async publishRawLoop() {
    const intervalMs = Math.max(250, Number(this.config.highFrequencyIntervalMs ?? 1000));

    this.log.debug("raw loop démarrée", { intervalMs });

    while (this.running) {
      const start = Date.now();
      try {
        const rawData = await this.api.getRawData({ debug: false });

        // prod_wNow reste borné par le rythme de polling Envoy (source
        // unique de la production) — bruit de veille clampé à 0 comme avant.
        const prodRaw = Number(rawData.prod_wNow);
        const prodW = Number.isFinite(prodRaw) && prodRaw < 5 ? 0 : prodRaw;
        if (Number.isFinite(prodW)) {
          this.generalMeter.state.lastProdWNow = prodW;
        }

        // conso_net_wNow/conso_all_wNow sont republiés ici comme
        // heartbeat (au rythme du tick Envoy) à partir du dernier état connu
        // du capteur général — leur publication "rapide" a lieu par ailleurs
        // dès reception d'un message MQTT du capteur (voir
        // publishGeneralMeterRawPower, appelé depuis installMqttListeners).
        const netW = Number.isFinite(this.generalMeter.state.currentPowerW)
          ? this.generalMeter.state.currentPowerW
          : 0;
        const adjustedRawData = {
          ...rawData,
          prod_wNow: prodW,
          conso_net_wNow: Math.round(netW),
          conso_all_wNow: Math.round(this.generalMeter.state.lastProdWNow + netW),
        };
        if (this.generalMeter.state.energyFlow != null) {
          adjustedRawData.conso_net_energy_flow = this.generalMeter.state.energyFlow;
        }

        for (const [field, value] of Object.entries(adjustedRawData)) {
          const topic = `${this.topicRaw}/${field}`;
          await this.publish(topic, String(value), { retain: false, debug: false });
        }
      } catch (err) {
        this.log.warn("erreur lecture raw Envoy", { message: err?.message ?? String(err) });
      }

      const elapsed = Date.now() - start;
      const sleepMs = Math.max(0, intervalMs - elapsed);
      await sleep(sleepMs);
    }
  }

  async publishFullLoop() {
    this.log.debug("full loop démarrée", { intervalMs: this.config.pollingIntervalMs });
    while (this.running) {
      const start = Date.now();
      try {
        const fullData = await this.getCorrectedFullData();
        await this.publishDebugPayloads();
        await this.initializeMissingReferences(fullData);
        await this.checkAndUpdateMidnightReferences(fullData);
        // Servira de rolloverSnapshot au prochain tick (voir
        // checkAndUpdateMidnightReferences) — meilleure approximation de "minuit
        // reel" que la donnee live du tick qui detecte le changement de jour.
        this.previousFullData = fullData;

        if (this.config.haAutodiscovery && !this.haDiscoveryPublished) {
          const dailyKeys = Object.keys(this.calculateDailyValues(fullData));
          const yesterdayKeys = dailyKeys.map((k) => k.replace("today", "yesterday"));
          const allFields = [...Object.keys(fullData), ...dailyKeys, ...yesterdayKeys];

          await publishHaAutodiscoveryDynamic({
            mqtt: this.mustClient(),
            device: this.haDevice,
            topicData: this.topicData,
            fields: allFields,
            sensorsDef: this.sensorsDef,
            configTopicOverride: this.config.haDiscoveryTopic,
            qos: this.config.haDiscoveryQos,
            log: this.log.child("ha"),
          });

          if (this.config.pvProdSensorEnabled) {
            await publishEnergySensorDiscovery({
              mqtt: this.mustClient(),
              baseTopic: this.config.pvProdTopic,
              name: this.config.pvProdSensorName,
              field: "energy",
              log: this.log.child("ha"),
            });
          }

          if (this.config.consoNetSensorEnabled) {
            await publishEnergySensorDiscovery({
              mqtt: this.mustClient(),
              baseTopic: this.config.consoNetTopic,
              name: this.config.consoNetSensorName,
              field: "energy",
              log: this.log.child("ha"),
            });
          }

          this.haDiscoveryPublished = true;
        }

        const dailyValues = this.calculateDailyValues(fullData);

        for (const [field, value] of Object.entries(fullData)) {
          const topic = `${this.topicData}/${field}`;
          await this.publish(topic, String(value), { retain: true });
        }

        for (const [field, value] of Object.entries(dailyValues)) {
          const topic = `${this.topicData}/${field}`;
          await this.publish(topic, String(value), { retain: true });
        }

        if (this.config.pvProdSensorEnabled) {
          await publishPvProductionSensors({ mqtt: this.mustClient(), topic: this.config.pvProdTopic, data: fullData, log: this.log.child("ha") });
        }

        if (this.config.consoNetSensorEnabled) {
          await publishConsumptionSensors({ mqtt: this.mustClient(), topic: this.config.consoNetTopic, data: fullData, log: this.log.child("ha") });
        }
      } catch (err) {
        this.log.warn("erreur lecture full Envoy", { message: err?.message ?? String(err) });
      }

      const elapsed = Date.now() - start;
      const intervalMs = Math.max(1000, Number(this.config.pollingIntervalMs ?? 60_000));
      const sleepMs = Math.max(0, intervalMs - elapsed);
      await sleep(sleepMs);
    }
  }

  async publishStatus(status) {
    await this.publish(`${this.baseTopic}/${this.serial}/lwt`, status, { retain: true });
  }

  // Republie le dernier payload brut de chaque endpoint Envoy (avant tout
  // renommage/calcul) et du capteur general, un sous-topic par source, pour
  // faciliter le debug sans avoir a activer un sniffer HTTP/MQTT externe.
  // Actif uniquement si logging.level (ou LOG_LEVEL) vaut "debug".
  async publishDebugPayloads() {
    if (this.log.level !== "debug") return;

    const raw = this.api.lastRawPayloads ?? {};
    const entries = [
      ["meters_info", raw.metersInfo],
      ["meters_readings", raw.metersReadings],
      ["consumption_reports", raw.consumptionReports],
      ["production_v1", raw.productionV1],
    ];

    for (const [suffix, value] of entries) {
      if (value === undefined) continue;
      await this.publish(`${this.topicDebug}/${suffix}`, JSON.stringify(value), { retain: true, debug: false });
    }

    const generalMeterPayload = this.generalMeter.state.lastRawPayload;
    if (generalMeterPayload !== undefined) {
      await this.publish(`${this.topicDebug}/general_meter`, generalMeterPayload, { retain: true, debug: false });
    }
  }

  async initializeMissingReferences(currentData) {
    let changed = false;
    for (const sensor of this.dailySensors) {
      const existing = this.midnightReferences[sensor];
      if (existing == null && currentData[sensor] != null) {
        const value = Number(currentData[sensor]);
        if (!Number.isFinite(value)) continue;
        this.midnightReferences[sensor] = value;
        changed = true;
        const topic = `${this.topicData}/${sensor}_00h`;
        await this.publish(topic, String(value), { retain: true });
      }
    }
    if (changed) this.saveMidnightReferencesToDisk();
  }

  async checkAndUpdateMidnightReferences(currentData) {
    const now = this.getNowPartsInTz();
    const currentDate = now.date;

    if (this.lastMidnightCheck === undefined) {
      // Premier appel depuis le demarrage du service: on memorise juste le jour
      // courant sans declencher de rollover (sinon un demarrage a 14h serait pris
      // pour un changement de jour et ecraserait les references _00h a tort).
      this.lastMidnightCheck = currentDate;
      this.saveMidnightReferencesToDisk();
      return;
    }

    if (this.lastMidnightCheck === currentDate) return;

    // Le jour a change depuis la derniere iteration de la boucle complete, quelle
    // que soit l'heure exacte ou la valeur de polling.interval_ms: on ne rate
    // jamais le rollover (contrairement a une fenetre d'horloge fixe autour de
    // minuit) — seule sa precision depend de la frequence de polling.
    //
    // Cloture de yesterday et reamorcage de _00h a partir du MEME instant: si on
    // utilisait currentData (live au moment de la detection, potentiellement
    // arrive plusieurs heures apres minuit reel avec un gros polling.interval_ms
    // ou un redemarrage tardif), la conso ecoulee entre minuit et cet instant
    // serait comptee dans yesterday puis silencieusement perdue (jamais recomptee
    // dans today, puisque le nouveau _00h repartirait de cette meme valeur
    // gonflee). previousFullData (dernier relevé du tick precedent, mis a jour
    // dans publishFullLoop) est une bien meilleure approximation de "minuit reel"
    // — a defaut (ex: redemarrage a cheval sur minuit, RAM neuve), on retombe sur
    // currentData comme avant.
    const rolloverSnapshot = this.previousFullData ?? currentData;

    const dailyValues = this.calculateDailyValues(rolloverSnapshot);
    for (const [sensorToday, value] of Object.entries(dailyValues)) {
      const yesterdayField = sensorToday.replace("today", "yesterday");
      this.midnightReferences[yesterdayField] = Number(value);
      const topic = `${this.topicData}/${yesterdayField}`;
      await this.publish(topic, String(value), { retain: true });
    }

    for (const sensor of this.dailySensors) {
      if (rolloverSnapshot[sensor] == null) continue;
      const value = Number(rolloverSnapshot[sensor]);
      if (!Number.isFinite(value)) continue;
      this.midnightReferences[sensor] = value;
      const topic = `${this.topicData}/${sensor}_00h`;
      await this.publish(topic, String(value), { retain: true });
    }

    this.lastMidnightCheck = currentDate;
    this.saveMidnightReferencesToDisk();
    // Publié en retained (comme les topics _00h), pour affichage/debug uniquement:
    // la restauration au demarrage se fait desormais depuis le fichier d'etat
    // (voir doc 5.2), pas depuis ce topic.
    await this.publish(`${this.topicData}/last_midnight_check`, currentDate, { retain: true });

    if (this.config.haAutodiscovery && this.mqttClient) {
      const dailyKeys = Object.keys(dailyValues);
      const yesterdayKeys = dailyKeys.map((k) => k.replace("today", "yesterday"));
      const allFields = [...Object.keys(currentData), ...dailyKeys, ...yesterdayKeys];

      await publishHaAutodiscoveryDynamic({
        mqtt: this.mqttClient,
        device: this.haDevice,
        topicData: this.topicData,
        fields: allFields,
        sensorsDef: this.sensorsDef,
        configTopicOverride: this.config.haDiscoveryTopic,
        qos: this.config.haDiscoveryQos,
        log: this.log.child("ha"),
      });

      if (this.config.pvProdSensorEnabled) {
        await publishEnergySensorDiscovery({
          mqtt: this.mqttClient,
          baseTopic: this.config.pvProdTopic,
          name: this.config.pvProdSensorName,
          field: "energy",
          log: this.log.child("ha"),
        });
      }

      if (this.config.consoNetSensorEnabled) {
        await publishEnergySensorDiscovery({
          mqtt: this.mqttClient,
          baseTopic: this.config.consoNetTopic,
          name: this.config.consoNetSensorName,
          field: "energy",
          log: this.log.child("ha"),
        });
      }
    }
  }

  extractByPath(obj, pathExpr) {
    if (!pathExpr) return obj;
    return String(pathExpr)
      .split(".")
      .filter(Boolean)
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
  }

  normalizeGeneralMeterIndexWh(rawIndex) {
    const numeric = Number(rawIndex);
    if (!Number.isFinite(numeric)) return NaN;

    const unit = String(this.generalMeter.indexUnit ?? "kwh").toLowerCase();
    if (unit === "kwh") return numeric * 1000;
    if (unit === "wh") return numeric;

    // Heuristique "auto": decimal ou valeur "raisonnable" => kWh, sinon Wh.
    const asString = typeof rawIndex === "string" ? rawIndex.trim() : "";
    const hasDecimal = asString ? /[.,]/.test(asString) : !Number.isInteger(numeric);
    const abs = Math.abs(numeric);
    const looksLikeKwh = hasDecimal || abs <= 10_000;
    return looksLikeKwh ? numeric * 1000 : numeric;
  }

  // Le capteur general remonte "power" comme une magnitude non signée: le sens
  // du flux (import/export) est porte separement par energy_flow
  // ("producing"/"consuming"). On signe donc powerW ici, des la lecture du
  // payload — negatif en production/export, comme attendu partout ailleurs
  // dans le code (voir deriveEnvoyFields: netPowerW < 0 => export).
  signGeneralMeterPower(powerW, energyFlow) {
    if (!Number.isFinite(powerW)) return powerW;
    const flow = String(energyFlow ?? "").trim().toLowerCase();
    if (flow === "producing") return -Math.abs(powerW);
    if (flow === "consuming") return Math.abs(powerW);
    return powerW;
  }

  parseGeneralMeterPayload(payload) {
    const strPayload = String(payload ?? "").trim();
    if (!strPayload) {
      return { powerW: NaN, voltageV: NaN, currentA: NaN, energyFlow: undefined, importWh: NaN, exportWh: NaN };
    }

    let powerW = NaN;
    let voltageV = NaN;
    let currentA = NaN;
    let energyFlow;
    let importWh = NaN;
    let exportWh = NaN;

    try {
      const parsed = JSON.parse(strPayload);
      powerW = Number(this.extractByPath(parsed, this.generalMeter.powerField));
      voltageV = Number(this.extractByPath(parsed, this.generalMeter.voltageField));
      currentA = Number(this.extractByPath(parsed, this.generalMeter.currentField));

      const rawEnergyFlow = this.extractByPath(parsed, this.generalMeter.energyFlowField);
      if (rawEnergyFlow != null) energyFlow = String(rawEnergyFlow).trim().toLowerCase();

      powerW = this.signGeneralMeterPower(powerW, energyFlow);

      const rawImport = this.extractByPath(parsed, this.generalMeter.importIndexField);
      importWh = this.normalizeGeneralMeterIndexWh(rawImport);

      const rawExport = this.extractByPath(parsed, this.generalMeter.exportIndexField);
      exportWh = this.normalizeGeneralMeterIndexWh(rawExport);
    } catch {
      // payload non JSON: tous les champs restent NaN
    }

    if (!Number.isFinite(powerW)) {
      this.log.debug("message capteur general ignoré: puissance non numérique", {
        topic: this.generalMeter.topic,
        preview: strPayload.slice(0, 120),
      });
    }

    return { powerW, voltageV, currentA, energyFlow, importWh, exportWh };
  }

  // Calcule energyWh = brut - baseline pour un registre du capteur general
  // (import ou export), a chaque lecture du payload — voir
  // installMqttListeners. La baseline elle-meme (registerState.baselineWh)
  // est une constante de configuration (sensors.general_meter.*_baseline_wh),
  // relevée une fois pour toutes par l'utilisateur a l'installation physique
  // du capteur: cette fonction ne la capture ni ne la modifie jamais — si
  // elle est absente (mauvaise config), la lecture est simplement ignorée.
  //
  // Garde-fou monotone: tant que la baseline ne change pas, un registre
  // materiel ne peut physiquement pas faire baisser energyWh. Toute lecture
  // qui produirait une baisse est donc forcement un glitch (payload corrompu,
  // capteur qui redemarre) — elle est ignorée, jamais publiée. Un vrai
  // remplacement physique du capteur necessite de reconfigurer manuellement
  // une nouvelle baseline (sensors.general_meter.*_baseline_wh).
  applyGeneralMeterReading(registerState, indexWh, label) {
    if (!Number.isFinite(registerState.baselineWh)) {
      this.log.debug(`lecture ${label} ignorée: aucune baseline configurée`, {
        indexWh: Math.round(indexWh),
      });
      return;
    }

    const candidateEnergyWh = indexWh - registerState.baselineWh;
    if (candidateEnergyWh < registerState.energyWh) {
      this.log.debug(`lecture ${label} ignorée: energyWh en baisse (glitch probable)`, {
        previousEnergyWh: Math.round(registerState.energyWh),
        candidateEnergyWh: Math.round(candidateEnergyWh),
      });
      return;
    }

    registerState.energyWh = candidateEnergyWh;
  }

  getExternalInputs() {
    const importState = this.generalMeter.state.import;
    const exportState = this.generalMeter.state.export;

    return {
      generalMeterPowerW: this.generalMeter.state.currentPowerW,
      generalMeterCurrentA: this.generalMeter.state.currentA,
      generalMeterEnergyFlow: this.generalMeter.state.energyFlow,
      generalMeterImportWhLifetime: Number.isFinite(importState.baselineWh) ? importState.energyWh : undefined,
      generalMeterExportWhLifetime: Number.isFinite(exportState.baselineWh) ? exportState.energyWh : undefined,
      prodBaselineWh: this.config.prodBaselineWh,
    };
  }

  deriveFullData(rawFields) {
    return deriveEnvoyFields(rawFields, this.getExternalInputs());
  }

  async getCorrectedFullData({ debug } = {}) {
    const rawFields = await this.api.getAllEnvoyData({ debug });
    return this.deriveFullData(rawFields);
  }

  calculateDailyValues(currentData) {
    const dailyValues = {};

    for (const sensor of this.dailySensors) {
      const currentValue = currentData[sensor];
      const midnightRef = this.midnightReferences[sensor];
      if (currentValue == null || midnightRef == null) continue;

      const diff = Number(currentValue) - Number(midnightRef);
      const rounded = Math.round(diff);
      dailyValues[sensor.replace("whLifetime", "today")] = Math.max(0, rounded);
    }

    return dailyValues;
  }

  mustClient() {
    if (!this.mqttClient) throw new Error("MQTT non connecté");
    return this.mqttClient;
  }

  async publish(topic, payload, opts) {
    const client = this.mustClient();
    if (opts?.debug !== false) {
      this.log.debug("mqtt publish", {
        topic,
        retain: Boolean(opts?.retain),
        bytes: Buffer.byteLength(String(payload ?? "")),
      });
    }
    await new Promise((resolve, reject) => {
      client.publish(topic, payload, { retain: opts.retain }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
