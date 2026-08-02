// Marine + tide formatting (pure functions) and fetchWeather caching, driven
// through the injectable WeatherDeps (stub fetch + fixed clock) — no network.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  fetchWeather,
  formatForecast,
  formatMarine,
  formatTides,
  WEATHER_DEFAULTS,
  type WeatherConfig,
} from "../weather";

// A stub fetch that records calls and answers forecast/marine/tides bodies by
// path, so the cache tests can count refetches without touching the network.
function stubFetch(bodyByPath?: (path: string) => unknown) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.href;
    calls.push(url);
    const path = new URL(url).pathname;
    const body = bodyByPath
      ? bodyByPath(path)
      : path.startsWith("/v1/marine")
        ? { current: { wave_height: 1, swell_wave_height: 0.5 } }
        : { current: { temperature_2m: 15, wind_speed_10m: 10 } };
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE_CFG: WeatherConfig = {
  ...WEATHER_DEFAULTS,
  marine: false, // keep cache tests to a single forecast fetch unless stated
  cacheMs: 600000,
};

test("formatMarine summarises waves and swell in nautical units", () => {
  const out = formatMarine({
    current: {
      wave_height: 1.2,
      wave_direction: 300,
      wave_period: 5.5,
      swell_wave_height: 0.8,
      swell_wave_period: 7.2,
    },
  });
  assert.match(out, /^Sea state:/);
  assert.match(out, /waves 1\.2 m from WNW at 5\.5 s/);
  assert.match(out, /swell 0\.8 m at 7\.2 s/);
  assert.doesNotMatch(out, /undefined|NaN/);
});

test("formatMarine keeps sub-metre values (no whole-metre rounding to 0)", () => {
  const out = formatMarine({
    current: { wave_height: 0.3, swell_wave_height: 0.16 },
  });
  assert.match(out, /waves 0\.3 m/);
  assert.match(out, /swell 0\.2 m/);
});

test("formatMarine returns empty when there is nothing usable", () => {
  assert.equal(formatMarine({}), "");
  assert.equal(formatMarine({ current: {} }), "");
});

test("formatTides lists the next two upcoming extremes", () => {
  const now = 1_000_000; // seconds
  const out = formatTides(
    {
      extremes: [
        { dt: now - 100, date: "1970-01-12T13:00", height: 1.5, type: "High" },
        { dt: now + 100, date: "1970-01-12T15:00", height: 0.3, type: "Low" },
        { dt: now + 200, date: "1970-01-12T21:00", height: 1.6, type: "High" },
        { dt: now + 300, date: "1970-01-13T03:00", height: 0.2, type: "Low" },
      ],
    },
    now,
  );
  assert.match(out, /^Tides: next low at 15:00 \(0\.3 m\), then high at 21:00/);
  // The past extreme is dropped, and only two are shown.
  assert.doesNotMatch(out, /13:00/);
  assert.doesNotMatch(out, /03:00/);
});

test("formatTides returns empty when nothing is upcoming", () => {
  assert.equal(formatTides({}, 0), "");
  assert.equal(
    formatTides({ extremes: [{ dt: 10, date: "x", type: "High" }] }, 1000),
    "",
    "all extremes in the past -> nothing",
  );
});

test("formatTides tolerates malformed elements without throwing", () => {
  // A null/garbage element must not throw — under `void onCommand` a throw
  // becomes an unhandled rejection (crashing the server). It should skip the
  // bad element and use the good ones.
  const now = 1000;
  assert.doesNotThrow(() =>
    formatTides(
      {
        extremes: [
          null,
          42 as unknown as { dt?: number },
          "x" as unknown as { dt?: number },
          {},
          { dt: now + 100, date: "1970-01-12T15:00", height: 0.3, type: "Low" },
        ],
      },
      now,
    ),
  );
  const out = formatTides(
    {
      extremes: [
        null,
        { dt: now + 100, date: "1970-01-12T15:00", height: 0.3, type: "Low" },
      ],
    },
    now,
  );
  assert.match(out, /low at 15:00/, "the good element still comes through");
});

test("WEATHER_DEFAULTS point marine and tides at the right hosts", () => {
  // The marine API lives on a DIFFERENT subdomain from the forecast host (the
  // forecast host 404s on /v1/marine). Guard the default so a typo can't
  // silently send marine requests to a host that rejects them.
  assert.equal(
    WEATHER_DEFAULTS.marineBaseUrl,
    "https://marine-api.open-meteo.com",
  );
  assert.equal(WEATHER_DEFAULTS.baseUrl, "https://api.open-meteo.com");
  assert.equal(WEATHER_DEFAULTS.tidesBaseUrl, "https://www.worldtides.info");
  assert.equal(WEATHER_DEFAULTS.tidesApiKey, "", "tides off by default");
  assert.equal(WEATHER_DEFAULTS.marine, true, "marine on by default");
});

test("formatForecast summarises current + a few forecast points", () => {
  const out = formatForecast(
    {
      current: {
        temperature_2m: 16.8,
        wind_speed_10m: 12,
        wind_direction_10m: 225,
        weather_code: 3,
        pressure_msl: 1016,
      },
      hourly: {
        time: ["2026-08-01T00:00", "2026-08-01T04:00", "2026-08-01T08:00"],
        wind_speed_10m: [12, 18, 20],
        wind_gusts_10m: [16, 24, 28],
        wind_direction_10m: [225, 240, 250],
        precipitation_probability: [10, 40, 60],
        temperature_2m: [16, 15, 17],
      },
    },
    12,
  );
  assert.match(out, /^Now: overcast, 17°C, wind SW 12 kn, 1016 hPa\./m);
  assert.match(out, /Later:/);
  assert.match(out, /gusting/, "gusts are summarised");
  assert.match(out, /% rain/, "precipitation >= 20% is shown");
  assert.doesNotMatch(out, /undefined|NaN|weather_code/);
});

// The cache is a module-level singleton shared across tests in this file. Each
// cache test uses a DISTINCT position so its key can't collide with another
// test's leftover entry (position is part of the key), keeping them isolated
// without needing a reset hook.
test("fetchWeather reuses the cache within cacheMs", async () => {
  const { fetchImpl, calls } = stubFetch();
  const deps = { fetchImpl, now: () => 1_000_000 };
  const a = await fetchWeather(10.0, 10.0, BASE_CFG, deps);
  const b = await fetchWeather(10.0, 10.0, BASE_CFG, deps);
  assert.equal(a, b);
  assert.equal(calls.length, 1, "second call within cacheMs must not refetch");
});

test("a forecastHours change busts the cache", async () => {
  const { fetchImpl, calls } = stubFetch();
  const deps = { fetchImpl, now: () => 1_000_000 };
  await fetchWeather(20.0, 20.0, { ...BASE_CFG, forecastHours: 12 }, deps);
  await fetchWeather(20.0, 20.0, { ...BASE_CFG, forecastHours: 6 }, deps);
  assert.equal(calls.length, 2, "changing forecastHours must refetch");
});

test("a marineBaseUrl change busts the cache", async () => {
  const { fetchImpl, calls } = stubFetch();
  const deps = { fetchImpl, now: () => 1_000_000 };
  const cfg = { ...BASE_CFG, marine: true };
  await fetchWeather(30.0, 30.0, cfg, deps);
  const before = calls.length;
  await fetchWeather(
    30.0,
    30.0,
    { ...cfg, marineBaseUrl: "https://marine.example.test" },
    deps,
  );
  assert.ok(
    calls.length > before,
    "changing marineBaseUrl must refetch, not serve the old block",
  );
});

test("fetchWeather does not cache when tides are on", async () => {
  const { fetchImpl, calls } = stubFetch((path) =>
    path.startsWith("/api/v3")
      ? { extremes: [{ dt: 2_000_000, date: "2026-01-01T06:00", type: "Low" }] }
      : { current: { temperature_2m: 15, wind_speed_10m: 10 } },
  );
  const deps = { fetchImpl, now: () => 1_000_000_000 };
  const cfg = { ...BASE_CFG, tidesApiKey: "k" };
  await fetchWeather(40.0, 40.0, cfg, deps);
  const after1 = calls.length;
  await fetchWeather(40.0, 40.0, cfg, deps);
  assert.ok(
    calls.length > after1,
    "time-relative tides must refetch every call (never cached)",
  );
});
