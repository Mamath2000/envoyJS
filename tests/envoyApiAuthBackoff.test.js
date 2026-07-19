import test from "node:test";
import assert from "node:assert/strict";

import { EnvoyApi } from "../src/envoyApi.js";

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

function createApi() {
  return new EnvoyApi({
    username: "user@example.com",
    password: "secret",
    serialNumber: "123456789",
    envoyHost: "http://envoy.local",
    log: createSilentLog(),
  });
}

test("un echec d'authentification active un backoff et incremente le compteur d'echecs", async () => {
  const api = createApi();
  api.authenticate = async () => {
    throw new Error("identifiants invalides");
  };

  await assert.rejects(() => api.ensureAuthenticated({ debug: false }), /identifiants invalides/);

  assert.equal(api.authFailureCount, 1);
  assert.equal(api.authBackoffUntil > Date.now(), true);
  assert.equal(api.authBackoffUntil <= Date.now() + EnvoyApi.AUTH_BACKOFF_BASE_MS, true);
});

test("pendant la fenetre de backoff, ensureAuthenticated echoue immediatement sans rappeler authenticate", async () => {
  const api = createApi();

  let authenticateCalls = 0;
  api.authenticate = async () => {
    authenticateCalls += 1;
    throw new Error("panne cloud");
  };

  await assert.rejects(() => api.ensureAuthenticated({ debug: false }));
  assert.equal(authenticateCalls, 1);

  // Deuxieme appel immediat: doit echouer localement, sans nouvel appel a authenticate().
  await assert.rejects(() => api.ensureAuthenticated({ debug: false }), /backoff/);
  assert.equal(authenticateCalls, 1);
});

test("le backoff est exponentiel et plafonné", async () => {
  const api = createApi();
  api.authenticate = async () => {
    throw new Error("toujours en echec");
  };

  const backoffs = [];
  for (let i = 0; i < 5; i += 1) {
    // Simule l'expiration du backoff precedent pour forcer une nouvelle tentative.
    api.authBackoffUntil = 0;
    await assert.rejects(() => api.ensureAuthenticated({ debug: false }));
    backoffs.push(api.authBackoffUntil - Date.now());
  }

  // 30s, 60s, 120s, 240s, 480s (tous < plafond de 30min ici)
  assert.equal(backoffs[0] <= EnvoyApi.AUTH_BACKOFF_BASE_MS, true);
  assert.equal(backoffs[1] > backoffs[0], true);
  assert.equal(backoffs[2] > backoffs[1], true);
  assert.equal(backoffs[3] > backoffs[2], true);
  assert.equal(backoffs[4] > backoffs[3], true);
  assert.equal(backoffs[4] <= EnvoyApi.AUTH_BACKOFF_MAX_MS, true);
});

test("un succes reinitialise le compteur d'echecs et le backoff", async () => {
  const api = createApi();
  api.authFailureCount = 3;
  api.authBackoffUntil = 0; // fenetre deja expirée, on autorise la tentative

  api.authenticate = async () => {
    api.authToken = "fake-token";
    api.tokenExpiresAt = Date.now() + 60_000;
  };

  await api.ensureAuthenticated({ debug: false });

  assert.equal(api.authFailureCount, 0);
  assert.equal(api.authBackoffUntil, 0);
});
