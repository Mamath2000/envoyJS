import { Agent, fetch } from "undici";
import { isoNowSeconds } from "./utils.js";

const ENLIGHTEN_LOGIN_URL = "https://enlighten.enphaseenergy.com/login/login.json";
const ENTREZ_TOKEN_URL = "https://entrez.enphaseenergy.com/tokens";
const ENVOY_AUTH_CHECK_ENDPOINT = "/auth/check_jwt";

export class EnvoyApi {
  constructor(options) {
    this.username = options.username;
    this.password = options.password;
    this.serialNumber = options.serialNumber;
    this.envoyHost = options.envoyHost.replace(/\/$/, "");

    // timeout pour l'Envoy local (réseau LAN)
    this.timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 1500;
    // endpoints cloud Enphase (internet) : éviter des timeouts trop agressifs
    this.externalTimeoutMs = Math.max(8000, this.timeoutMs);

    if (options.insecureTls) {
      this.dispatcher = new Agent({
        connect: {
          rejectUnauthorized: false,
        },
      });
    }

    this.sessionId = undefined;
    this.authToken = undefined;
    this.tokenExpiresAt = undefined;
    this.eidMappingCache = undefined;
  }

  get isTokenValid() {
    if (!this.authToken) return false;
    if (this.tokenExpiresAt && Date.now() > this.tokenExpiresAt) return false;
    return true;
  }

  async authenticate() {
    await this.loginToEnlighten();
    await this.getAuthToken();
    const ok = await this.validateToken();
    if (!ok) throw new Error("Token récupéré mais validation échouée");
    this.tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
  }

  async loginToEnlighten() {
    const payload = {
      user: {
        email: this.username,
        password: this.password,
      },
    };

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.externalTimeoutMs);
    const res = await fetch(ENLIGHTEN_LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Envoy2MQTT",
      },
      body: JSON.stringify(payload),
      dispatcher: this.dispatcher,
      signal: ac.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} login Enlighten: ${text}`);
    }

    const json = await res.json();
    if (json?.message !== "success") {
      throw new Error(`Login échoué: ${json?.message ?? "Erreur inconnue"}`);
    }

    const sessionId = json?.session_id;
    if (!sessionId) throw new Error("Pas de session_id dans la réponse");
    this.sessionId = String(sessionId);
  }

  async getAuthToken() {
    if (!this.sessionId) throw new Error("Session ID requis pour récupérer le token");

    const payload = {
      session_id: this.sessionId,
      serial_num: this.serialNumber,
      username: this.username,
    };

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.externalTimeoutMs);
    const res = await fetch(ENTREZ_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Envoy2MQTT",
      },
      body: JSON.stringify(payload),
      dispatcher: this.dispatcher,
      signal: ac.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} récupération token: ${text}`);
    }

    const tokenText = (await res.text()).trim();
    if (!tokenText || tokenText.length <= 20) throw new Error("Token vide");
    this.authToken = tokenText;
  }

  async validateToken() {
    if (!this.authToken) return false;
    const url = `${this.envoyHost}${ENVOY_AUTH_CHECK_ENDPOINT}`;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        "Content-Type": "application/json",
        "User-Agent": "Envoy2MQTT",
      },
      dispatcher: this.dispatcher,
      signal: ac.signal,
    });
    clearTimeout(t);

    if (!res.ok) return false;
    const text = await res.text();
    return text.includes("Valid token.");
  }

  async makeRequest(endpoint) {
    if (!this.isTokenValid) {
      await this.authenticate();
    }

    const url = `${this.envoyHost}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.authToken}`,
      Accept: "application/json",
      "User-Agent": "Envoy2MQTT",
    };

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    const res = await fetch(url, {
      method: "GET",
      headers,
      dispatcher: this.dispatcher,
      signal: ac.signal,
    });
    clearTimeout(t);

    if (res.status === 401) {
      await this.authenticate();
      const ac2 = new AbortController();
      const t2 = setTimeout(() => ac2.abort(), this.timeoutMs);
      const retryRes = await fetch(url, {
        method: "GET",
        headers: { ...headers, Authorization: `Bearer ${this.authToken}` },
        dispatcher: this.dispatcher,
        signal: ac2.signal,
      });
      clearTimeout(t2);
      if (!retryRes.ok) {
        const text = await retryRes.text();
        throw new Error(`HTTP ${retryRes.status} après retry: ${text}`);
      }
      return await retryRes.json();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Content-Type inattendu pour ${endpoint}: ${contentType}. Réponse: ${text.slice(0, 200)}`);
      }
    }

    return await res.json();
  }

  async getMetersInfo() {
    if (this.eidMappingCache) return this.eidMappingCache;

    const metersInfo = await this.makeRequest("/ivp/meters");
    const eidMapping = {};

    if (Array.isArray(metersInfo)) {
      for (const meterConfig of metersInfo) {
        if (!meterConfig || typeof meterConfig !== "object") continue;
        const eid = meterConfig.eid;
        const measurementType = String(meterConfig.measurementType ?? "").toLowerCase();
        if (eid && (measurementType === "production" || measurementType === "net-consumption")) {
          eidMapping[Number(eid)] = measurementType;
        }
      }
    }

    this.eidMappingCache = eidMapping;
    return eidMapping;
  }

  async getMetersReadings() {
    const metersInfo = await this.getMetersInfo();
    const metersReadings = await this.makeRequest("/ivp/meters/readings");
    if (!metersInfo || Object.keys(metersInfo).length === 0) return {};

    const processed = {};
    if (Array.isArray(metersReadings)) {
      for (const meter of metersReadings) {
        if (!meter || typeof meter !== "object") continue;
        const eid = meter.eid;
        if (eid && metersInfo[Number(eid)]) {
          const role = metersInfo[Number(eid)];
          processed[role] = meter;
        }
      }
    }

    return processed;
  }

  async getConsumptionReports() {
    const consumptionReports = await this.makeRequest("/ivp/meters/reports/consumption");

    const reports = {};
    if (Array.isArray(consumptionReports)) {
      for (const report of consumptionReports) {
        if (!report || typeof report !== "object") continue;
        const reportType = report.reportType;
        if (reportType === "total-consumption" || reportType === "net-consumption") {
          reports[reportType] = report.cumulative ?? {};
        }
      }
    }

    return reports;
  }

  async getProductionV1() {
    const data = await this.makeRequest("/api/v1/production");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  }

  async getRawData() {
    const metersData = await this.getMetersReadings();
    const consumptionData = await this.getConsumptionReports();

    const productionMeter = metersData["production"] ?? {};
    const netConsumptionMeter = metersData["net-consumption"] ?? {};
    const totalConsumption = consumptionData["total-consumption"] ?? {};

    return {
      conso_all_eim_wNow: totalConsumption?.currW ?? 0,
      conso_net_eim_wNow: netConsumptionMeter?.instantaneousDemand ?? 0,
      prod_eim_wNow: productionMeter?.instantaneousDemand ?? 0,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  async getAllEnvoyData() {
    const metersData = await this.getMetersReadings();
    const consumptionData = await this.getConsumptionReports();
    const productionV1Data = await this.getProductionV1();

    const productionMeter = metersData["production"] ?? {};
    const netConsumptionMeter = metersData["net-consumption"] ?? {};

    const processed = {};
    Object.assign(processed, this.processMetersProductionData(productionMeter));
    Object.assign(processed, this.processMetersNetConsumptionData(netConsumptionMeter));

    const netDemand = Number(netConsumptionMeter?.instantaneousDemand ?? 0);
    const prodDemand = Number(productionMeter?.instantaneousDemand ?? 0);

    processed.grid_eim_wNow = netDemand < 0 ? Math.abs(netDemand) : 0;
    processed.grid_eim_wNow_binary = netDemand > 0 ? 1 : 0;
    processed.eco_eim_wNow = netDemand < 0 ? prodDemand + netDemand : prodDemand;

    processed.eco_eim_whLifetime = Number(
      (Number(processed.prod_eim_whLifetime ?? 0) - Number(processed.grid_eim_whLifetime ?? 0)).toFixed(3),
    );

    const totalConsumption = consumptionData["total-consumption"] ?? {};
    const netConsumptionReports = consumptionData["net-consumption"] ?? {};

    Object.assign(processed, this.processReportsConsumptionTotalData(totalConsumption));
    Object.assign(processed, this.processReportsConsumptionNetData(netConsumptionReports));

    processed.prod_eim_wattHoursToday = productionV1Data?.wattHoursToday ?? 0;
    processed.timestamp = Math.floor(Date.now() / 1000);
    processed.timestamp_text = isoNowSeconds();

    return processed;
  }

  processMetersProductionData(metersData) {
    const renameMapping = {
      instantaneousDemand: "prod_eim_wNow",
      voltage: "prod_eim_voltage",
      current: "prod_eim_current",
      pwrFactor: "prod_eim_pwrFactor",
      actEnergyDlvd: "prod_eim_whLifetime",
      today: "prod_eim_today",
    };

    const processed = {};
    for (const [key, value] of Object.entries(metersData ?? {})) {
      if (typeof value !== "number") continue;
      if (!renameMapping[key]) continue;

      processed[renameMapping[key]] = value;
      if (key === "actEnergyDlvd") processed.prod_eim_kwhLifetime = Number((value / 1000).toFixed(3));
      if (key === "instantaneousDemand") processed.prod_eim_wNow_binary = value > 5 ? 1 : 0;
    }
    return processed;
  }

  processMetersNetConsumptionData(metersData) {
    const renameMapping = {
      instantaneousDemand: "conso_net_eim_wNow",
      voltage: "conso_net_eim_voltage",
      current: "conso_net_eim_current",
      pwrFactor: "conso_net_eim_pwrFactor",
      actEnergyRcvd: "grid_eim_whLifetime",
      actEnergyDlvd: "import_eim_whLifetime",
    };

    const processed = {};
    for (const [key, value] of Object.entries(metersData ?? {})) {
      if (typeof value !== "number") continue;
      if (!renameMapping[key]) continue;

      processed[renameMapping[key]] = value;
      if (key === "actEnergyRcvd") processed.grid_eim_kwhLifetime = Number((value / 1000).toFixed(3));
      if (key === "actEnergyDlvd") processed.import_eim_kwhLifetime = Number((value / 1000).toFixed(3));
    }
    return processed;
  }

  processReportsConsumptionTotalData(consumptionData) {
    const renameMapping = {
      currW: "conso_all_eim_wNow",
      rmsCurrent: "conso_all_eim_rmsCurrent",
      rmsVoltage: "conso_all_eim_rmsVoltage",
      whDlvdCum: "conso_all_eim_whLifetime",
    };

    const processed = {};
    for (const [key, value] of Object.entries(consumptionData ?? {})) {
      if (typeof value !== "number") continue;
      if (!renameMapping[key]) continue;

      processed[renameMapping[key]] = value;
      if (key === "whDlvdCum") processed.conso_all_eim_kwhLifetime = Number((value / 1000).toFixed(3));
    }
    return processed;
  }

  processReportsConsumptionNetData(netConsumptionData) {
    const renameMapping = {
      whDlvdCum: "conso_net_eim_whLifetime",
    };

    const processed = {};
    for (const [key, value] of Object.entries(netConsumptionData ?? {})) {
      if (typeof value !== "number") continue;
      if (!renameMapping[key]) continue;

      processed[renameMapping[key]] = value;
      if (key === "whDlvdCum") processed.conso_net_eim_kwhLifetime = Number((value / 1000).toFixed(3));
    }
    return processed;
  }

  clearCache() {
    this.eidMappingCache = undefined;
  }
}
