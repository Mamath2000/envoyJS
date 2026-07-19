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

const FAKE_METERS = [
  { eid: 704643328, measurementType: "production" },
  { eid: 704643584, measurementType: "net-consumption" },
];

test("getMetersInfo met en cache le mapping eid et n'appelle makeRequest qu'une fois tant que le TTL n'est pas dépassé", async () => {
  const api = createApi();

  let makeRequestCalls = 0;
  api.makeRequest = async () => {
    makeRequestCalls += 1;
    return FAKE_METERS;
  };

  const first = await api.getMetersInfo({ debug: false });
  const second = await api.getMetersInfo({ debug: false });

  assert.equal(makeRequestCalls, 1);
  assert.deepEqual(first, { 704643328: "production", 704643584: "net-consumption" });
  assert.deepEqual(second, first);
});

test("getMetersInfo rafraîchit le cache une fois le TTL dépassé", async () => {
  const api = createApi();

  let makeRequestCalls = 0;
  api.makeRequest = async () => {
    makeRequestCalls += 1;
    return FAKE_METERS;
  };

  await api.getMetersInfo({ debug: false });
  assert.equal(makeRequestCalls, 1);

  // Simule l'expiration du TTL sans attendre des heures.
  api.eidMappingCacheAt = Date.now() - EnvoyApi.METERS_INFO_CACHE_TTL_MS - 1;

  await api.getMetersInfo({ debug: false });
  assert.equal(makeRequestCalls, 2);
});

test("clearCache force un rafraîchissement immédiat au prochain appel", async () => {
  const api = createApi();

  let makeRequestCalls = 0;
  api.makeRequest = async () => {
    makeRequestCalls += 1;
    return FAKE_METERS;
  };

  await api.getMetersInfo({ debug: false });
  assert.equal(makeRequestCalls, 1);

  api.clearCache();
  assert.equal(api.eidMappingCache, undefined);
  assert.equal(api.eidMappingCacheAt, undefined);

  await api.getMetersInfo({ debug: false });
  assert.equal(makeRequestCalls, 2);
});
