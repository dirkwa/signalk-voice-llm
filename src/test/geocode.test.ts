// Reverse-geocoding tests. The regression that motivated this: the boat's real
// position in Fiji was answered as "Australia, near Brisbane" by the LLM.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { describePosition, reverseGeocode } from "../geocode";

test("resolves the boat's position to Fiji, not Australia", () => {
  const { codes, names } = reverseGeocode(-17.7696627, 177.1802972);
  assert.deepEqual(codes, ["FJ"]);
  assert.deepEqual(names, ["Fiji"]);
});

test("resolves a position that really is in Australia", () => {
  const { names } = reverseGeocode(-27.47, 153.02);
  assert.deepEqual(names, ["Australia"]);
});

test("handles positions just west of the antimeridian", () => {
  // At 177°E the boat is close to the 180° line; a naive sign or wrap bug
  // shows up here first.
  const { names } = reverseGeocode(-16.8, -179.9);
  assert.deepEqual(names, ["Fiji"]);
});

test("reports open ocean rather than inventing a country", () => {
  const { codes, names } = reverseGeocode(-30, -140);
  assert.deepEqual(codes, []);
  assert.deepEqual(names, []);
  assert.match(describePosition(-30, -140), /open ocean/i);
});

test("describePosition names the country in a speakable sentence", () => {
  const line = describePosition(-17.7696627, 177.1802972);
  assert.match(line, /Fiji/);
  // Spoken aloud: no markdown, no coordinate soup.
  assert.ok(!/[*_#|]/.test(line), `not speakable: ${line}`);
});

test("rejects out-of-range and non-finite input", () => {
  assert.throws(() => reverseGeocode(91, 0), RangeError);
  assert.throws(() => reverseGeocode(0, 181), RangeError);
  assert.throws(() => reverseGeocode(Number.NaN, 0), RangeError);
  // A model that swaps lat/long sends longitude in the latitude slot; at
  // 177 that is out of range and must error rather than resolve somewhere.
  assert.throws(() => reverseGeocode(177.18, -17.77), RangeError);
});
