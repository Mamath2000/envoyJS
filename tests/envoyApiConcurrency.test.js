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

test("ensureAuthenticated ne declenche qu'une seule authentification pour des appels concurrents", async () => {
  const api = createApi();

  let authenticateCalls = 0;
  api.authenticate = async () => {
    authenticateCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    api.authToken = "fake-token";
    api.tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
  };

  await Promise.all([
    api.ensureAuthenticated({ debug: false }),
    api.ensureAuthenticated({ debug: false }),
    api.ensureAuthenticated({ debug: false }),
  ]);

  assert.equal(authenticateCalls, 1);
  assert.equal(api.authToken, "fake-token");
});

test("ensureAuthenticated ne relance pas d'authentification si le token est deja valide", async () => {
  const api = createApi();
  api.authToken = "already-valid";
  api.tokenExpiresAt = Date.now() + 60_000;

  let authenticateCalls = 0;
  api.authenticate = async () => {
    authenticateCalls += 1;
  };

  await api.ensureAuthenticated({ debug: false });

  assert.equal(authenticateCalls, 0);
});

test("ensureAuthenticated avec force=true relance l'authentification meme si le token semble valide", async () => {
  const api = createApi();
  api.authToken = "stale-but-locally-valid";
  api.tokenExpiresAt = Date.now() + 60_000;

  let authenticateCalls = 0;
  api.authenticate = async () => {
    authenticateCalls += 1;
    api.authToken = "refreshed-token";
  };

  await api.ensureAuthenticated({ debug: false, force: true });

  assert.equal(authenticateCalls, 1);
  assert.equal(api.authToken, "refreshed-token");
});

test("getAllEnvoyData lance les 3 requetes independantes en parallele, pas sequentiellement", async () => {
  const api = createApi();

  const events = [];
  api.getMetersReadings = async () => {
    events.push("meters:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("meters:end");
    return {};
  };
  api.getConsumptionReports = async () => {
    events.push("consumption:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("consumption:end");
    return {};
  };
  api.getProductionV1 = async () => {
    events.push("production:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("production:end");
    return {};
  };

  await api.getAllEnvoyData({ debug: false });

  // Sequentiel donnerait: meters:start, meters:end, consumption:start, consumption:end, ...
  // En parallele, les 3 "start" doivent tous survenir avant le premier "end".
  const firstEndIndex = events.findIndex((e) => e.endsWith(":end"));
  const startsBeforeFirstEnd = events.slice(0, firstEndIndex).filter((e) => e.endsWith(":start"));
  assert.equal(startsBeforeFirstEnd.length, 3);
});
