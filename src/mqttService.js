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

const tableauElecRuntimeState = {
  currentPowerW: 0,
  energyFromIndexWh: 0,
  lastIndexWh: undefined,
};

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

    this.dailySensors = [
      "conso_all_eim_whLifetime",
      "conso_net_eim_whLifetime",
      "prod_eim_whLifetime",
      "grid_eim_whLifetime",
      "eco_eim_whLifetime",
    ];

    this.midnightReferences = {};
    this.lastMidnightCheck = undefined;

    this.tableauElec = {
      enabled: Boolean(this.config.tableauElecEnabled),
      topic: this.config.tableauElecTopic,
      powerField: this.config.tableauElecPowerField,
      indexField: this.config.tableauElecIndexField,
      indexUnit: this.config.tableauElecIndexUnit,
      stateFilePath: this.resolveTableauElecStateFilePath(this.config.tableauElecStateFile),
      sign: Number.isFinite(Number(this.config.tableauElecSign)) ? Number(this.config.tableauElecSign) : 1,
      state: tableauElecRuntimeState,
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

  resolveTableauElecStateFilePath(configuredPath) {
    const fallback = path.join(process.cwd(), "data", "tableau-elec-state.json");
    const p = String(configuredPath ?? "").trim();
    if (!p) return fallback;
    if (path.isAbsolute(p)) return p;
    return path.join(process.cwd(), p);
  }

  loadTableauElecStateFromDisk() {
    if (!this.tableauElec.enabled || !this.tableauElec.indexField) return;

    const stateFilePath = this.tableauElec.stateFilePath;
    if (!stateFilePath || !fs.existsSync(stateFilePath)) return;

    try {
      const raw = fs.readFileSync(stateFilePath, "utf-8");
      const persisted = JSON.parse(raw);

      const lastIndexWh = Number(persisted?.lastIndexWh);
      const energyFromIndexWh = Number(persisted?.energyFromIndexWh);

      if (Number.isFinite(lastIndexWh)) {
        this.tableauElec.state.lastIndexWh = lastIndexWh;
      }

      if (Number.isFinite(energyFromIndexWh)) {
        this.tableauElec.state.energyFromIndexWh = energyFromIndexWh;
      }

      this.log.info("etat tableau elec restauré depuis disque", {
        stateFilePath,
        hasLastIndex: Number.isFinite(this.tableauElec.state.lastIndexWh),
        energyFromIndexWh: Math.round(this.tableauElec.state.energyFromIndexWh || 0),
      });
    } catch (err) {
      this.log.warn("impossible de lire l'etat tableau elec", {
        stateFilePath,
        message: err?.message ?? String(err),
      });
    }
  }

  saveTableauElecStateToDisk() {
    if (!this.tableauElec.enabled || !this.tableauElec.indexField) return;

    const stateFilePath = this.tableauElec.stateFilePath;
    if (!stateFilePath) return;

    try {
      const stateDir = path.dirname(stateFilePath);
      fs.mkdirSync(stateDir, { recursive: true });

      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        lastIndexWh: Number.isFinite(this.tableauElec.state.lastIndexWh)
          ? this.tableauElec.state.lastIndexWh
          : null,
        energyFromIndexWh: Number.isFinite(this.tableauElec.state.energyFromIndexWh)
          ? this.tableauElec.state.energyFromIndexWh
          : 0,
      };

      const tmpPath = `${stateFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf-8");
      fs.renameSync(tmpPath, stateFilePath);
    } catch (err) {
      this.log.warn("impossible de sauvegarder l'etat tableau elec", {
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
    this.loadTableauElecStateFromDisk();

    if (this.tableauElec.enabled && !this.tableauElec.indexField) {
      this.log.warn("tableau elec sans index_field: correction energie des compteurs desactivée (puissance instantanee uniquement)");
    }

    await sleep(10_000);

    try {
      const envoyData = await this.api.getAllEnvoyData();
      const currentData = this.applyTableauElecOnConsoNet(envoyData);
      await this.initializeMissingReferences(currentData);

      if (this.config.haAutodiscovery) {
        const dailyKeys = Object.keys(this.calculateDailyValues(currentData));
        const yesterdayKeys = dailyKeys.map((k) => k.replace("_today", "_yesterday"));
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

    this.saveTableauElecStateToDisk();

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
    for (const sensor of this.dailySensors) {
      const topic = `${this.topicData}/${sensor}_00h`;
      client.subscribe(topic);
    }

    if (this.tableauElec.enabled && this.tableauElec.topic) {
      client.subscribe(this.tableauElec.topic);
      this.log.info("capteur tableau elec MQTT activé", {
        topic: this.tableauElec.topic,
        powerField: this.tableauElec.powerField,
        indexField: this.tableauElec.indexField,
        indexUnit: this.tableauElec.indexUnit,
        sign: this.tableauElec.sign,
        stateFilePath: this.tableauElec.stateFilePath,
        persistence: "fichier + mémoire process",
      });
    }

    client.on("message", (topicBuf, payloadBuf) => {
      const topic = String(topicBuf);
      const payload = payloadBuf.toString();

      for (const sensor of this.dailySensors) {
        const refTopic = `${this.topicData}/${sensor}_00h`;
        if (topic === refTopic) {
          const v = Number(payload);
          if (Number.isFinite(v)) {
            this.midnightReferences[sensor] = v;
          }
        }
      }

      if (this.tableauElec.enabled && this.tableauElec.topic && topic === this.tableauElec.topic) {
        const { powerW, indexWh } = this.parseTableauElecPayload(payload);
        if (!Number.isFinite(powerW) && !Number.isFinite(indexWh)) return;

        if (Number.isFinite(powerW)) {
          this.tableauElec.state.currentPowerW = Number(powerW);
        }

        if (Number.isFinite(indexWh)) {
          this.updateTableauElecIndexOffset(indexWh);
        }
      }
    });
  }

  async publishRawLoop() {
    const intervalMs = Math.max(250, Number(this.config.highFrequencyIntervalMs ?? 1000));

    this.log.debug("raw loop démarrée", { intervalMs });

    while (this.running) {
      const start = Date.now();
      try {
        const rawData = await this.api.getRawData({ debug: false });
        const adjustedRawData = this.applyTableauElecOnRawData(rawData);

        for (const [field, value] of Object.entries(adjustedRawData)) {
          const topic = `${this.topicRaw}/${field}`;
          if (field === "prod_eim_wNow" && Number(value) < 5) {
            await this.publish(topic, "0", { retain: false, debug: false });
          } else {
            await this.publish(topic, String(value), { retain: false, debug: false });
          }
        }
      } catch (err) {
        this.log.warn("erreur lecture raw Envoy", { message: err?.message ?? String(err) });
      }

      const elapsed = Date.now() - start;
      const sleepMs = Math.max(0, intervalMs - elapsed);
      await sleep(sleepMs);
    }
  }

  applyTableauElecOnRawData(rawData) {
    if (!this.tableauElec.enabled || !rawData || typeof rawData !== "object") return rawData;

    const adjusted = { ...rawData };
    const signedPowerW = this.tableauElec.state.currentPowerW * this.tableauElec.sign;

    const netW = Number(adjusted.conso_net_eim_wNow);
    if (Number.isFinite(netW)) {
      adjusted.conso_net_eim_wNow = Math.round(netW + signedPowerW);
    }

    const allW = Number(adjusted.conso_all_eim_wNow);
    if (Number.isFinite(allW)) {
      adjusted.conso_all_eim_wNow = Math.round(allW + signedPowerW);
    }

    return adjusted;
  }

  async publishFullLoop() {
    this.log.debug("full loop démarrée", { intervalMs: this.config.pollingIntervalMs });
    while (this.running) {
      const start = Date.now();
      try {
        const envoyData = await this.api.getAllEnvoyData();
        const fullData = this.applyTableauElecOnConsoNet(envoyData);
        await this.initializeMissingReferences(fullData);
        await this.checkAndUpdateMidnightReferences(fullData);

        if (this.config.haAutodiscovery && !this.haDiscoveryPublished) {
          const dailyKeys = Object.keys(this.calculateDailyValues(fullData));
          const yesterdayKeys = dailyKeys.map((k) => k.replace("_today", "_yesterday"));
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

  async initializeMissingReferences(currentData) {
    for (const sensor of this.dailySensors) {
      const existing = this.midnightReferences[sensor];
      if (existing == null && currentData[sensor] != null) {
        const value = Number(currentData[sensor]);
        if (!Number.isFinite(value)) continue;
        this.midnightReferences[sensor] = value;
        const topic = `${this.topicData}/${sensor}_00h`;
        await this.publish(topic, String(value), { retain: true });
      }
    }
  }

  async checkAndUpdateMidnightReferences(currentData) {
    const now = this.getNowPartsInTz();
    const currentDate = now.date;
    const isNearMidnight = now.hour === 0 && now.minute <= 5;

    if (!isNearMidnight) return;
    if (this.lastMidnightCheck && this.lastMidnightCheck >= currentDate) return;

    const dailyValues = this.calculateDailyValues(currentData);
    for (const [sensorToday, value] of Object.entries(dailyValues)) {
      const yesterdayField = sensorToday.replace("_today", "_yesterday");
      this.midnightReferences[yesterdayField] = Number(value);
      const topic = `${this.topicData}/${yesterdayField}`;
      await this.publish(topic, String(value), { retain: true });
    }

    for (const sensor of this.dailySensors) {
      if (currentData[sensor] == null) continue;
      const value = Number(currentData[sensor]);
      if (!Number.isFinite(value)) continue;
      this.midnightReferences[sensor] = value;
      const topic = `${this.topicData}/${sensor}_00h`;
      await this.publish(topic, String(value), { retain: true });
    }

    this.lastMidnightCheck = currentDate;

    if (this.config.haAutodiscovery && this.mqttClient) {
      const dailyKeys = Object.keys(dailyValues);
      const yesterdayKeys = dailyKeys.map((k) => k.replace("_today", "_yesterday"));
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

  normalizeTableauElecIndexWh(rawIndex) {
    const numeric = Number(rawIndex);
    if (!Number.isFinite(numeric)) return NaN;

    const unit = String(this.tableauElec.indexUnit ?? "auto").toLowerCase();
    if (unit === "kwh") return numeric * 1000;
    if (unit === "wh") return numeric;

    // Convention: les index Zigbee2MQTT sont generalement en kWh.
    // Heuristique: decimal ou valeur "raisonnable" => kWh, sinon Wh.
    const asString = typeof rawIndex === "string" ? rawIndex.trim() : "";
    const hasDecimal = asString ? /[.,]/.test(asString) : !Number.isInteger(numeric);
    const abs = Math.abs(numeric);
    const looksLikeKwh = hasDecimal || abs <= 10_000;
    return looksLikeKwh ? numeric * 1000 : numeric;
  }

  parseTableauElecPayload(payload) {
    const strPayload = String(payload ?? "").trim();
    if (!strPayload) return { powerW: NaN, indexWh: NaN };

    let powerW = NaN;
    let indexWh = NaN;

    if (!this.tableauElec.powerField) {
      const asNumber = Number(strPayload);
      if (Number.isFinite(asNumber)) powerW = asNumber;
    }

    try {
      const parsed = JSON.parse(strPayload);

      if (this.tableauElec.powerField) {
        powerW = Number(this.extractByPath(parsed, this.tableauElec.powerField));
      }

      if (!Number.isFinite(powerW) && typeof parsed === "number") {
        powerW = parsed;
      }

      if (!Number.isFinite(powerW) && parsed && typeof parsed === "object") {
        const candidates = [parsed.power, parsed.watt, parsed.watts, parsed.value, parsed.w];
        for (const candidate of candidates) {
          const n = Number(candidate);
          if (Number.isFinite(n)) {
            powerW = n;
            break;
          }
        }
      }

      if (this.tableauElec.indexField) {
        const rawIndex = this.extractByPath(parsed, this.tableauElec.indexField);
        indexWh = this.normalizeTableauElecIndexWh(rawIndex);
      }
    } catch {
      // payload non JSON: déjà tenté en nombre brut
    }

    if (!Number.isFinite(powerW) && !Number.isFinite(indexWh)) {
      this.log.debug("message tableau elec ignoré: payload non numérique", {
        topic: this.tableauElec.topic,
        preview: strPayload.slice(0, 120),
      });
    }

    return { powerW, indexWh };
  }

  updateTableauElecIndexOffset(indexWh) {
    const state = this.tableauElec.state;

    if (!Number.isFinite(indexWh)) return;

    if (!Number.isFinite(state.lastIndexWh)) {
      state.lastIndexWh = indexWh;
      this.saveTableauElecStateToDisk();
      this.log.debug("index tableau elec initialisé (valeur absolue ignorée, base différentielle)", {
        baselineWh: Math.round(indexWh),
      });
      return;
    }

    const deltaWh = indexWh - state.lastIndexWh;
    if (deltaWh < -1) {
      this.log.warn("index tableau elec en baisse: reset/rollover detecté, delta ignoré", {
        previousWh: Math.round(state.lastIndexWh),
        currentWh: Math.round(indexWh),
      });
      state.lastIndexWh = indexWh;
      this.saveTableauElecStateToDisk();
      return;
    }

    const safeDeltaWh = deltaWh < 0 ? 0 : deltaWh;
    state.energyFromIndexWh += safeDeltaWh * this.tableauElec.sign;
    state.lastIndexWh = indexWh;
    this.saveTableauElecStateToDisk();
  }

  applyTableauElecOnConsoNet(data) {
    if (!this.tableauElec.enabled || !data || typeof data !== "object") return data;

    const adjusted = { ...data };
    const signedPowerW = this.tableauElec.state.currentPowerW * this.tableauElec.sign;
    const energyOffsetWh = this.tableauElec.indexField && Number.isFinite(this.tableauElec.state.lastIndexWh)
      ? this.tableauElec.state.energyFromIndexWh
      : 0;

    const baseNetPowerW = Number(adjusted.conso_net_eim_wNow ?? 0);
    if (Number.isFinite(baseNetPowerW)) {
      const correctedNetPowerW = Math.round(baseNetPowerW + signedPowerW);
      adjusted.conso_net_eim_wNow = correctedNetPowerW;

      // Les champs de puissance dérivés du net doivent suivre la valeur corrigée.
      adjusted.grid_eim_wNow = correctedNetPowerW < 0 ? Math.abs(correctedNetPowerW) : 0;
      adjusted.grid_eim_wNow_binary = correctedNetPowerW > 0 ? 1 : 0;

      const prodW = Number(adjusted.prod_eim_wNow);
      if (Number.isFinite(prodW)) {
        adjusted.eco_eim_wNow = correctedNetPowerW < 0 ? prodW + correctedNetPowerW : prodW;
      }

      // Cohérence électrique demandée: I = P / U
      const netVoltageV = Number(adjusted.conso_net_eim_voltage);
      if (Number.isFinite(netVoltageV) && Math.abs(netVoltageV) > 0.1) {
        adjusted.conso_net_eim_current = Number((correctedNetPowerW / netVoltageV).toFixed(3));
      }
    }

    const baseAllPowerW = Number(adjusted.conso_all_eim_wNow);
    if (Number.isFinite(baseAllPowerW)) {
      adjusted.conso_all_eim_wNow = Math.round(baseAllPowerW + signedPowerW);
    }

    const baseNetWhLifetime = Number(adjusted.conso_net_eim_whLifetime);
    if (Number.isFinite(baseNetWhLifetime)) {
      adjusted.conso_net_eim_whLifetime = Math.max(0, Math.round(baseNetWhLifetime + energyOffsetWh));
    }

    const baseNetKwhLifetime = Number(adjusted.conso_net_eim_kwhLifetime);
    if (Number.isFinite(baseNetKwhLifetime)) {
      adjusted.conso_net_eim_kwhLifetime = Math.max(0, Number((baseNetKwhLifetime + energyOffsetWh / 1000).toFixed(3)));
    }

    const baseAllWhLifetime = Number(adjusted.conso_all_eim_whLifetime);
    if (Number.isFinite(baseAllWhLifetime)) {
      adjusted.conso_all_eim_whLifetime = Math.max(0, Math.round(baseAllWhLifetime + energyOffsetWh));
    }

    const baseAllKwhLifetime = Number(adjusted.conso_all_eim_kwhLifetime);
    if (Number.isFinite(baseAllKwhLifetime)) {
      adjusted.conso_all_eim_kwhLifetime = Math.max(0, Number((baseAllKwhLifetime + energyOffsetWh / 1000).toFixed(3)));
    }

    // to_grid (export) diminue quand la conso externe augmente, et inversement.
    const baseGridWhLifetime = Number(adjusted.grid_eim_whLifetime);
    if (Number.isFinite(baseGridWhLifetime)) {
      adjusted.grid_eim_whLifetime = Math.max(0, Math.round(baseGridWhLifetime - energyOffsetWh));
    }

    const baseGridKwhLifetime = Number(adjusted.grid_eim_kwhLifetime);
    if (Number.isFinite(baseGridKwhLifetime)) {
      adjusted.grid_eim_kwhLifetime = Math.max(0, Number((baseGridKwhLifetime - energyOffsetWh / 1000).toFixed(3)));
    }

    // economie = production - to_grid
    const prodWhLifetime = Number(adjusted.prod_eim_whLifetime);
    const gridWhLifetime = Number(adjusted.grid_eim_whLifetime);
    if (Number.isFinite(prodWhLifetime) && Number.isFinite(gridWhLifetime)) {
      adjusted.eco_eim_whLifetime = Math.max(0, Math.round(prodWhLifetime - gridWhLifetime));
    }

    const prodKwhLifetime = Number(adjusted.prod_eim_kwhLifetime);
    const gridKwhLifetime = Number(adjusted.grid_eim_kwhLifetime);
    if (Number.isFinite(prodKwhLifetime) && Number.isFinite(gridKwhLifetime)) {
      adjusted.eco_eim_kwhLifetime = Math.max(0, Number((prodKwhLifetime - gridKwhLifetime).toFixed(3)));
    }

    adjusted.tableau_elec_wNow = Math.round(signedPowerW);
    adjusted.tableau_elec_whOffset = Math.round(energyOffsetWh);

    return adjusted;
  }

  calculateDailyValues(currentData) {
    const dailyValues = {};

    for (const sensor of this.dailySensors) {
      const currentValue = currentData[sensor];
      const midnightRef = this.midnightReferences[sensor];
      if (currentValue == null || midnightRef == null) continue;

      const diff = Number(currentValue) - Number(midnightRef);
      const rounded = Math.round(diff);
      dailyValues[sensor.replace("_whLifetime", "_today")] = Math.max(0, rounded);
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
