// Marine + tide formatting — pure functions, no network.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { formatMarine, formatTides, WEATHER_DEFAULTS } from "../weather";

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
