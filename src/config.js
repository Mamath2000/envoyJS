import fs from "node:fs";
import path from "node:path";

let yaml;
try {
  yaml = await import("yaml");
} catch {
  yaml = null;
}

function findConfigFile() {
  const candidates = [
    path.join(process.cwd(), "config.yaml"),
    path.join(process.cwd(), "config.yml"),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const st = fs.statSync(filePath);
      if (st.isFile()) return filePath;
    } catch {
      // ignore
    }
  }
  return null;
}

function applyTemplateVars(value, vars) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([^}]+)\}/g, (_m, key) => {
    const trimmed = String(key).trim();
    return vars[trimmed] != null ? String(vars[trimmed]) : "";
  });
}

function deepApplyTemplates(obj, vars) {
  if (Array.isArray(obj)) return obj.map((v) => deepApplyTemplates(v, vars));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deepApplyTemplates(v, vars);
    }
    return out;
  }
  return applyTemplateVars(obj, vars);
}

function loadFromYamlIfPresent() {
  const filePath = findConfigFile();
  if (!filePath) return null;
  if (!yaml) {
    throw new Error(
      `Le fichier ${path.basename(filePath)} existe mais la dépendance 'yaml' n'est pas installée. Lance: npm install yaml`,
    );
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.parse(content);

  const serial = parsed?.envoy?.serial;
  const vars = {
    "envoy.serial": serial,
  };

  return deepApplyTemplates(parsed, vars);
}

export function loadConfig() {
  const fileCfg = loadFromYamlIfPresent();
  if (!fileCfg) {
    throw new Error(
      "Aucun config.yaml trouvé. Crée config.yaml à la racine du projet (ou config/config.yaml).",
    );
  }
  const cfg = fileCfg;

  const haDiscoveryEnabled = Boolean(
    cfg?.discovery?.enabled ?? cfg?.discovery?.aggregated ?? false,
  );

  const serial = String(cfg?.envoy?.serial ?? "").trim();
  const baseUrl = String(cfg?.envoy?.base_url ?? "").trim().replace(/\/$/, "");
  const username = String(cfg?.auth?.owner_email ?? "").trim();
  const password = String(cfg?.auth?.owner_password ?? "");

  if (!serial) throw new Error("config: envoy.serial est requis");
  if (!baseUrl) throw new Error("config: envoy.base_url est requis");
  if (!username) throw new Error("config: auth.owner_email est requis");
  if (!password) throw new Error("config: auth.owner_password est requis");

  const mqttUser = String(cfg?.mqtt?.username ?? "");
  const mqttPass = String(cfg?.mqtt?.password ?? "");

  return {
    // ancien mapping interne, gardé pour minimiser les changements
    username,
    password,
    serialNumber: serial,
    localEnvoyUrl: baseUrl,
    envoyInsecureTls: cfg?.envoy?.insecure_tls ?? true,

    httpTimeoutMs: Number(cfg?.http?.timeout_ms ?? 1500),

    mqttHost: String(cfg?.mqtt?.host ?? "localhost"),
    mqttPort: Number(cfg?.mqtt?.port ?? 1883),
    mqttUsername: mqttUser.trim() ? mqttUser : undefined,
    mqttPassword: mqttPass.trim() ? mqttPass : undefined,
    mqttBaseTopic: String(cfg?.mqtt?.base_topic ?? "envoy"),

    pollingIntervalMs: Number(cfg?.polling?.interval_ms ?? 60_000),
    highFrequencyEnabled: Boolean(cfg?.high_frequency?.enabled ?? false),
    highFrequencyIntervalMs: Number(cfg?.high_frequency?.interval_ms ?? 1000),

    haAutodiscovery: haDiscoveryEnabled,
    haDiscoveryTopic: String(cfg?.discovery?.topic ?? "").trim() || undefined,
    haDiscoveryQos: Number(cfg?.discovery?.qos_config ?? 1),

    pvProdSensorEnabled: Boolean(cfg?.sensors?.pv_production?.enabled ?? false),
    pvProdTopic: String(cfg?.sensors?.pv_production?.topic ?? "envoy/pv_production_energy"),
    pvProdSensorName: String(cfg?.sensors?.pv_production?.name ?? "PV Production Energy"),

    consoNetSensorEnabled: Boolean(cfg?.sensors?.conso_net?.enabled ?? false),
    consoNetTopic: String(cfg?.sensors?.conso_net?.topic ?? "envoy/conso_net_energy"),
    consoNetSensorName: String(cfg?.sensors?.conso_net?.name ?? "Conso Nette Energy"),

    tableauElecEnabled: Boolean(cfg?.sensors?.tableau_elec?.enabled ?? false),
    tableauElecTopic: String(cfg?.sensors?.tableau_elec?.topic ?? "").trim(),
    tableauElecPowerField:
      String(cfg?.sensors?.tableau_elec?.power_field ?? cfg?.sensors?.tableau_elec?.json_field ?? "").trim() || undefined,
    tableauElecIndexField: String(cfg?.sensors?.tableau_elec?.index_field ?? "").trim() || undefined,
    tableauElecIndexUnit: String(cfg?.sensors?.tableau_elec?.index_unit ?? "auto").trim().toLowerCase(),
    tableauElecStateFile: String(cfg?.sensors?.tableau_elec?.state_file ?? "").trim() || undefined,
    tableauElecSign: Number(cfg?.sensors?.tableau_elec?.sign ?? 1),

    timeZoneName: String(cfg?.timezone?.name ?? "Europe/Paris"),
    logLevel: String(cfg?.logging?.level ?? "info"),
  };
}
