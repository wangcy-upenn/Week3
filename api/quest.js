// Vercel serverless function - "Side Quest".
//
// A rider taps the bus they are waiting for. This function answers:
// "what can I actually do nearby and still be back before that bus comes?"
//
// Who does what:
//   TomTom     -> real places near the stop + real walking routes
//   AI         -> reads the live situation (minutes left, delay, time of day,
//                 weather) and picks 3 different things worth doing
//   hard code  -> checks the AI's time math, so nobody misses the bus
//
// Environment variables (Vercel -> Settings -> Environment Variables):
//   TOMTOM_API_KEY     real places + routes
//   DEEPSEEK_API_KEY   AI step (or ANTHROPIC_API_KEY)

const STOP = { lat: 39.948704, lng: -75.15883 };

const BUFFER_MIN = 2; // be back at the stop this long before the bus
const MIN_BUDGET = 5; // below this, don't send anyone away
const WALK_M_PER_MIN = 78; // ~1.3 m/s
const GRID_FACTOR = 1.3; // grid streets: walking distance > straight line
const MIN_DWELL = { eat: 3, shop: 4, see: 2 };

const BUCKET = {
  CAFE_PUB: "eat", RESTAURANT: "eat", MARKET: "shop", SHOP: "shop",
  SHOPPING_CENTER: "shop", MUSEUM: "see", IMPORTANT_TOURIST_ATTRACTION: "see",
  TOURIST_ATTRACTION: "see", PARK_RECREATION_AREA: "see", THEATER: "see",
  CULTURAL_CENTER: "see", PLACE_OF_WORSHIP: "see", LIBRARY: "see",
};
const CATEGORY_SET = "9376,7315,9361,7332,7317,7376,9362,7318";

// Used only when there is no TomTom key. Marked as sample data in the response.
const SAMPLE = [
  { name: "Reading Terminal Market", bucket: "eat", category: "market hall", lat: 39.9533, lon: -75.1592 },
  { name: "Midtown Village", bucket: "eat", category: "restaurants & cafés", lat: 39.9495, lon: -75.1619 },
  { name: "Jefferson Station shops", bucket: "shop", category: "shops", lat: 39.9520, lon: -75.1580 },
  { name: "Washington Square", bucket: "see", category: "park", lat: 39.9469, lon: -75.1524 },
  { name: "City Hall", bucket: "see", category: "landmark", lat: 39.9524, lon: -75.1636 },
];

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 +
    Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const walkMin = (lat, lon) =>
  Math.max(1, Math.ceil((haversine(STOP.lat, STOP.lng, lat, lon) * GRID_FACTOR) / WALK_M_PER_MIN));

async function getJSON(url, opts = {}, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(url.split("?")[0] + " -> " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---- 1. places (TomTom) ---------------------------------------------------
async function nearbyPlaces(key, radius) {
  const base = "https://api.tomtom.com/search/2/nearbySearch/.json?key=" + key +
    "&lat=" + STOP.lat + "&lon=" + STOP.lng + "&radius=" + radius + "&limit=100";
  let j = await getJSON(base + "&categorySet=" + CATEGORY_SET);
  if (!j.results || !j.results.length) j = await getJSON(base);
  const seen = new Set(), out = [];
  for (const x of j.results || []) {
    const poi = x.poi || {};
    const code = (poi.classifications && poi.classifications[0] && poi.classifications[0].code) || "";
    const bucket = BUCKET[code];
    if (!bucket || !poi.name || seen.has(poi.name)) continue;
    seen.add(poi.name);
    out.push({
      name: poi.name,
      bucket,
      category: (poi.categories && poi.categories[0]) || code.toLowerCase(),
      lat: x.position.lat,
      lon: x.position.lon,
    });
  }
  return out;
}

// ---- 2. context the AI reads ---------------------------------------------
async function weatherLine() {
  try {
    const j = await getJSON("https://api.weather.gov/gridpoints/PHI/50,79/forecast/hourly",
      { headers: { "User-Agent": "from-here-prototype (UPenn IPD course)", Accept: "application/geo+json" } }, 2500);
    const p = j.properties.periods[0];
    return p.temperature + "°" + p.temperatureUnit + ", " + p.shortForecast +
      (p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value
        ? ", " + p.probabilityOfPrecipitation.value + "% chance of rain" : "");
  } catch { return "unknown"; }
}
function localTime() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "long", hour: "numeric", minute: "2-digit",
  });
}

// ---- 3. the AI step -------------------------------------------------------
const SYSTEM = `You are the brain of a bus-stop screen at 11th & Walnut St, Philadelphia.
A rider just tapped the bus they are waiting for. They have a few minutes to kill.
Pick exactly 3 things they could do nearby and still be back in time.

Rules:
- Round trip must fit: 2 x walk + dwell <= budget. "walk" is given per place. You choose "dwell" (minutes spent there).
- Make the 3 options different kinds when possible: one "eat", one "shop", one "see".
- Read the situation: time of day (don't suggest a bar at 9am or a museum that's surely closed at 11pm), weather (rain -> closer places, indoors), how long the wait is (short wait -> quick grab; long wait -> something to browse).
- If the bus is delayed, you may say so warmly in "note".
- "pitch": max 60 characters, concrete, what to do there (e.g. "Grab a soft pretzel at the Amish counter"). No made-up facts about prices or menus you can't know; keep it generic if unsure.
- "note": one short sentence (max 70 chars) framing the moment for the rider.
Reply with JSON only:
{"note":"...","options":[{"id":<number>,"dwell":<minutes>,"pitch":"..."}]}`;

async function askDeepSeek(key, user) {
  const j = await getJSON("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
      max_tokens: 400,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    }),
  }, 8000);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

async function askAI(ctx, candidates) {
  const list = candidates.map((c, i) =>
    `${i}. ${c.name} | ${c.bucket} | ${c.category} | walk ${c.walk} min`).join("\n");
  const user =
    `Bus ${ctx.route} arrives in ${ctx.minutes} min${ctx.late ? ` (running ${ctx.late} min late)` : ""}.\n` +
    `Budget (must be back ${BUFFER_MIN} min early): ${ctx.budget} min.\n` +
    `Local time: ${ctx.time}. Weather: ${ctx.weather}.\n\nPlaces:\n${list}`;

  if (process.env.DEEPSEEK_API_KEY) {
    const text = await askDeepSeek(process.env.DEEPSEEK_API_KEY.trim(), user);
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const j = await getJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key.trim(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  }, 7000);
  const text = (j.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// Rule-based stand-in when the AI is unavailable: closest place per kind.
function rulePick(candidates, budget) {
  const out = [];
  for (const b of ["eat", "shop", "see"]) {
    const c = candidates.map((x, i) => ({ ...x, id: i })).filter((x) => x.bucket === b)[0];
    if (c) out.push({ id: c.id, dwell: Math.min(8, budget - 2 * c.walk), pitch: "" });
  }
  return { note: "", options: out };
}

// ---- 4. real walking route (TomTom) --------------------------------------
async function walkRoute(key, lat, lon) {
  const url = "https://api.tomtom.com/routing/1/calculateRoute/" +
    STOP.lat + "," + STOP.lng + ":" + lat + "," + lon +
    "/json?travelMode=pedestrian&routeType=shortest&key=" + key;
  const j = await getJSON(url, {}, 3500);
  const r = j.routes[0];
  return {
    walk: Math.max(1, Math.ceil(r.summary.travelTimeInSeconds / 60)),
    path: r.legs[0].points.map((p) => [p.latitude, p.longitude]),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const route = String(q.route || "21");
  const minutes = Math.max(0, parseInt(q.minutes, 10) || 0);
  const late = parseInt(q.late, 10) || 0;
  const budget = minutes - BUFFER_MIN;

  if (budget < MIN_BUDGET) {
    return res.status(200).json({
      route, minutes, budget, stay: true, options: [],
      note: `Bus ${route} is almost here - better stay put.`,
    });
  }

  const tomtom = (process.env.TOMTOM_API_KEY || "").trim();
  const maxWalk = Math.floor((budget - 2) / 2);
  const radius = Math.min(900, Math.round((maxWalk * WALK_M_PER_MIN) / GRID_FACTOR));

  try {
    let places, sample = false;
    try {
      places = tomtom ? await nearbyPlaces(tomtom, radius) : null;
    } catch { places = null; }
    if (!places || !places.length) { places = SAMPLE; sample = true; }

    // Hard filter first: only places where a round trip + minimum stay fits.
    const candidates = places
      .map((p) => ({ ...p, walk: walkMin(p.lat, p.lon) }))
      .filter((p) => 2 * p.walk + MIN_DWELL[p.bucket] <= budget)
      .sort((a, b) => a.walk - b.walk)
      .slice(0, 24);

    if (!candidates.length) {
      return res.status(200).json({
        route, minutes, budget, stay: true, options: [], sample,
        note: `Nothing fits in ${budget} minutes - the ${route} is close.`,
      });
    }

    const ctx = { route, minutes, late, budget, time: localTime(), weather: await weatherLine() };
    let pick = null, ai = false;
    try { pick = await askAI(ctx, candidates); ai = !!pick; } catch { pick = null; }
    if (!pick || !Array.isArray(pick.options)) pick = rulePick(candidates, budget);

    // Check the AI's picks against real walking routes; trim or drop what doesn't fit.
    const used = new Set();
    const picks = [];
    for (const o of pick.options) {
      const id = Number(o.id);
      if (!candidates[id] || used.has(id)) continue;
      used.add(id);
      picks.push({ o, c: candidates[id] });
    }
    const checked = await Promise.all(picks.slice(0, 4).map(async ({ o, c }) => {
      let walk = c.walk, path = null;
      if (tomtom && !sample) {
        try { ({ walk, path } = await walkRoute(tomtom, c.lat, c.lon)); } catch {}
      }
      const room = budget - 2 * walk;
      const dwell = Math.min(Math.max(1, Math.round(Number(o.dwell) || 0)), room);
      if (dwell < MIN_DWELL[c.bucket] - 1) return null;
      return {
        name: c.name, bucket: c.bucket, category: c.category,
        lat: c.lat, lon: c.lon, walk, dwell,
        pitch: String(o.pitch || "").slice(0, 70),
        path,
      };
    }));
    const options = checked.filter(Boolean).slice(0, 3);

    res.status(200).json({
      route, minutes, budget, late, ai, sample,
      note: String(pick.note || "").slice(0, 80),
      context: { time: ctx.time, weather: ctx.weather },
      options,
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
