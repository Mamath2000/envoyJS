export async function publishEnergySensorDiscovery({ mqtt, baseTopic, name, field }) {
  const sensorId = name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[()]/g, "");

  const discoveryTopic = `homeassistant/sensor/${sensorId}/${field}/config`;
  const payload = {
    unique_id: `${sensorId}_${field}`,
    object_id: `${sensorId}_${field}`,
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

  await new Promise((resolve, reject) => {
    mqtt.publish(discoveryTopic, JSON.stringify(payload), { retain: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function publishPvProductionSensors({ mqtt, topic, data }) {
  const pvData = {
    energy: data["prod_eim_kwhLifetime"],
    power: data["prod_eim_wNow"] ?? 0,
    facteur_de_puiss: data["prod_eim_pwrFactor"],
    voltage: data["prod_eim_voltage"],
    current: data["prod_eim_current"],
  };

  await new Promise((resolve, reject) => {
    mqtt.publish(topic, JSON.stringify(pvData), { retain: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function publishConsumptionSensors({ mqtt, topic, data }) {
  const wNow = Number(data["conso_net_eim_wNow"] ?? 0);

  const payload = {
    energy: data["conso_net_eim_kwhLifetime"],
    energy_flow: wNow > 0 ? "consuming" : "producing",
    power_cons: Math.max(0, wNow),
    power: data["conso_net_eim_wNow"],
    facteur_de_puiss: data["conso_net_eim_pwrFactor"],
    voltage: data["conso_net_eim_voltage"],
    current: data["conso_net_eim_current"],
  };

  await new Promise((resolve, reject) => {
    mqtt.publish(topic, JSON.stringify(payload), { retain: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
