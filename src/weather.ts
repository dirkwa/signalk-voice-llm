// Live weather + sea state for the boat's position, sourced from the SignalK
// **Weather API** (`app.weatherApi.getForecasts`) rather than fetched directly.
//
// A weather-provider plugin (e.g. @signalk/open-meteo-provider) supplies the
// data in-process, so this plugin owns no HTTP client, no API keys, and no host
// config — and it works with whatever provider the user has installed. If no
// provider is registered the call throws and we simply return "" (best-effort,
// like the rest of the boat snapshot). Tides come from `environment.tide.*` in
// the data model (see context.ts), populated by a tides plugin.
//
// The provider hands back SI units (Kelvin, Pascals, m/s, radians); we convert
// to the nautical units the spoken reply uses.

const RAD2DEG = 180 / Math.PI;
const MS2KN = 1.943844;

// Minimal shape of the SignalK Weather API surface this plugin consumes. The
// full type lives in @signalk/server-api, but the plugin deliberately carries
// no @signalk/* dependency (it treats the server `app` as loosely typed, as it
// already does for deltas/subscriptions), so we declare just what we use.
export type WeatherForecastType = "point" | "daily";
export interface WeatherData {
  date?: string;
  description?: string;
  outside?: {
    temperature?: number; // K
    pressure?: number; // Pa
  };
  wind?: {
    speedTrue?: number; // m/s
    directionTrue?: number; // rad
    gust?: number; // m/s
  };
  water?: {
    waveSignificantHeight?: number; // m
    wavePeriod?: number; // s
    waveDirection?: number; // rad
    swellHeight?: number; // m
    swellPeriod?: number; // s
  };
}
export interface WeatherApiLike {
  getForecasts: (
    position: { latitude: number; longitude: number },
    type: WeatherForecastType,
    options?: { maxCount?: number },
  ) => Promise<WeatherData[]>;
}

export interface WeatherConfig {
  // How many point-forecast intervals ahead to request/summarise. The provider
  // decides the interval length (Open-Meteo = hourly), so this is roughly hours.
  forecastHours: number;
  // Also summarise sea state (waves + swell) when the provider supplies it.
  marine: boolean;
}

export const WEATHER_DEFAULTS: WeatherConfig = {
  forecastHours: 12,
  marine: true,
};

// 16-point compass name from RADIANS, so the model can say "south-westerly"
// rather than reading a bearing aloud.
const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];
function compassRad(rad: unknown): string | undefined {
  if (typeof rad !== "number" || !isFinite(rad)) return undefined;
  const deg = rad * RAD2DEG;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function n(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) ? v : undefined;
}
function round(v: number): string {
  return Math.round(v).toString();
}
// One decimal for sub-metre marine quantities (0.3 m swell must not round to 0).
function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
function kToC(k: number): number {
  return k - 273.15;
}
function paToHpa(pa: number): number {
  return pa / 100;
}
function msToKn(ms: number): number {
  return ms * MS2KN;
}

// Format the first forecast entry as "now" plus a few later samples into a
// short, TTS-friendly block. Returns "" if there's nothing usable.
export function formatForecast(
  forecasts: WeatherData[],
  forecastHours: number,
): string {
  if (!Array.isArray(forecasts) || forecasts.length === 0) return "";
  const lines: string[] = [];

  const now = forecasts[0];
  if (now) {
    const parts: string[] = [];
    if (typeof now.description === "string" && now.description.trim())
      parts.push(now.description.trim());
    const t = n(now.outside?.temperature);
    if (t !== undefined) parts.push(`${round(kToC(t))}°C`);
    const ws = n(now.wind?.speedTrue);
    const wd = compassRad(now.wind?.directionTrue);
    if (ws !== undefined)
      parts.push(`wind ${wd ? `${wd} ` : ""}${round(msToKn(ws))} kn`);
    const p = n(now.outside?.pressure);
    if (p !== undefined) parts.push(`${round(paToHpa(p))} hPa`);
    if (parts.length) lines.push(`Now: ${parts.join(", ")}.`);
  }

  // Summarise the window: up to 3 evenly-spaced later points so the model sees
  // the trend without a wall of numbers.
  const count = Math.min(forecasts.length, Math.max(1, forecastHours));
  const picks: number[] = [];
  for (const frac of [1 / 3, 2 / 3, 1]) {
    const idx = Math.min(count - 1, Math.round(frac * (count - 1)));
    if (idx > 0 && !picks.includes(idx)) picks.push(idx);
  }
  const samples: string[] = [];
  for (const i of picks) {
    const f = forecasts[i];
    if (!f) continue;
    const time = typeof f.date === "string" ? f.date.slice(11, 16) : ""; // HH:MM (UTC)
    const parts: string[] = [];
    const ws = n(f.wind?.speedTrue);
    const wd = compassRad(f.wind?.directionTrue);
    const gust = n(f.wind?.gust);
    if (ws !== undefined)
      parts.push(
        `wind ${wd ? `${wd} ` : ""}${round(msToKn(ws))}${
          gust !== undefined ? ` gusting ${round(msToKn(gust))}` : ""
        } kn`,
      );
    const t = n(f.outside?.temperature);
    if (t !== undefined) parts.push(`${round(kToC(t))}°C`);
    if (time && parts.length) samples.push(`${time} ${parts.join(", ")}`);
  }
  if (samples.length) lines.push(`Later: ${samples.join("; ")}.`);

  return lines.join("\n");
}

// One-line sea-state summary from the first forecast's water data, or "".
export function formatMarine(forecasts: WeatherData[]): string {
  if (!Array.isArray(forecasts) || forecasts.length === 0) return "";
  const w = forecasts[0]?.water;
  if (!w) return "";
  const parts: string[] = [];
  const wh = n(w.waveSignificantHeight);
  const wd = compassRad(w.waveDirection);
  const wp = n(w.wavePeriod);
  if (wh !== undefined)
    parts.push(
      `waves ${round1(wh)} m${wd ? ` from ${wd}` : ""}${
        wp !== undefined ? ` at ${round1(wp)} s` : ""
      }`,
    );
  const sh = n(w.swellHeight);
  const sp = n(w.swellPeriod);
  if (sh !== undefined)
    parts.push(
      `swell ${round1(sh)} m${sp !== undefined ? ` at ${round1(sp)} s` : ""}`,
    );
  return parts.length ? `Sea state: ${parts.join(", ")}.` : "";
}

/**
 * Build a compact weather + sea-state block for (lat, lon) via the SignalK
 * Weather API. Returns "" if weather is unavailable (no provider registered,
 * the call fails, or nothing usable) — NEVER throws, so a missing forecast can
 * never fail a voice reply.
 */
export async function fetchWeather(
  lat: number,
  lon: number,
  cfg: WeatherConfig,
  weatherApi: WeatherApiLike | undefined,
): Promise<string> {
  if (!weatherApi || typeof weatherApi.getForecasts !== "function") return "";
  if (!isFinite(lat) || !isFinite(lon)) return "";
  const maxCount = Math.max(1, Math.min(48, cfg.forecastHours));
  let forecasts: WeatherData[];
  try {
    forecasts = await weatherApi.getForecasts(
      { latitude: lat, longitude: lon },
      "point",
      { maxCount },
    );
  } catch {
    // No provider registered / provider error — best-effort, just no weather.
    return "";
  }
  if (!Array.isArray(forecasts)) return "";
  const parts: string[] = [];
  const forecast = safeFormat(() =>
    formatForecast(forecasts, cfg.forecastHours),
  );
  if (forecast) parts.push(forecast);
  if (cfg.marine) {
    const marine = safeFormat(() => formatMarine(forecasts));
    if (marine) parts.push(marine);
  }
  return parts.join("\n");
}

// Run a formatter, absorbing any throw into "" — the formatters tolerate
// malformed data, but this backstop keeps the never-throws guarantee even if a
// provider returns an unexpected shape.
function safeFormat(fn: () => string): string {
  try {
    return fn();
  } catch {
    return "";
  }
}
