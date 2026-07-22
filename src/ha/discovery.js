import { sanitizeHaId } from "../utils.js";
import { createLogger } from "../logger.js";

const HA_DISCOVERY_PREFIX = "homeassistant";

function valueTemplateFor(sensorDef) {
  const unit = sensorDef.unit_of_measurement;
  if (unit === "A") {
    return "{{ value | float(default=0) | round(2) }}";
  }
  return sensorDef.value_template ?? "{{ value | float(default=0) | round(0) }}";
}

export async function publishHaAutodiscoveryDynamic({
  mqtt,
  device,
  topicData,
  fields,
  sensorsDef,
  configTopicOverride,
  qos,
  log,
}) {
  const logger = log ?? createLogger({ level: process.env.LOG_LEVEL ?? "info", component: "ha" });
  const serial = device?.identifiers?.[0];
  if (!serial) {
    throw new Error("device.identifiers[0] manquant: impossible de publier l'autodiscovery");
  }

  const deviceId = sanitizeHaId(`envoy_${serial}`);
  const configTopic =
    typeof configTopicOverride === "string" && configTopicOverride.trim()
      ? configTopicOverride.trim()
      : `${HA_DISCOVERY_PREFIX}/device/${deviceId}/config`;

  const components = {};
  let publishedFields = 0;

  // On itere sur les definitions plutot que sur les champs publies: un capteur
  // "derive" (typiquement kWh, voir sensors-def.json) ne correspond a aucun
  // topic publie directement — il declare `source_field` pour reutiliser le
  // topic Wh d'un champ deja publie, avec son propre value_template (/1000).
  // `presenceField` sert de garde-fou dans les deux cas: le champ (reel ou
  // source) doit etre present dans ce cycle pour que le capteur soit decouvert.
  for (const [componentKey, def] of Object.entries(sensorsDef)) {
    const presenceField = def.source_field ?? componentKey;
    if (presenceField.endsWith("_00h")) continue;
    if (!fields.includes(presenceField)) continue;

    const platform = def.platform ?? "sensor";
    const componentId = sanitizeHaId(componentKey);

    let default_entity_id;
    if (def.name && def.name.trim()) {
      default_entity_id = `${platform}.envoy_${def.name}`
        .replace(/\s+/g, "_")
        .replace(/[()]/g, "")
        .toLowerCase();
    }

    const componentPayload = {
      platform,
      name: def.name,
      state_topic: `${topicData}/${presenceField}`,
      unit_of_measurement: def.unit_of_measurement,
      device_class: def.device_class,
      state_class: def.state_class,
      icon: def.icon,
      expire_after: def.expire_after ?? 120,
      value_template: valueTemplateFor(def),
      unique_id: `envoy_${serial}_${componentId}`,
      default_entity_id: default_entity_id,
      force_update: true,
      has_entity_name: true,
      payload_on: def.payload_on,
      payload_off: def.payload_off,
    };

    for (const [k, v] of Object.entries(componentPayload)) {
      if (v == null) delete componentPayload[k];
    }

    components[componentId] = componentPayload;
    publishedFields += 1;
  }

  if (publishedFields === 0) return;

  logger.info("HA autodiscovery: publication", {
    deviceId,
    serial,
    configTopic,
    entities: publishedFields,
    qos: typeof qos === "number" ? qos : undefined,
  });

  const payload = {
    device,
    origin: { name: "envoy2mqtt" },
    components,
  };

  await new Promise((resolve, reject) => {
    mqtt.publish(configTopic, JSON.stringify(payload), { retain: true, qos: typeof qos === "number" ? qos : undefined }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  logger.debug("HA autodiscovery: publié", { deviceId, configTopic, entities: publishedFields });
}
