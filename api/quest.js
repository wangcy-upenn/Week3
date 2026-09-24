// Vercel serverless function - Side Quest + Explore.
//
//   /api/quest?mode=wait&route=21&minutes=12   "my bus is far, what fits?"
//   /api/quest?mode=explore&cat=food            food | sights | gems | shops
//   /api/quest?mode=route&lat=..&lon=..          walking route to one place
//
// Who does what:
//   TomTom     -> real places near the stop, their opening hours, walking routes
//   AI         -> reads the live situation (wait time, delay, time of day,
//                 weather, who is open) and picks 3 places + a one-line pitch
//   hard code  -> drops closed places and checks the AI's time math, so the AI
//                 can never send someone somewhere shut, or make them miss the bus
//
// Vercel environment variables:
//   TOMTOM_API_KEY     places, hours, routes
//   DEEPSEEK_API_KEY   the AI step (or ANTHROPIC_API_KEY)

const STOP = { lat: 39.948704, lng: -75.15883 };

const BUFFER_MIN = 2; // be back at the stop this long before the bus
const MIN_BUDGET = 5; // below this, don't send anyone away
const EXPLORE_RADIUS = 800; // ~10 min walk
const WALK_M_PER_MIN = 78; // ~1.3 m/s
const GRID_FACTOR = 1.3; // grid streets: walking distance > straight line
const MIN_DWELL = { eat: 3, shop: 4, see: 2 };

// TomTom classification code -> kind of place.
const KIND = {
  CAFE_PUB: "eat", RESTAURANT: "eat",
  SHOP: "shop", MARKET: "shop", SHOPPING_CENTER: "shop",
  MUSEUM: "see", IMPORTANT_TOURIST_ATTRACTION: "see", TOURIST_ATTRACTION: "see",
  PARK_RECREATION_AREA: "see", THEATER: "see", CULTURAL_CENTER: "see",
  PLACE_OF_WORSHIP: "see", LIBRARY: "see",
};
// café/pub, restaurant, shop, market, museum, important tourist attraction,
// park, theater
const CATEGORY_SET = "9376,7315,9361,7332,7317,7376,9362,7318";

// Explore menu -> which kinds of place qualify, and what we ask the AI for.
const CATS = {
  food:   { kinds: ["eat"],  ask: "the 3 best places to eat or drink right now" },
  sights: { kinds: ["see"],  ask: "the 3 most worthwhile sights, landmarks or cultural spots" },
  shops:  { kinds: ["shop"], ask: "the 3 most interesting shops to browse" },
  gems:   { kinds: ["eat", "shop", "see"],
            ask: "3 places with real local Philadelphia character - independent, historic or one-of-a-kind. Avoid national chains" },
};

// ---------------------------------------------------------------- helpers
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

// ---------------------------------------------------------------- hours
// Philadelphia "now" in minutes, on the same scale as TomTom's local times.
function phillyNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return stamp(`${p.year}-${p.month}-${p.day}`, +p.hour, +p.minute);
}
function stamp(date, hour, minute) {
  return Math.floor(Date.parse(date + "T00:00:00Z") / 60000) + hour * 60 + minute;
}
function clock(t) {
  const m = ((t % 1440) + 1440) % 1440, h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 || 12) + (mm ? ":" + String(mm).padStart(2, "0") : "") + (h < 12 ? " AM" : " PM");
}
// -> { open: true | false | null (unknown), closesIn (minutes), label }
function hoursState(oh, now) {
  const ranges = oh && Array.isArray(oh.timeRanges) ? oh.timeRanges : null;
  if (!ranges || !ranges.length) return { open: null, closesIn: null, label: "Hours unknown" };
  let next = null;
  for (const r of ranges) {
    if (!r.startTime || !r.endTime) continue;
    const s = stamp(r.startTime.date, r.startTime.hour, r.startTime.minute);
    const e = stamp(r.endTime.date, r.endTime.hour, r.endTime.minute);
    if (s <= now && now < e) {
      return { open: true, closesIn: e - now,
        label: e - s >= 23 * 60 + 30 ? "Open 24 hours" : "Open · closes " + clock(e) };
    }
    if (s > now && (next === null || s < next)) next = s;
  }
  return { open: false, closesIn: 0, label: next ? "Closed · opens " + clock(next) : "Closed" };
}

// ---------------------------------------------------------------- TomTom
async function nearbyPlaces(key, radius) {
  const base = "https://api.tomtom.com/search/2/nearbySearch/.json?key=" + key +
    "&lat=" + STOP.lat + "&lon=" + STOP.lng + "&radius=" + radius +
    "&limit=100&openingHours=nextSevenDays";
  let j = await getJSON(base + "&categorySet=" + CATEGORY_SET);
  if (!j.results || !j.results.length) j = await getJSON(base);
  const now = phillyNow();
  const seen = new Set(), out = [];
  for (const x of j.results || []) {
    const poi = x.poi || {};
    const code = (poi.classifications && poi.classifications[0] && poi.classifications[0].code) || "";
    const kind = KIND[code];
    if (!kind || !poi.name || seen.has(poi.name)) continue;
    seen.add(poi.name);
    const h = hoursState(poi.openingHours, now);
    out.push({
      name: poi.name, kind,
      category: (poi.categories && poi.categories[0]) || code.toLowerCase(),
      lat: x.position.lat, lon: x.position.lon,
      walk: walkMin(x.position.lat, x.position.lon),
      open: h.open, closesIn: h.closesIn, hours: h.label,
    });
  }
  return out;
}

async function walkRoute(key, lat, lon) {
  const url = "https://api.tomtom.com/routing/1/calculateRoute/" +
    STOP.lat + "," + STOP.lng + ":" + lat + "," + lon +
        "/json?travelMode=pedestrian&routeType=shortest&instructionsType=text&language=en-US&key=" + key;
  const j = await getJSON(url, {}, 3500);
  const r = j.routes[0];
  // Turn-by-turn text, e.g. "Turn right onto South 12th Street". Keep it short for a street screen.
  const ins = (r.guidance && r.guidance.instructions) || [];
  const steps = ins.map((i) => String(i.message || "").replace(/<[^>]+>/g, "").trim())
    .filter(Boolean).slice(0, 5);
  return {
    walk: Math.max(1, Math.ceil(r.summary.travelTimeInSeconds / 60)),
    meters: r.summary.lengthInMeters,
    path: r.legs[0].points.map((p) => [p.latitude, p.longitude]),
    steps,
  };
}

// ---------------------------------------------------------------- context
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

// ---------------------------------------------------------------- AI
const SYSTEM = `You are the brain of a bus-stop screen at 11th & Walnut St, Philadelphia (Center City, near Midtown Village, Washington Square, Jefferson Station, Reading Terminal Market).
You pick places for a rider standing at the stop. You only choose from the numbered list you are given.
Rules:
- Use the opening hours given. Never pick one marked Closed. "Hours unknown" is fine for parks, landmarks and public spaces; for shops and restaurants prefer ones confirmed open.
- Read the situation: time of day, weather (rain -> closer and indoors), day of week.
- Prefer local, independent places over national chains when the choice is close.
- "pitch": max 60 characters, concrete, what to do there. Don't invent prices, menus or facts you can't know - keep it generic if unsure.
- "note": one short friendly sentence (max 70 chars) for the rider.
Reply with JSON only: {"note":"...","options":[{"id":<number>,"dwell":<minutes>,"pitch":"..."}]}`;

async function askDeepSeek(key, user) {
  const j = await getJSON("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
      max_tokens: 500,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    }),
  }, 9000);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}
async function askClaude(key, user) {
  const j = await getJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      max_tokens: 500, system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  }, 9000);
  return (j.content || []).map((b) => b.text || "").join("");
}
async function askAI(user) {
  const ds = (process.env.DEEPSEEK_API_KEY || "").trim();
  const an = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!ds && !an) return null;
  const text = ds ? await askDeepSeek(ds, user) : await askClaude(an, user);
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}
const listFor = (cands) => cands.map((c, i) =>
  `${i}. ${c.name} | ${c.kind} | ${c.category} | walk ${c.walk} min | ${c.hours}`).join("\n");

// Stand-in when the AI is unavailable: nearest open place of each kind.
function rulePick(cands, kinds, dwellFor) {
  const out = [];
  const want = kinds.length === 1 ? [kinds[0], kinds[0], kinds[0]] : kinds;
  for (const k of want) {
    const i = cands.findIndex((c, idx) => c.kind === k && !out.some((o) => o.id === idx));
    if (i >= 0) out.push({ id: i, dwell: dwellFor(cands[i]), pitch: "" });
  }
  return { note: "", options: out };
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const mode = String(q.mode || "wait");
  const tomtom = (process.env.TOMTOM_API_KEY || "").trim();

  try {
    // ---- one walking route (for the landmarks already pinned on the map)
    if (mode === "route") {
      const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
      if (!isFinite(lat) || !isFinite(lon)) return res.status(400).json({ error: "lat/lon" });
      if (!tomtom) return res.status(200).json({ walk: walkMin(lat, lon), path: null });
      try { return res.status(200).json(await walkRoute(tomtom, lat, lon)); }
      catch { return res.status(200).json({ walk: walkMin(lat, lon), path: null }); }
    }

    if (!tomtom) return res.status(200).json({ error: "no TomTom key", options: [] });

    const route = String(q.route || "");
    const minutes = Math.max(0, parseInt(q.minutes, 10) || 0);
    const late = parseInt(q.late, 10) || 0;
    const cat = CATS[q.cat] ? String(q.cat) : "food";
    const budget = minutes - BUFFER_MIN;

    if (mode === "wait" && budget < MIN_BUDGET) {
      return res.status(200).json({ mode, route, minutes, stay: true, options: [],
        note: `Bus ${route} is almost here - better stay put.` });
    }

    const radius = mode === "wait"
      ? Math.min(900, Math.round((Math.floor((budget - 2) / 2) * WALK_M_PER_MIN) / GRID_FACTOR))
      : EXPLORE_RADIUS;
    const places = await nearbyPlaces(tomtom, radius);

    // Hard filters - rules, not AI judgement.
    let cands = places.filter((p) => p.open !== false);
    if (mode === "wait") {
      cands = cands.filter((p) => 2 * p.walk + MIN_DWELL[p.kind] <= budget &&
        (p.closesIn === null || p.closesIn >= p.walk + MIN_DWELL[p.kind]));
    } else {
      cands = cands.filter((p) => CATS[cat].kinds.includes(p.kind) &&
        (p.closesIn === null || p.closesIn >= p.walk + 10));
    }
    cands.sort((a, b) => (b.open === true) - (a.open === true) || a.walk - b.walk);
    cands = cands.slice(0, 30);

    if (!cands.length) {
      const closed = places.filter((p) => p.open === false).length;
      return res.status(200).json({ mode, route, minutes, cat, stay: true, options: [],
        note: closed ? "Everything nearby is closed right now." : "Nothing nearby fits right now." });
    }

    const time = localTime(), weather = await weatherLine();
    let user;
    if (mode === "wait") {
      user = `The rider is waiting for bus ${route}, arriving in ${minutes} min` +
        (late ? ` (running ${late} min late)` : "") + `.\n` +
        `They must be back ${BUFFER_MIN} min early, so the budget is ${budget} min.\n` +
        `Pick exactly 3 places, different kinds if possible (eat / shop / see).\n` +
        `Round trip must fit: 2 x walk + dwell <= ${budget}. You choose "dwell" in minutes.\n` +
        `Short wait -> quick grab. Longer wait -> something to browse.\n`;
    } else {
      user = `The rider tapped "Explore nearby" -> "${cat}". Pick ${CATS[cat].ask}.\n` +
        `Set "dwell" to a sensible visit length in minutes.\n`;
    }
    user += `Local time: ${time}. Weather: ${weather}.\n\nPlaces:\n${listFor(cands)}`;

    let pick = null, ai = false;
    try { pick = await askAI(user); ai = !!(pick && Array.isArray(pick.options)); } catch { pick = null; }
    if (!ai) {
      pick = rulePick(cands, mode === "wait" ? ["eat", "shop", "see"] : CATS[cat].kinds,
        (c) => mode === "wait" ? Math.min(8, budget - 2 * c.walk) : 20);
    }

    // Check every pick against a real walking route.
    const used = new Set(), picks = [];
    for (const o of pick.options) {
      const id = Number(o.id);
      if (!cands[id] || used.has(id)) continue;
      used.add(id);
      picks.push({ o, c: cands[id] });
    }
    const checked = await Promise.all(picks.slice(0, 4).map(async ({ o, c }) => {
      let walk = c.walk, path = null;
      try { ({ walk, path } = await walkRoute(tomtom, c.lat, c.lon)); } catch {}
      let dwell = Math.max(1, Math.round(Number(o.dwell) || 0));
      if (mode === "wait") {
        dwell = Math.min(dwell, budget - 2 * walk);
        if (c.closesIn !== null) dwell = Math.min(dwell, c.closesIn - walk);
        if (dwell < MIN_DWELL[c.kind] - 1) return null;
      }
      return {
        name: c.name, kind: c.kind, category: c.category, lat: c.lat, lon: c.lon,
        walk, dwell, hours: c.hours, open: c.open,
        pitch: String(o.pitch || "").slice(0, 70), path,
      };
    }));
    const options = checked.filter(Boolean).slice(0, 3);

    res.status(200).json({
      mode, route, minutes, budget, late, cat, ai,
      note: String(pick.note || "").slice(0, 80),
      context: { time, weather },
      options,
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
