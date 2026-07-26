import { createLogger } from "../logger.js";

// kWh n'est jamais publie comme champ MQTT separe (voir envoyDerivedFields.js):
// ces topics JSON dedies (pv_production/conso_net) le recalculent donc eux-memes
// depuis le whLifetime correspondant, au lieu de lire un champ kWh inexistant.
function toKwh(wh) {
  const n = Number(wh ?? 0);
  return Number.isFinite(n) ? Number((n / 1000).toFixed(3)) : undefined;
}

export async function publishEnergySensorDiscovery({ mqtt, baseTopic, name, field, log }) {
  const logger = log ?? createLogger({ level: process.env.LOG_LEVEL ?? "info", component: "ha" });
  const sensorId = name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[()]/g, "");

  const discoveryTopic = `homeassistant/sensor/${sensorId}/${field}/config`;
  const payload = {
    unique_id: `${sensorId}_${field}`,
    default_entity_id: `sensor.${sensorId}_${field}`,
    device: {
      identifiers: [sensorId],
      model: "Envoy Meter S",
      manufacturer: "Mamath",
      name,
    },
    enabled_by_default: true,
    device_class: "energy",
    unit_of_measurement: "kWh",
    state_class: "total_increasing",
    state_topic: baseTopic,
    json_attributes_topic: baseTopic,
    value_template: "{{ value_json.energy }}",
    origin: { name: "envoy2mqtt" },
  };

  logger.info("HA energy discovery: publication", { discoveryTopic, baseTopic, name, field });

  await new Promise((resolve, reject) => {
    mqtt.publish(discoveryTopic, JSON.stringify(payload), { retain: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  logger.debug("HA energy discovery: publié", { discoveryTopic });
}

export async function publishPvProductionSensors({ mqtt, topic, data, log }) {
  const logger = log ?? createLogger({ level: process.env.LOG_LEVEL ?? "info", component: "ha" });
  const pvData = {
    energy: toKwh(data["prod/whLifetime"]),
    power: data["prod/wNow"] ?? 0,
    voltage: data["prod/voltage"],
    current: data["prod/current"],
  };

  logger.debug("publish PV sensors", { topic });

  await new Promise((resolve, reject) => {
    mqtt.publish(topic, JSON.stringify(pvData), { retain: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function publishConsumptionSensors({ mqtt, topic, data, log }) {
  const logger = log ?? createLogger({ level: process.env.LOG_LEVEL ?? "info", component: "ha" });
  const wNow = Number(data["conso_net/wNow"] ?? 0);

  const payload = {
    energy: toKwh(data["conso_net/whLifetime"]),
    energy_flow: wNow > 0 ? "consuming" : "producing",
    power_cons: Math.max(0, wNow),
    power: data["conso_net/wNow"],
    voltage: data["prod/voltage"],
    current: data["conso_net/current"],
  };

  logger.debug("publish consumption sensors", { topic });

  await new Promise((resolve, reject) => {
    mqtt.publish(topic, JSON.stringify(payload), { retain: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
