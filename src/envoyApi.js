import { Agent, fetch } from "undici";
import { isoNowSeconds } from "./utils.js";
import { createLogger } from "./logger.js";

const ENLIGHTEN_LOGIN_URL = "https://enlighten.enphaseenergy.com/login/login.json";
const ENTREZ_TOKEN_URL = "https://entrez.enphaseenergy.com/tokens";
const ENVOY_AUTH_CHECK_ENDPOINT = "/auth/check_jwt";

export class EnvoyApi {
  // Duree de vie du cache du mapping eid -> role (/ivp/meters). Un cache permanent
  // obligerait a redemarrer le service si l'Envoy reassigne un jour ses eids
  // (firmware, ajout/retrait d'une pince) ; un TTL permet de s'auto-reparer sans
  // resollicité l'Envoy a chaque cycle (l'appel est fait en parallele des autres
  // requetes, voir getMetersReadings).
  static METERS_INFO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  // Backoff exponentiel plafonné sur les echecs d'authentification Enphase
  // (cloud, rate-limité). Sans ca, un identifiant revoque ou une panne cloud
  // ferait retenter un login a chaque appel — potentiellement plusieurs fois
  // par seconde en mode haute frequence (voir ensureAuthenticated).
  static AUTH_BACKOFF_BASE_MS = 30_000;
  static AUTH_BACKOFF_MAX_MS = 30 * 60_000;

  constructor(options) {
    this.username = options.username;
    this.password = options.password;
    this.serialNumber = options.serialNumber;
    this.envoyHost = options.envoyHost.replace(/\/$/, "");

    this.log = options?.log ?? createLogger({ level: process.env.LOG_LEVEL ?? "info", component: "envoyApi" });

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
    this.eidMappingCacheAt = undefined;
    this.authenticatingPromise = undefined;
    this.authFailureCount = 0;
    this.authBackoffUntil = 0;
  }

  get isTokenValid() {
    if (!this.authToken) return false;
    if (this.tokenExpiresAt && Date.now() > this.tokenExpiresAt) return false;
    return true;
  }

  // Les appels HTTP independants (meters/readings, consumption, production) sont
  // lances en parallele (voir getAllEnvoyData/getRawData/getMetersReadings), donc
  // plusieurs requetes peuvent detecter un token invalide simultanement. On evite
  // des logins concurrents (course sur sessionId/authToken) en ne laissant qu'une
  // seule authentification en vol a la fois; les appelants suivants attendent la
  // meme promesse au lieu d'en démarrer une nouvelle.
  async ensureAuthenticated({ debug, force = false } = {}) {
    if (!force && this.isTokenValid) return;

    const now = Date.now();
    if (now < this.authBackoffUntil) {
      throw new Error(
        `Authentification Enphase en pause (backoff) après ${this.authFailureCount} échec(s) consécutif(s), nouvelle tentative après ${new Date(this.authBackoffUntil).toISOString()}`,
      );
    }

    if (!this.authenticatingPromise) {
      this.authenticatingPromise = this.authenticate({ debug })
        .then(() => {
          this.authFailureCount = 0;
          this.authBackoffUntil = 0;
        })
        .catch((err) => {
          this.authFailureCount += 1;
          const backoffMs = Math.min(
            EnvoyApi.AUTH_BACKOFF_MAX_MS,
            EnvoyApi.AUTH_BACKOFF_BASE_MS * 2 ** (this.authFailureCount - 1),
          );
          this.authBackoffUntil = Date.now() + backoffMs;
          this.log.warn("authentification Enphase échouée: backoff activé", {
            consecutiveFailures: this.authFailureCount,
            backoffMs,
            retryAfter: new Date(this.authBackoffUntil).toISOString(),
            message: err?.message ?? String(err),
          });
          throw err;
        })
        .finally(() => {
          this.authenticatingPromise = undefined;
        });
    }

    await this.authenticatingPromise;
  }

  async authenticate({ debug } = {}) {
    const start = Date.now();
    if (debug !== false) this.log.debug("auth: start", { serial: this.serialNumber });
    await this.loginToEnlighten({ debug });
    await this.getAuthToken({ debug });
    const ok = await this.validateToken({ debug });
    if (!ok) throw new Error("Token récupéré mais validation échouée");
    this.tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;

    if (debug !== false) this.log.debug("auth: success", { durationMs: Date.now() - start });
  }

  async loginToEnlighten({ debug } = {}) {
    const start = Date.now();
    if (debug !== false) this.log.debug("http: POST login Enlighten", { url: ENLIGHTEN_LOGIN_URL, user: this.username });
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
      if (debug !== false) this.log.debug("http: login Enlighten failed", { status: res.status, durationMs: Date.now() - start });
      throw new Error(`HTTP ${res.status} login Enlighten: ${text}`);
    }

    const json = await res.json();
    if (json?.message !== "success") {
      throw new Error(`Login échoué: ${json?.message ?? "Erreur inconnue"}`);
    }

    const sessionId = json?.session_id;
    if (!sessionId) throw new Error("Pas de session_id dans la réponse");
    this.sessionId = String(sessionId);

    if (debug !== false) this.log.debug("http: login Enlighten ok", { durationMs: Date.now() - start });
  }

  async getAuthToken({ debug } = {}) {
    if (!this.sessionId) throw new Error("Session ID requis pour récupérer le token");

    const start = Date.now();
    if (debug !== false) this.log.debug("http: POST token Entrez", { url: ENTREZ_TOKEN_URL, serial: this.serialNumber });

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
      if (debug !== false) this.log.debug("http: token Entrez failed", { status: res.status, durationMs: Date.now() - start });
      throw new Error(`HTTP ${res.status} récupération token: ${text}`);
    }

    const tokenText = (await res.text()).trim();
    if (!tokenText || tokenText.length <= 20) throw new Error("Token vide");
    this.authToken = tokenText;

    if (debug !== false) this.log.debug("http: token Entrez ok", { durationMs: Date.now() - start, tokenLen: tokenText.length });
  }

  async validateToken({ debug } = {}) {
    if (!this.authToken) return false;
    const url = `${this.envoyHost}${ENVOY_AUTH_CHECK_ENDPOINT}`;

    const start = Date.now();
    if (debug !== false) this.log.debug("http: GET validate token", { url: `${this.envoyHost}${ENVOY_AUTH_CHECK_ENDPOINT}` });

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

    if (!res.ok) {
      if (debug !== false) this.log.debug("http: validate token failed", { status: res.status, durationMs: Date.now() - start });
      return false;
    }
    const text = await res.text();
    const ok = text.includes("Valid token.");
    if (debug !== false) this.log.debug("http: validate token ok", { durationMs: Date.now() - start, ok });
    return ok;
  }

  async makeRequest(endpoint, { debug } = {}) {
    const startedAt = Date.now();
    if (debug !== false) this.log.debug("http: GET", { endpoint });
    await this.ensureAuthenticated({ debug });

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

    if (debug !== false) this.log.debug("http: response", { endpoint, status: res.status, durationMs: Date.now() - startedAt });

    if (res.status === 401) {
      if (debug !== false) this.log.debug("http: 401 -> re-auth + retry", { endpoint });
      await this.ensureAuthenticated({ debug, force: true });
      const ac2 = new AbortController();
      const t2 = setTimeout(() => ac2.abort(), this.timeoutMs);
      const retryRes = await fetch(url, {
        method: "GET",
        headers: { ...headers, Authorization: `Bearer ${this.authToken}` },
        dispatcher: this.dispatcher,
        signal: ac2.signal,
      });
      clearTimeout(t2);
      if (debug !== false) this.log.debug("http: retry response", { endpoint, status: retryRes.status, durationMs: Date.now() - startedAt });
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

  async getMetersInfo({ debug } = {}) {
    const cacheAge = this.eidMappingCacheAt ? Date.now() - this.eidMappingCacheAt : Infinity;
    if (this.eidMappingCache && cacheAge < EnvoyApi.METERS_INFO_CACHE_TTL_MS) {
      return this.eidMappingCache;
    }

    const metersInfo = await this.makeRequest("/ivp/meters", { debug });
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
    this.eidMappingCacheAt = Date.now();
    return eidMapping;
  }

  async getMetersReadings({ debug } = {}) {
    const startedAt = Date.now();
    const [metersInfo, metersReadings] = await Promise.all([
      this.getMetersInfo({ debug }),
      this.makeRequest("/ivp/meters/readings", { debug }),
    ]);
    if (debug !== false) this.log.debug("getMetersReadings: terminé (parallèle)", { durationMs: Date.now() - startedAt });
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

  async getConsumptionReports({ debug } = {}) {
    const consumptionReports = await this.makeRequest("/ivp/meters/reports/consumption", { debug });

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

  async getProductionV1({ debug } = {}) {
    const data = await this.makeRequest("/api/v1/production", { debug });
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  }

  async getRawData({ debug } = {}) {
    const startedAt = Date.now();
    const [metersData, consumptionData] = await Promise.all([
      this.getMetersReadings({ debug }),
      this.getConsumptionReports({ debug }),
    ]);
    if (debug !== false) this.log.debug("getRawData: terminé (parallèle)", { durationMs: Date.now() - startedAt });

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

  async getAllEnvoyData({ debug } = {}) {
    const startedAt = Date.now();
    const [metersData, consumptionData, productionV1Data] = await Promise.all([
      this.getMetersReadings({ debug }),
      this.getConsumptionReports({ debug }),
      this.getProductionV1({ debug }),
    ]);
    if (debug !== false) this.log.debug("getAllEnvoyData: terminé (parallèle)", { durationMs: Date.now() - startedAt });

    const productionMeter = metersData["production"] ?? {};
    const netConsumptionMeter = metersData["net-consumption"] ?? {};

    const processed = {};
    Object.assign(processed, this.processMetersProductionData(productionMeter));
    Object.assign(processed, this.processMetersNetConsumptionData(netConsumptionMeter));

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
    this.eidMappingCacheAt = undefined;
  }
}
