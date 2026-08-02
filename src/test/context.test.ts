// Direct tests for the boat-data snapshot builder (src/context.ts).
//
// context.ts converts raw SI Signal K values into the clean nautical units the
// LLM sees. A silent bug here feeds the model wrong numbers, so every
// conversion, the anchor-drag logic, the battery/tank iteration (including the
// node-vs-bare-value unwrapping), the group toggles, and absent/garbage paths
// are pinned down here rather than only through one e2e assertion.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildContext,
  type ContextGroups,
  type SelfPathReader,
} from "../context";

const ALL: ContextGroups = {
  navigation: true,
  anchor: true,
  environment: true,
  electrical: true,
};

// A reader backed by a plain map. Values may be bare or wrapped as SK nodes
// ({ value: ... }) — buildContext must handle both.
function reader(paths: Record<string, unknown>): SelfPathReader {
  return { get: (p) => paths[p] };
}

test("converts SI navigation values to nautical units", () => {
  const out = buildContext(
    reader({
      "navigation.position": { latitude: 54.321987, longitude: 10.14159 },
      "navigation.speedOverGround": 5.144, // m/s -> ~10 kn
      "navigation.courseOverGroundTrue": Math.PI / 2, // rad -> 90°
      "navigation.headingTrue": Math.PI, // rad -> 180°
      "environment.depth.belowKeel": 4.2,
    }),
    ALL,
  );
  assert.match(out, /^Navigation:/m);
  assert.match(out, /position 54\.32199, 10\.14159/, "position to 5 dp");
  assert.match(out, /speed over ground 10 kn/, "m/s -> kn");
  assert.match(out, /course 90°/, "rad -> deg, rounded");
  assert.match(out, /heading 180°/);
  assert.match(out, /depth 4\.2 m/);
});

test("depth falls back through belowKeel -> belowTransducer -> belowSurface", () => {
  const t = buildContext(
    reader({ "environment.depth.belowTransducer": 3.5 }),
    ALL,
  );
  assert.match(t, /depth 3\.5 m/);
  const s = buildContext(reader({ "environment.depth.belowSurface": 6 }), ALL);
  assert.match(s, /depth 6 m/);
});

test("unwraps SK node objects ({ value }) as well as bare values", () => {
  const out = buildContext(
    reader({
      "navigation.speedOverGround": { value: 5.144, timestamp: "t", meta: {} },
      "environment.water.temperature": { value: 288.15 },
    }),
    ALL,
  );
  assert.match(out, /speed over ground 10 kn/, "unwraps a node value");
  assert.match(out, /water 15°C/, "K -> °C from a node value");
});

test("converts environment units (wind kn, temps °C, pressure hPa)", () => {
  const out = buildContext(
    reader({
      "environment.wind.speedApparent": 10.29, // ~20 kn
      "environment.wind.angleApparent": Math.PI / 4, // 45°
      "environment.wind.speedTrue": 7.72, // ~15 kn
      "environment.water.temperature": 288.15, // 15°C
      "environment.outside.temperature": 293.15, // 20°C
      "environment.outside.pressure": 101300, // 1013 hPa
    }),
    ALL,
  );
  assert.match(out, /apparent wind 20 kn/);
  assert.match(out, /apparent wind angle 45°/);
  assert.match(out, /true wind 15 kn/);
  assert.match(out, /water 15°C/);
  assert.match(out, /air 20°C/);
  assert.match(out, /pressure 1013 hPa/);
});

test("anchor: reports drag when currentRadius exceeds maxRadius", () => {
  const dragging = buildContext(
    reader({
      "navigation.anchor.state": "on",
      "navigation.anchor.maxRadius": 30,
      "navigation.anchor.currentRadius": 42,
    }),
    ALL,
  );
  assert.match(dragging, /anchored/);
  assert.match(dragging, /currently 42 m from the anchor/);
  assert.match(dragging, /watch radius 30 m/);
  assert.match(dragging, /OUTSIDE the watch circle \(possible drag\)/);

  const holding = buildContext(
    reader({
      "navigation.anchor.maxRadius": 30,
      "navigation.anchor.currentRadius": 12,
    }),
    ALL,
  );
  assert.match(holding, /inside the watch circle/);
  assert.doesNotMatch(holding, /drag/);
});

test("anchor: 'not anchored' when there is no state and no radius", () => {
  const out = buildContext(reader({}), ALL);
  assert.match(out, /Anchor: not anchored/);
});

test("anchor: maxRadius > 0 counts as anchored even without state 'on'", () => {
  const out = buildContext(reader({ "navigation.anchor.maxRadius": 25 }), ALL);
  assert.match(out, /anchored/);
  assert.doesNotMatch(out, /not anchored/);
});

test("electrical: iterates battery banks and unwraps nested values", () => {
  const out = buildContext(
    reader({
      "electrical.batteries": {
        house: {
          capacity: { stateOfCharge: { value: 0.87 } },
          voltage: { value: 12.6 },
        },
        start: {
          // bare (un-nested) forms must also work
          capacity: { stateOfCharge: 0.5 },
          voltage: 12.1,
        },
      },
    }),
    ALL,
  );
  // Voltage is formatted to 2 dp (fmt(v, 2)); "12.60" keeps its trailing zero.
  assert.match(out, /battery house 87%, 12\.60 V/);
  assert.match(out, /battery start 50%, 12\.10 V/);
});

test("tide: reports current height + state and orders next high/low by time", () => {
  // low (14:56) is sooner than high (08:55 next day) -> low listed first.
  const out = buildContext(
    reader({
      "environment.tide.state": "rising",
      "environment.tide.heightNow": 1.08,
      "environment.tide.timeHigh": "2026-08-03T08:55:03.558Z",
      "environment.tide.heightHigh": 1.78,
      "environment.tide.timeLow": "2026-08-02T14:56:15.627Z",
      "environment.tide.heightLow": 0.59,
    }),
    ALL,
  );
  assert.match(out, /^Tide: 1\.1 m and rising;/m);
  const tideLine = out.split("\n").find((l) => l.startsWith("Tide:"))!;
  const lowIdx = tideLine.indexOf("low water");
  const highIdx = tideLine.indexOf("high water");
  assert.ok(
    lowIdx > 0 && highIdx > 0 && lowIdx < highIdx,
    "sooner extreme first",
  );
  assert.match(out, /next low water 14:56 UTC \(0\.6 m\)/);
  assert.match(out, /next high water 08:55 UTC \(1\.8 m\)/);
});

test("tide: omitted entirely when no tide data is present", () => {
  const out = buildContext(reader({}), ALL);
  assert.doesNotMatch(out, /Tide:/);
});

test("tide: is gated by the environment group toggle", () => {
  const out = buildContext(reader({ "environment.tide.heightNow": 1.0 }), {
    ...ALL,
    environment: false,
  });
  assert.doesNotMatch(out, /Tide:/);
});

test("tide: reports a single upcoming extreme when only one is present", () => {
  const out = buildContext(
    reader({
      "environment.tide.timeHigh": "2026-08-02T08:55:00.000Z",
      "environment.tide.heightHigh": 1.8,
    }),
    ALL,
  );
  assert.match(out, /^Tide: next high water 08:55 UTC \(1\.8 m\)\.$/m);
  assert.doesNotMatch(out, /low water/);
});

test("tide: drops an unparseable timestamp instead of emitting a blank time", () => {
  // A malformed timeHigh must not reach slice()/toISOString(): the good low
  // extreme still renders, the bad high is silently dropped, no crash / blank.
  const out = buildContext(
    reader({
      "environment.tide.timeHigh": "not-a-date",
      "environment.tide.heightHigh": 1.8,
      "environment.tide.timeLow": "2026-08-02T14:56:00.000Z",
      "environment.tide.heightLow": 0.6,
    }),
    ALL,
  );
  assert.match(out, /Tide: next low water 14:56 UTC \(0\.6 m\)\./);
  assert.doesNotMatch(out, /high water/);
  assert.doesNotMatch(out, /Invalid|NaN|undefined/);
});

test("tide: unwraps SK node ({ value }) tide paths", () => {
  const out = buildContext(
    reader({
      "environment.tide.heightNow": { value: 1.5 },
      "environment.tide.state": { value: "rising" },
      "environment.tide.timeHigh": { value: "2026-08-02T08:55:00.000Z" },
      "environment.tide.heightHigh": { value: 1.8 },
    }),
    ALL,
  );
  assert.match(out, /Tide: 1\.5 m and rising; next high water 08:55 UTC/);
});

test("electrical: iterates tanks by type and id as percentages", () => {
  const out = buildContext(
    reader({
      tanks: {
        fuel: { "0": { currentLevel: { value: 0.75 } } },
        freshWater: { "0": { currentLevel: 0.4 } },
      },
    }),
    ALL,
  );
  assert.match(out, /fuel tank 0 75%/);
  assert.match(out, /freshWater tank 0 40%/);
});

test("respects the group toggles", () => {
  const paths = {
    "navigation.headingTrue": Math.PI,
    "environment.outside.pressure": 101300,
  };
  const navOnly = buildContext(reader(paths), {
    ...ALL,
    environment: false,
    anchor: false,
    electrical: false,
  });
  assert.match(navOnly, /Navigation:/);
  assert.doesNotMatch(navOnly, /Environment:/);
  assert.doesNotMatch(navOnly, /Anchor:/, "anchor group off -> no anchor line");

  const envOnly = buildContext(reader(paths), {
    ...ALL,
    navigation: false,
    anchor: false,
    electrical: false,
  });
  assert.match(envOnly, /Environment:/);
  assert.doesNotMatch(envOnly, /Navigation:/);
});

test("never throws on hostile / malformed path values", () => {
  // buildContext runs while assembling the LLM prompt; a throw here would fail
  // the whole voice reply. Every reader lookup returns something abusive: wrong
  // types where objects are expected, nested nulls, primitives for maps.
  const garbage: unknown[] = [
    null,
    undefined,
    42,
    "str",
    [],
    {},
    { value: null },
    { value: {} },
    { latitude: "x", longitude: {} },
    { capacity: 5, voltage: [] },
    NaN,
    Infinity,
    Symbol("s"),
    () => 0,
  ];
  let i = 0;
  const hostile: SelfPathReader = {
    // Cycle through the garbage values for whatever path is asked.
    get: () => garbage[i++ % garbage.length],
  };
  assert.doesNotThrow(() => {
    const out = buildContext(hostile, ALL);
    assert.equal(typeof out, "string");
    assert.doesNotMatch(out, /undefined|NaN|Infinity|null/);
  });
});

test("electrical never throws when batteries/tanks are wrong shapes", () => {
  // These paths are iterated with Object.entries, so a primitive/array where a
  // map is expected must be tolerated, not crash.
  for (const bad of [42, "x", null, [1, 2], { house: 7 }, { house: null }]) {
    assert.doesNotThrow(() =>
      buildContext(reader({ "electrical.batteries": bad, tanks: bad }), ALL),
    );
  }
});

test("omits absent and non-finite values without placeholders", () => {
  const out = buildContext(
    reader({
      "navigation.speedOverGround": NaN,
      "navigation.headingTrue": "not a number",
      "environment.outside.pressure": Infinity,
      "environment.depth.belowKeel": null,
    }),
    ALL,
  );
  // Nothing usable in navigation/environment -> those lines are dropped.
  assert.doesNotMatch(out, /undefined|NaN|Infinity|null/);
  assert.doesNotMatch(out, /speed over ground/);
  assert.doesNotMatch(out, /heading/);
  assert.doesNotMatch(out, /pressure/);
});
