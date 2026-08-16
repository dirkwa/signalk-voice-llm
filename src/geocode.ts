// Offline reverse geocoding: coordinates -> country.
//
// Small LLMs cannot do coordinate geography. Asked "what country am I in?" with
// the boat's real position (-17.77, 177.18, Fiji) in context, qwen2.5-7b
// answered "Australia, specifically Queensland... nearest major city Brisbane"
// — roughly 2,000 km wrong, and hedged between two wrong states, which is the
// signature of a guess rather than a lookup. Giving the model a tool turns the
// question into a lookup it cannot get wrong.
//
// Deliberately OFFLINE. This runs on a boat; the answer must not depend on
// having a connection, and "where am I" is exactly the question you ask when
// you are somewhere without one. coordinate_to_country is a bundled polygon
// dataset — no network, no API key. Country names come from Node's built-in
// Intl.DisplayNames, so no second dependency is needed.
//
// The cost is install size, not tarball size: the OSM maritime-borders dataset
// it depends on is ~47 MB unpacked in node_modules. Our own published tarball
// is unaffected. That is the price of answering "what country am I in?" with
// no connection, which on a boat is when the question is actually asked.
//
// The dataset resolves maritime zones (EEZ) as well as land, so a position at
// sea within a country's waters still names that country — which is the useful
// answer aboard. Genuinely open ocean returns no match and is reported as such
// rather than guessed at.

import coordinateToCountry from "coordinate_to_country";

export interface GeocodeResult {
  /** ISO 3166-1 alpha-2 codes, e.g. ["FJ"]. Empty on the open ocean. */
  codes: string[];
  /** Human-readable country names, e.g. ["Fiji"]. Same order as `codes`. */
  names: string[];
}

/** ISO-2 -> display name via Node's ICU data. Falls back to the raw code. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Resolve a position to the country (or countries) whose territory or maritime
 * zone contains it. Returns empty arrays for open ocean — the caller must say
 * "not in any country's waters", never invent one.
 *
 * Throws RangeError for out-of-range or non-finite input so a model that emits
 * a swapped/garbage pair gets a corrective error instead of a wrong country.
 */
export function reverseGeocode(
  latitude: number,
  longitude: number,
): GeocodeResult {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new RangeError("latitude and longitude must be finite numbers");
  }
  if (latitude < -90 || latitude > 90) {
    throw new RangeError(`latitude ${latitude} out of range (-90..90)`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new RangeError(`longitude ${longitude} out of range (-180..180)`);
  }
  // Second arg true = ISO-2 codes (the form Intl.DisplayNames expects).
  const codes = coordinateToCountry(latitude, longitude, true) as string[];
  return { codes, names: codes.map(countryName) };
}

/** One speakable line for the model to read back. */
export function describePosition(latitude: number, longitude: number): string {
  const { names } = reverseGeocode(latitude, longitude);
  if (names.length === 0) {
    return "That position is open ocean, not within any country's waters.";
  }
  // Overlapping maritime claims can match more than one country; name them all
  // rather than silently picking the first.
  return `That position is in ${names.join(" / ")}.`;
}
