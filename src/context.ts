// Build a compact, human-readable snapshot of the boat's current state from
// SignalK self-paths, to give the LLM situational awareness ("what's my
// depth?", "am I dragging?"). Kept short and unit-friendly — the model gets
// clean numbers, not raw SI radians.

export interface SelfPathReader {
  // Returns the current value at a self path, or undefined if absent.
  get(path: string): unknown;
}

const RAD2DEG = 180 / Math.PI;
const MS2KN = 1.943844;
const MS2KMH = 3.6;

// app.getSelfPath() may return either a bare value or a SignalK node object
// ({ value, meta, timestamp, ... }). Unwrap the node so callers see the value.
function unwrap(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "value" in (v as object)) {
    return (v as { value: unknown }).value;
  }
  return v;
}

function num(v: unknown): number | undefined {
  const u = unwrap(v);
  return typeof u === "number" && isFinite(u) ? u : undefined;
}

// Read a possibly-nested object value (e.g. navigation.position) after
// unwrapping the SK node.
function obj<T = Record<string, unknown>>(v: unknown): T | undefined {
  const u = unwrap(v);
  return u !== null && typeof u === "object" ? (u as T) : undefined;
}

// Read a string value (e.g. navigation.anchor.state) after unwrapping.
function str(v: unknown): string | undefined {
  const u = unwrap(v);
  return typeof u === "string" ? u : undefined;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits).replace(/\.0+$/, "");
}

/** Which data groups to include (mirrors the plugin config checkboxes). */
export interface ContextGroups {
  navigation: boolean;
  anchor: boolean;
  environment: boolean;
  electrical: boolean;
}

export function buildContext(
  reader: SelfPathReader,
  groups: ContextGroups,
): string {
  const lines: string[] = [];

  if (groups.navigation) {
    const nav: string[] = [];
    const pos = obj<{ latitude?: number; longitude?: number }>(
      reader.get("navigation.position"),
    );
    if (pos && num(pos.latitude) !== undefined && num(pos.longitude) !== undefined) {
      nav.push(
        `position ${fmt(pos.latitude!, 5)}, ${fmt(pos.longitude!, 5)}`,
      );
    }
    const sog = num(reader.get("navigation.speedOverGround"));
    if (sog !== undefined) nav.push(`speed over ground ${fmt(sog * MS2KN)} kn`);
    const cog = num(reader.get("navigation.courseOverGroundTrue"));
    if (cog !== undefined) nav.push(`course ${fmt(cog * RAD2DEG, 0)}°`);
    const hdg = num(reader.get("navigation.headingTrue"));
    if (hdg !== undefined) nav.push(`heading ${fmt(hdg * RAD2DEG, 0)}°`);
    const depth =
      num(reader.get("environment.depth.belowKeel")) ??
      num(reader.get("environment.depth.belowTransducer")) ??
      num(reader.get("environment.depth.belowSurface"));
    if (depth !== undefined) nav.push(`depth ${fmt(depth)} m`);
    if (nav.length) lines.push("Navigation: " + nav.join("; ") + ".");
  }

  if (groups.anchor) {
    const state = str(reader.get("navigation.anchor.state"));
    const maxR = num(reader.get("navigation.anchor.maxRadius"));
    const curR = num(reader.get("navigation.anchor.currentRadius"));
    const anchored =
      state === "on" || (maxR !== undefined && maxR > 0);
    if (anchored) {
      const a: string[] = ["anchored"];
      if (curR !== undefined) a.push(`currently ${fmt(curR, 0)} m from the anchor`);
      if (maxR !== undefined) a.push(`watch radius ${fmt(maxR, 0)} m`);
      if (curR !== undefined && maxR !== undefined) {
        a.push(curR > maxR ? "OUTSIDE the watch circle (possible drag)" : "inside the watch circle");
      }
      lines.push("Anchor: " + a.join("; ") + ".");
    } else {
      lines.push("Anchor: not anchored (anchor up).");
    }
  }

  if (groups.environment) {
    const env: string[] = [];
    const aws = num(reader.get("environment.wind.speedApparent"));
    if (aws !== undefined) env.push(`apparent wind ${fmt(aws * MS2KN)} kn`);
    const awa = num(reader.get("environment.wind.angleApparent"));
    if (awa !== undefined) env.push(`apparent wind angle ${fmt(awa * RAD2DEG, 0)}°`);
    const tws = num(reader.get("environment.wind.speedTrue"));
    if (tws !== undefined) env.push(`true wind ${fmt(tws * MS2KN)} kn`);
    const wt = num(reader.get("environment.water.temperature"));
    if (wt !== undefined) env.push(`water ${fmt(wt - 273.15)}°C`);
    const at = num(reader.get("environment.outside.temperature"));
    if (at !== undefined) env.push(`air ${fmt(at - 273.15)}°C`);
    const press = num(reader.get("environment.outside.pressure"));
    if (press !== undefined) env.push(`pressure ${fmt(press / 100, 0)} hPa`);
    if (env.length) lines.push("Environment: " + env.join("; ") + ".");
  }

  if (groups.electrical) {
    const el: string[] = [];
    // Battery: report every battery bank we can find a SOC/voltage for.
    const batteries = reader.get("electrical.batteries") as
      | Record<string, unknown>
      | undefined;
    if (batteries && typeof batteries === "object") {
      for (const [id, bank] of Object.entries(batteries)) {
        const b = bank as Record<string, unknown>;
        const soc = num((b?.["capacity"] as any)?.stateOfCharge?.value ?? (b?.["capacity"] as any)?.stateOfCharge);
        const volt = num((b?.["voltage"] as any)?.value ?? b?.["voltage"]);
        const parts: string[] = [];
        if (soc !== undefined) parts.push(`${fmt(soc * 100, 0)}%`);
        if (volt !== undefined) parts.push(`${fmt(volt, 2)} V`);
        if (parts.length) el.push(`battery ${id} ${parts.join(", ")}`);
      }
    }
    // Tanks: fuel + fresh water levels.
    const tanks = reader.get("tanks") as Record<string, unknown> | undefined;
    if (tanks && typeof tanks === "object") {
      for (const [type, byId] of Object.entries(tanks)) {
        if (!byId || typeof byId !== "object") continue;
        for (const [id, t] of Object.entries(byId as Record<string, unknown>)) {
          const lvl = num((t as any)?.currentLevel?.value ?? (t as any)?.currentLevel);
          if (lvl !== undefined) el.push(`${type} tank ${id} ${fmt(lvl * 100, 0)}%`);
        }
      }
    }
    if (el.length) lines.push("Electrical/tanks: " + el.join("; ") + ".");
  }

  return lines.join("\n");
}
