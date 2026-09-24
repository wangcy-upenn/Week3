// Vercel serverless function - the second live data source.
// National Weather Service, api.weather.gov. No API key, no account, no cost.
// Like SEPTA it sends no CORS headers, so the browser cannot call it directly.
// The grid cell was resolved once from the stop's coordinates
// (https://api.weather.gov/points/39.9487,-75.1588 -> PHI/50,79).
 
const HOURLY = "https://api.weather.gov/gridpoints/PHI/50,79/forecast/hourly";
 
// NWS gives a chance of precipitation per hour. Below this we call it dry.
const RAIN_POP = 40;
 
const UA = "from-here-prototype (UPenn IPD 5900 course project)";
const WET = /rain|shower|storm|drizzle|sleet|snow/i;
 
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=1800");
 
  try {
    const r = await fetch(HOURLY, {
      headers: { "User-Agent": UA, Accept: "application/geo+json" },
    });
    if (!r.ok) throw new Error("weather.gov returned " + r.status);
    const j = await r.json();
 
    const raw = (j.properties && j.properties.periods) || [];
    const periods = raw.slice(0, 8).map((p) => ({
      start: p.startTime,
      temp: p.temperature,
      unit: p.temperatureUnit,
      pop:
        p.probabilityOfPrecipitation &&
        typeof p.probabilityOfPrecipitation.value === "number"
          ? p.probabilityOfPrecipitation.value
          : 0,
      wind: p.windSpeed,
      short: p.shortForecast,
      day: p.isDaytime,
    }));
 
    const now = periods[0] || null;
    const nowRaining = !!now && (now.pop >= 60 || WET.test(now.short || ""));
 
    // How long until the first hour we would call wet. The forecast is hourly,
    // so this is honest to the nearest hour boundary and nothing finer.
    let rainInMinutes = null;
    let rainAt = null;
    const t0 = Date.now();
    for (const p of periods) {
      if (p.pop >= RAIN_POP) {
        rainInMinutes = Math.max(
          0,
          Math.round((new Date(p.start).getTime() - t0) / 60000)
        );
        rainAt = p.start;
        break;
      }
    }
 
    res.status(200).json({
      source: "NWS api.weather.gov, grid PHI/50,79",
      resolution: "hourly",
      threshold: RAIN_POP,
      now,
      nowRaining,
      rainInMinutes,
      rainAt,
      periods,
      updated: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
