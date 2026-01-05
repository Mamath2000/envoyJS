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

    this.installMidnightReferenceListener(client);
    await sleep(10_000);

    try {
      const currentData = await this.api.getAllEnvoyData();
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

  installMidnightReferenceListener(client) {
    for (const sensor of this.dailySensors) {
      const topic = `${this.topicData}/${sensor}_00h`;
      client.subscribe(topic);
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
    });
  }

  async publishRawLoop() {
    const intervalMs = Math.max(250, Number(this.config.highFrequencyIntervalMs ?? 1000));

    this.log.debug("raw loop démarrée", { intervalMs });

    while (this.running) {
      const start = Date.now();
      try {
        const rawData = await this.api.getRawData({ debug: false });
        for (const [field, value] of Object.entries(rawData)) {
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

  async publishFullLoop() {
    this.log.debug("full loop démarrée", { intervalMs: this.config.pollingIntervalMs });
    while (this.running) {
      const start = Date.now();
      try {
        const fullData = await this.api.getAllEnvoyData();
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
