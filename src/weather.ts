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
}

export const WEATHER_DEFAULTS: WeatherConfig = {
  forecastHours: 12,
  timeoutMs: 8000,
  cacheMs: 10 * 60 * 1000, // 10 minutes — weather moves slowly
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

function n(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) ? v : undefined;
}
function round(v: number): string {
  return Math.round(v).toString();
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

interface CacheEntry {
  key: string; // rounded lat,lon so nearby positions reuse the fetch
  at: number;
  text: string;
}
let cache: CacheEntry | null = null;

// For tests: swap the fetch implementation and the clock.
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

  // Cache on ~1 km-rounded position so a drifting/anchored boat reuses the
  // fetch, but a passage that moves refreshes.
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (
    cfg.cacheMs > 0 &&
    cache &&
    cache.key === key &&
    now() - cache.at < cfg.cacheMs
  ) {
    return cache.text;
  }

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    "&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code,pressure_msl" +
    "&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation_probability" +
    `&forecast_hours=${Math.max(1, Math.min(48, cfg.forecastHours))}` +
    "&wind_speed_unit=kn&timezone=auto";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return "";
    const data = (await res.json()) as OpenMeteoResponse;
    const text = formatForecast(data, cfg.forecastHours);
    if (text && cfg.cacheMs > 0) cache = { key, at: now(), text };
    return text;
  } catch {
    // Offline, timeout, DNS, malformed JSON — all non-fatal. The assistant
    // just answers without a forecast (or says it doesn't have one).
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// Test hook: reset the module-level cache between cases.
export function _clearWeatherCache(): void {
  cache = null;
}
