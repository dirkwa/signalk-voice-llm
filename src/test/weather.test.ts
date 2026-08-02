// Tests for the SignalK Weather API-backed weather block (src/weather.ts).
//
// fetchWeather now calls app.weatherApi.getForecasts (in-process), so these
// drive it with a stub weatherApi returning SI-unit WeatherData — asserting the
// SI->nautical conversions, the marine summary, and the best-effort guarantees
// (no provider, provider throws, malformed data => "" never throws).

// Forecast times are rendered in the server's local timezone; pin it to UTC so
// the sample-time assertions are deterministic and read the same HH:MM as the
// UTC input. hhmmLocal itself is exercised for a non-UTC zone in context.test.ts.
process.env.TZ = "UTC";

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  fetchWeather,
  formatForecast,
  formatMarine,
  WEATHER_DEFAULTS,
  type WeatherApiLike,
  type WeatherConfig,
  type WeatherData,
} from "../weather";

const CFG: WeatherConfig = { ...WEATHER_DEFAULTS };

// A stub weatherApi returning the given value verbatim, so the tests can feed
// malformed and non-array payloads through the same helper.
function stubApi(forecasts: unknown): WeatherApiLike {
  return {
    getForecasts: async () => forecasts as WeatherData[],
  };
}

// SI-unit sample forecast: 288.15 K = 15°C, 101300 Pa = 1013 hPa,
// 10.29 m/s ≈ 20 kn, direction 225° = 3.9270 rad, gust 12.86 m/s ≈ 25 kn.
const SAMPLE: WeatherData[] = [
  {
    date: "2026-08-02T05:00:00.000Z",
    description: "Partly cloudy",
    outside: { temperature: 288.15, pressure: 101300 },
    wind: {
      speedTrue: 10.29,
      directionTrue: (225 * Math.PI) / 180,
      gust: 12.86,
    },
    water: {
      waveSignificantHeight: 1.2,
      wavePeriod: 5.5,
      waveDirection: (300 * Math.PI) / 180,
      swellHeight: 0.8,
      swellPeriod: 7.2,
    },
  },
  {
    date: "2026-08-02T09:00:00.000Z",
    outside: { temperature: 290.15 },
    wind: {
      speedTrue: 12.86,
      directionTrue: (250 * Math.PI) / 180,
      gust: 15.43,
    },
  },
  {
    date: "2026-08-02T13:00:00.000Z",
    outside: { temperature: 291.15 },
    wind: { speedTrue: 15.43, directionTrue: (260 * Math.PI) / 180 },
  },
];

test("formatForecast converts SI to nautical and summarises now + later", () => {
  const out = formatForecast(SAMPLE, 12);
  assert.match(out, /^Now: Partly cloudy, 15°C, wind SW 20 kn, 1013 hPa\./m);
  assert.match(out, /Later:/);
  assert.match(out, /wind .* gusting/, "gusts summarised in kn");
  // No raw SI values leak (Kelvin temps / Pascal pressures / m/s speeds).
  assert.doesNotMatch(out, /undefined|NaN|288\.15|101300|10\.29/);
});

test("formatMarine converts wave/swell (m, rad->compass, s)", () => {
  const out = formatMarine(SAMPLE);
  assert.match(out, /^Sea state:/);
  assert.match(out, /waves 1\.2 m from WNW at 5\.5 s/);
  assert.match(out, /swell 0\.8 m at 7\.2 s/);
});

test("formatMarine/formatForecast return '' on empty input", () => {
  assert.equal(formatForecast([], 12), "");
  assert.equal(formatMarine([]), "");
  assert.equal(formatMarine([{ date: "x" }]), "", "no water -> no sea state");
});

test("fetchWeather returns a combined weather + sea-state block", async () => {
  const out = await fetchWeather(54.32, 10.14, CFG, stubApi(SAMPLE));
  assert.match(out, /Now: Partly cloudy, 15°C, wind SW 20 kn/);
  assert.match(out, /Sea state: waves 1\.2 m/);
});

test("fetchWeather omits sea state when marine is off", async () => {
  const out = await fetchWeather(
    54.32,
    10.14,
    { ...CFG, marine: false },
    stubApi(SAMPLE),
  );
  assert.match(out, /Now:/);
  assert.doesNotMatch(out, /Sea state/);
});

test("fetchWeather passes the position and interval count to the provider", async () => {
  let seen: unknown;
  const api: WeatherApiLike = {
    getForecasts: async (pos, type, opts) => {
      seen = { pos, type, opts };
      return SAMPLE;
    },
  };
  await fetchWeather(54.32, 10.14, { ...CFG, forecastHours: 8 }, api);
  assert.deepEqual(seen, {
    pos: { latitude: 54.32, longitude: 10.14 },
    type: "point",
    opts: { maxCount: 8 },
  });
});

test("fetchWeather returns '' when no weather provider is present", async () => {
  assert.equal(await fetchWeather(54.32, 10.14, CFG, undefined), "");
  assert.equal(
    await fetchWeather(54.32, 10.14, CFG, {} as WeatherApiLike),
    "",
    "an api object without getForecasts is treated as absent",
  );
});

test("fetchWeather returns '' (never throws) when the provider throws", async () => {
  const throwing: WeatherApiLike = {
    getForecasts: async () => {
      throw new Error("No providers registered!");
    },
  };
  assert.equal(await fetchWeather(54.32, 10.14, CFG, throwing), "");
});

test("fetchWeather tolerates malformed forecast data without throwing", async () => {
  const hostile: unknown[] = [
    null,
    42,
    "str",
    {},
    [],
    { outside: null, wind: 5, water: "x" },
    { outside: { temperature: "hot" }, wind: { speedTrue: NaN } },
    { date: 99, water: { swellHeight: Infinity } },
  ];
  for (const bad of hostile) {
    const out = await fetchWeather(54.32, 10.14, CFG, stubApi([bad]));
    assert.equal(typeof out, "string");
    assert.doesNotMatch(out, /undefined|NaN|Infinity/);
  }
  // A non-array provider return is also tolerated.
  assert.equal(await fetchWeather(54.32, 10.14, CFG, stubApi(42)), "");
});

test("fetchWeather returns '' for a non-finite position", async () => {
  assert.equal(await fetchWeather(NaN, 10, CFG, stubApi(SAMPLE)), "");
  assert.equal(await fetchWeather(54, Infinity, CFG, stubApi(SAMPLE)), "");
});

test("fetchWeather times out a hung provider instead of blocking", async () => {
  // A provider that never settles must NOT hang the voice reply — the call is
  // bounded and degrades to "no weather". (Short timeout so the test is fast.)
  const hung: WeatherApiLike = {
    getForecasts: () => new Promise<never>(() => {}), // never resolves
  };
  const t0 = Date.now();
  const out = await fetchWeather(54.32, 10.14, CFG, hung, 100);
  assert.equal(out, "", "a hung provider degrades to no weather");
  assert.ok(Date.now() - t0 < 2000, "returned promptly, did not block");
});

test("fetchWeather still returns data when the provider beats the timeout", async () => {
  const slowish: WeatherApiLike = {
    getForecasts: () =>
      new Promise((resolve) => setTimeout(() => resolve(SAMPLE), 10)),
  };
  const out = await fetchWeather(54.32, 10.14, CFG, slowish, 500);
  assert.match(out, /Now: Partly cloudy/, "a provider under the timeout wins");
});

test("formatForecast renders later sample times in local time", () => {
  // Forecast trend times are shown in the boat's local timezone. Tests pin
  // TZ=UTC, so SAMPLE[1].date (09:00Z) renders as 09:00.
  const out = formatForecast(SAMPLE, 12);
  assert.match(out, /Later: 09:00 /, "sample time (local; TZ=UTC in tests)");
});
