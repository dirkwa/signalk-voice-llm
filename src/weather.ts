// Live weather/forecast for the boat's current position, so the assistant can
// answer "what's the weather?" or "what's the wind doing tonight?" — the local
// LLM has no internet, so we fetch a compact forecast here and hand it to the
// model as context, exactly like the boat-data snapshot.
//
// Source: Open-Meteo (https://open-meteo.com) — free, no API key, plain HTTP
// GET returning JSON. We ask for knots + °C + hPa so the block is already in
// nautical/metric units and needs no conversion.

export interface WeatherConfig {
  // How many hours of hourly forecast to summarise (a few points are picked
  // out of this window; the model doesn't need every hour).
  forecastHours: number;
  // Network timeout for the forecast fetch.
  timeoutMs: number;
  // Cache the last forecast this long so a burst of questions doesn't refetch
  // (and so we can answer instantly). 0 disables caching.
  cacheMs: number;
  // Open-Meteo API base (the /v1/forecast host). Overridable for a self-hosted
  // Open-Meteo instance — and it's the seam the tests use to point the fetch
  // at a loopback stub, so no test-only hook has to ship in the module.
  baseUrl: string;
  // Whether to also fetch the marine forecast (swell + wave period) alongside
  // the wind/weather forecast. Free and keyless, but on a different Open-Meteo
  // host (see marineBaseUrl); off-water positions just yield nothing.
  marine: boolean;
  // Open-Meteo Marine API base (the /v1/marine host — a DIFFERENT subdomain
  // from the main forecast host, which 404s on /v1/marine). Also the test seam.
  marineBaseUrl: string;
  // WorldTides API base (/api/v3). Tides have no reliable keyless source, so
  // this is opt-in: it stays off until a key is supplied. Also the test seam.
  tidesBaseUrl: string;
  // WorldTides API key. Empty = tides disabled (the default — no signup needed;
  // marine + weather still work). A free key from worldtides.info enables the
  // next high/low tide extremes for the boat's position.
  tidesApiKey: string;
}

export const WEATHER_DEFAULTS: WeatherConfig = {
  forecastHours: 12,
  timeoutMs: 8000,
  cacheMs: 10 * 60 * 1000, // 10 minutes — weather moves slowly
  baseUrl: "https://api.open-meteo.com",
  marine: true,
  marineBaseUrl: "https://marine-api.open-meteo.com",
  tidesBaseUrl: "https://www.worldtides.info",
  tidesApiKey: "",
};

// WMO weather-interpretation codes -> short plain-language descriptions.
// https://open-meteo.com/en/docs (WMO Weather interpretation codes)
const WMO: Record<number, string> = {
  0: "clear",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "light snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

function describeCode(code: unknown): string | undefined {
  return typeof code === "number" ? (WMO[code] ?? undefined) : undefined;
}

// 16-point compass name from degrees, so the model can say "south-westerly"
// rather than reading "215 degrees" aloud.
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
function compass(deg: unknown): string | undefined {
  if (typeof deg !== "number" || !isFinite(deg)) return undefined;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    weather_code?: number;
    pressure_msl?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_gusts_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    precipitation_probability?: (number | null)[];
  };
}

interface MarineResponse {
  current?: {
    wave_height?: number;
    wave_direction?: number;
    wave_period?: number;
    swell_wave_height?: number;
    swell_wave_period?: number;
  };
}

// WorldTides "extremes" response: a list of upcoming high/low waters.
// https://www.worldtides.info/apidocs
interface TideExtreme {
  dt?: number; // unix seconds
  date?: string; // ISO 8601 (local, since we request &localtime)
  height?: number; // metres relative to datum
  type?: string; // "High" | "Low"
}
interface TidesResponse {
  extremes?: (TideExtreme | null)[];
}

function n(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) ? v : undefined;
}
function round(v: number): string {
  return Math.round(v).toString();
}
// One decimal for sub-metre marine quantities where rounding to whole metres
// would erase the signal (0.3 m swell → "0" reads as flat).
function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

// Format the API payload into a short, TTS-friendly forecast block. Returns ""
// if there's nothing usable, so the caller can just append it (or not).
export function formatForecast(
  data: OpenMeteoResponse,
  forecastHours: number,
): string {
  const lines: string[] = [];

  const c = data.current;
  if (c) {
    const parts: string[] = [];
    const cond = describeCode(c.weather_code);
    if (cond) parts.push(cond);
    const t = n(c.temperature_2m);
    if (t !== undefined) parts.push(`${round(t)}°C`);
    const ws = n(c.wind_speed_10m);
    const wd = compass(c.wind_direction_10m);
    if (ws !== undefined)
      parts.push(`wind ${wd ? `${wd} ` : ""}${round(ws)} kn`);
    const p = n(c.pressure_msl);
    if (p !== undefined) parts.push(`${round(p)} hPa`);
    if (parts.length) lines.push(`Now: ${parts.join(", ")}.`);
  }

  // Summarise the next window: pick a few evenly-spaced hourly points so the
  // model sees the trend without a wall of numbers.
  const h = data.hourly;
  if (h && Array.isArray(h.time) && h.time.length) {
    const count = Math.min(h.time.length, Math.max(1, forecastHours));
    // up to 3 sample points across the window (skip the first — that's ~now).
    const picks: number[] = [];
    for (const frac of [1 / 3, 2 / 3, 1]) {
      const idx = Math.min(count - 1, Math.round(frac * (count - 1)));
      if (idx > 0 && !picks.includes(idx)) picks.push(idx);
    }
    const samples: string[] = [];
    for (const i of picks) {
      const time = (h.time[i] ?? "").slice(11, 16); // HH:MM from ISO
      const parts: string[] = [];
      const ws = n(h.wind_speed_10m?.[i]);
      const wd = compass(h.wind_direction_10m?.[i]);
      const gust = n(h.wind_gusts_10m?.[i]);
      if (ws !== undefined)
        parts.push(
          `wind ${wd ? `${wd} ` : ""}${round(ws)}${
            gust !== undefined ? ` gusting ${round(gust)}` : ""
          } kn`,
        );
      const pop = n(h.precipitation_probability?.[i]);
      if (pop !== undefined && pop >= 20) parts.push(`${round(pop)}% rain`);
      const t = n(h.temperature_2m?.[i]);
      if (t !== undefined) parts.push(`${round(t)}°C`);
      if (time && parts.length) samples.push(`${time} ${parts.join(", ")}`);
    }
    if (samples.length) lines.push(`Later: ${samples.join("; ")}.`);
  }

  return lines.join("\n");
}

// One-line sea-state summary from the marine payload, or "" if nothing usable.
export function formatMarine(data: MarineResponse): string {
  const c = data.current;
  if (!c) return "";
  const parts: string[] = [];
  const wh = n(c.wave_height);
  const wd = compass(c.wave_direction);
  const wp = n(c.wave_period);
  if (wh !== undefined)
    parts.push(
      `waves ${round1(wh)} m${wd ? ` from ${wd}` : ""}${
        wp !== undefined ? ` at ${round1(wp)} s` : ""
      }`,
    );
  const sh = n(c.swell_wave_height);
  const sp = n(c.swell_wave_period);
  if (sh !== undefined)
    parts.push(
      `swell ${round1(sh)} m${sp !== undefined ? ` at ${round1(sp)} s` : ""}`,
    );
  return parts.length ? `Sea state: ${parts.join(", ")}.` : "";
}

// Next couple of tide extremes as a short line, or "" if none upcoming.
// `nowSec` lets the caller (and tests) anchor "next" deterministically.
export function formatTides(data: TidesResponse, nowSec: number): string {
  const ex = Array.isArray(data.extremes) ? data.extremes : [];
  const upcoming = ex
    // Guard `e` itself: a malformed payload can carry null/non-object array
    // elements, and dereferencing e.dt on those would throw — which, on the
    // `void onCommand` path, becomes an unhandled rejection (crashing the
    // server). The formatters must tolerate any JSON the endpoint returns.
    .filter(
      (e): e is TideExtreme =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as TideExtreme).dt === "number" &&
        (e as TideExtreme).dt! >= nowSec &&
        // Require a renderable date too: slice(0, 2) runs before the loop's
        // date check, so without this a dateless extreme could take a slot and
        // push out a valid later one, yielding an empty/short tide line.
        typeof (e as TideExtreme).date === "string",
    )
    .slice(0, 2);
  const items: string[] = [];
  for (const e of upcoming) {
    const kind = typeof e.type === "string" ? e.type.toLowerCase() : "tide";
    const time = typeof e.date === "string" ? e.date.slice(11, 16) : "";
    const h = n(e.height);
    if (time)
      items.push(
        `${kind} at ${time}${h !== undefined ? ` (${round1(h)} m)` : ""}`,
      );
  }
  return items.length ? `Tides: next ${items.join(", then ")}.` : "";
}

interface CacheEntry {
  key: string; // rounded lat,lon so nearby positions reuse the fetch
  at: number;
  text: string;
}
let cache: CacheEntry | null = null;

// Injectable clock + fetch. These are ordinary function parameters (not global
// mutation hooks), so they carry no test-only surface into the shipped module:
// production omits `deps` and gets the real clock + fetch. Tests pass a stub
// fetch and/or a fake clock.
export interface WeatherDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Fetch a compact forecast for (lat, lon). Returns a short text block for the
 * LLM context, or "" if the position/forecast is unavailable. NEVER throws —
 * weather is a best-effort enrichment, never a reason to fail a voice reply.
 */
export async function fetchWeather(
  lat: number,
  lon: number,
  cfg: WeatherConfig,
  deps: WeatherDeps = {},
): Promise<string> {
  if (!isFinite(lat) || !isFinite(lon)) return "";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const base = (cfg.baseUrl || WEATHER_DEFAULTS.baseUrl).replace(/\/+$/, "");

  // Tides are time-relative: "next high/low" is computed against now() at fetch
  // time. Caching that text would let an extreme that has since passed still be
  // reported as "next" until the cache expires. So the cache is used only when
  // tides are OFF — forecast + marine values tolerate the cacheMs staleness
  // ("weather moves slowly"); a time-relative answer does not.
  const cacheable = !cfg.tidesApiKey;
  // Cache on ~1 km-rounded position (a drifting/anchored boat reuses the fetch;
  // a passage that moves refreshes). Key also on every input that changes the
  // formatted block — base URL, forecast window, and the marine host/on-off —
  // so editing any of them in the config UI busts the module-level cache
  // instead of serving a block computed under the old setting for up to cacheMs.
  // (The module stays loaded across a plugin stop()/start(), so the cache is
  // not cleared on a config change; the key is what invalidates it.)
  const marineBase = cfg.marine
    ? cfg.marineBaseUrl || WEATHER_DEFAULTS.marineBaseUrl
    : "";
  const key =
    `${base}|${lat.toFixed(2)},${lon.toFixed(2)}` +
    `|h${cfg.forecastHours}|m${cfg.marine ? 1 : 0}|mb${marineBase}`;
  if (
    cacheable &&
    cfg.cacheMs > 0 &&
    cache &&
    cache.key === key &&
    now() - cache.at < cfg.cacheMs
  ) {
    return cache.text;
  }

  // Forecast, marine and tides are independent best-effort fetches — run them
  // concurrently and stitch whatever comes back. Any one failing (or disabled)
  // just drops its line; the block is still useful with the others.
  const [forecast, marine, tides] = await Promise.all([
    fetchForecast(lat, lon, cfg, fetchImpl),
    cfg.marine ? fetchMarine(lat, lon, cfg, fetchImpl) : Promise.resolve(""),
    cfg.tidesApiKey
      ? fetchTides(lat, lon, cfg, fetchImpl, now)
      : Promise.resolve(""),
  ]);

  const text = [forecast, marine, tides].filter(Boolean).join("\n");
  if (text && cacheable && cfg.cacheMs > 0) cache = { key, at: now(), text };
  return text;
}

// --- individual source fetches (each never throws; returns "" on any error) --

async function fetchForecast(
  lat: number,
  lon: number,
  cfg: WeatherConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const base = (cfg.baseUrl || WEATHER_DEFAULTS.baseUrl).replace(/\/+$/, "");
  const url =
    `${base}/v1/forecast` +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    "&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code,pressure_msl" +
    "&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation_probability" +
    `&forecast_hours=${Math.max(1, Math.min(48, cfg.forecastHours))}` +
    "&wind_speed_unit=kn&timezone=auto";
  const data = await getJson<OpenMeteoResponse>(url, cfg.timeoutMs, fetchImpl);
  return data ? safeFormat(() => formatForecast(data, cfg.forecastHours)) : "";
}

async function fetchMarine(
  lat: number,
  lon: number,
  cfg: WeatherConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const base = (cfg.marineBaseUrl || WEATHER_DEFAULTS.marineBaseUrl).replace(
    /\/+$/,
    "",
  );
  const url =
    `${base}/v1/marine` +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    "&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period" +
    "&timezone=auto";
  const data = await getJson<MarineResponse>(url, cfg.timeoutMs, fetchImpl);
  return data ? safeFormat(() => formatMarine(data)) : "";
}

async function fetchTides(
  lat: number,
  lon: number,
  cfg: WeatherConfig,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<string> {
  const base = (cfg.tidesBaseUrl || WEATHER_DEFAULTS.tidesBaseUrl).replace(
    /\/+$/,
    "",
  );
  // &localtime makes WorldTides return extreme times with the location's local
  // offset (default is UTC) — so the spoken "high water at HH:MM" matches the
  // skipper's clock and the forecast lines (which use timezone=auto).
  const url =
    `${base}/api/v3` +
    `?extremes&localtime&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}` +
    `&key=${encodeURIComponent(cfg.tidesApiKey)}`;
  const data = await getJson<TidesResponse>(url, cfg.timeoutMs, fetchImpl);
  return data
    ? safeFormat(() => formatTides(data, Math.floor(now() / 1000)))
    : "";
}

// Run a formatter, absorbing any throw into "". The formatters are written to
// tolerate malformed input, but they run OUTSIDE getJson's try/catch, so a
// missed edge case would otherwise reject out of fetchWeather and, under the
// `void onCommand` caller, become an unhandled rejection (crashing the server).
// This is the backstop that keeps the never-throws guarantee true.
function safeFormat(fn: () => string): string {
  try {
    return fn();
  } catch {
    return "";
  }
}

// GET + parse JSON with a timeout. Returns null on any failure (non-2xx,
// offline, timeout, malformed) so callers stay best-effort.
async function getJson<T>(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
