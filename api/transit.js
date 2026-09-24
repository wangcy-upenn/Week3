// Vercel serverless function - "how do I get there from THIS stop?"
//
// For each well-known Philadelphia landmark, work out the best DIRECT option
// from stop 14885 (Walnut & 11th): walk, or ride one of the four buses that
// stop here (9, 12, 21, 42) and get off near it.
//
// This is deliberately hard code, not AI: a wrong bus on a bus-stop screen
// sends a real person the wrong way. The bus stop list comes straight from
// SEPTA (https://www3.septa.org/api/Stops/index.php?req1=<route>).
//
// Limits, stated honestly on screen:
//   - direct rides only, no transfers (SEPTA has no public trip-planner API)
//   - every bus here heads WEST on Walnut, so only stops west of 11th St count
//   - ride time is estimated from distance, like the arrival estimate

const STOP = { lat: 39.948704, lng: -75.15883 };
const ROUTES = ["9", "12", "21", "42"];

const LANDMARKS = [
  { id: "libertybell", nm: "Liberty Bell", cat: "history", ll: [39.9496, -75.1503] },
  { id: "indhall", nm: "Independence Hall", cat: "history", ll: [39.9489, -75.1500] },
  { id: "amrev", nm: "Museum of the American Revolution", cat: "history", ll: [39.9484, -75.1456] },
  { id: "elfreth", nm: "Elfreth's Alley", cat: "history", ll: [39.9527, -75.1425] },
  { id: "pennslanding", nm: "Penn's Landing", cat: "park", ll: [39.9460, -75.1410] },
  { id: "washsq", nm: "Washington Square", cat: "park", ll: [39.9466, -75.1524] },
  { id: "chinatown", nm: "Chinatown Friendship Arch", cat: "culture", ll: [39.9535, -75.1558] },
  { id: "reading", nm: "Reading Terminal Market", cat: "food", ll: [39.9533, -75.1590] },
  { id: "magic", nm: "Magic Gardens", cat: "art", ll: [39.9427, -75.1593] },
  { id: "italian", nm: "Italian Market", cat: "food", ll: [39.9385, -75.1579] },
  { id: "cityhall", nm: "City Hall", cat: "history", ll: [39.9524, -75.1636] },
  { id: "love", nm: "LOVE Park", cat: "park", ll: [39.9543, -75.1653] },
  { id: "kimmel", nm: "Kimmel Center", cat: "art", ll: [39.9467, -75.1655] },
  { id: "rittenhouse", nm: "Rittenhouse Square", cat: "park", ll: [39.9496, -75.1718] },
  { id: "franklin", nm: "Franklin Institute", cat: "museum", ll: [39.9582, -75.1731] },
  { id: "barnes", nm: "Barnes Foundation", cat: "art", ll: [39.9606, -75.1727] },
  { id: "pma", nm: "Museum of Art (Rocky Steps)", cat: "art", ll: [39.9656, -75.1810] },
  { id: "eastern", nm: "Eastern State Penitentiary", cat: "history", ll: [39.9683, -75.1727] },
  { id: "30th", nm: "30th Street Station", cat: "transit", ll: [39.9557, -75.1820] },
  { id: "penn", nm: "University of Pennsylvania", cat: "culture", ll: [39.9515, -75.1940] },
  { id: "zoo", nm: "Philadelphia Zoo", cat: "park", ll: [39.9714, -75.1955] },
];

const WALK_M_PER_MIN = 80; // ~1.33 m/s
const BUS_M_PER_MIN = 3.1 * 60; // same speed as the arrival estimate
const BUS_GRID = 1.25;
const MAX_WALK_AFTER = 12; // minutes from the bus stop to the landmark
const WEST_MARGIN = 0.0015; // a stop must be clearly west of 11th St

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 +
    Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Center City is a grid, so walking distance ~ east-west + north-south legs.
const walkMin = (aLat, aLng, bLat, bLng) =>
  Math.max(1, Math.ceil((haversine(aLat, aLng, aLat, bLng) + haversine(aLat, bLng, bLat, bLng)) / WALK_M_PER_MIN));

async function stopsFor(route) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch("https://www3.septa.org/api/Stops/index.php?req1=" + route,
      { headers: { "User-Agent": "from-here-prototype" }, signal: ctl.signal });
    if (!r.ok) throw new Error("SEPTA stops " + route + " -> " + r.status);
    const j = await r.json();
    const list = Array.isArray(j) ? j : Object.values(j || {});
    return list.map((s) => ({ name: s.stopname, lat: parseFloat(s.lat), lng: parseFloat(s.lng) }))
      .filter((s) => isFinite(s.lat) && isFinite(s.lng) && s.name);
  } finally { clearTimeout(t); }
}

// Stops change rarely - keep them for the life of the function instance.
let cache = null, cachedAt = 0;
async function allStops() {
  if (cache && Date.now() - cachedAt < 6 * 3600 * 1000) return cache;
  const out = {};
  await Promise.all(ROUTES.map(async (r) => {
    try { out[r] = await stopsFor(r); } catch { out[r] = []; }
  }));
  if (Object.values(out).some((l) => l.length)) { cache = out; cachedAt = Date.now(); }
  return out;
}

function planFor(lm, stops) {
  const [lat, lng] = lm.ll;
  const walk = walkMin(STOP.lat, STOP.lng, lat, lng);
  let best = null;
  for (const route of ROUTES) {
    for (const s of stops[route] || []) {
      if (s.lng > STOP.lng - WEST_MARGIN) continue; // buses here only go west
      const after = walkMin(s.lat, s.lng, lat, lng);
      if (after > MAX_WALK_AFTER) continue;
      const ride = Math.max(1, Math.ceil((haversine(STOP.lat, STOP.lng, s.lat, s.lng) * BUS_GRID) / BUS_M_PER_MIN));
      const total = ride + after;
      if (!best || total < best.total || (total === best.total && after < best.walkAfter)) {
        best = { route, stop: s.name, lat: s.lat, lng: s.lng, ride, walkAfter: after, total };
      }
    }
  }
  // Only suggest the bus when it clearly beats walking (waiting time is added on screen).
  const bus = best && best.total + 3 < walk ? best : null;
  return { id: lm.id, nm: lm.nm, cat: lm.cat, ll: lm.ll, walk, bus };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  try {
    const stops = await allStops();
    const haveStops = Object.values(stops).some((l) => l.length);
    res.status(200).json({
      source: haveStops ? "SEPTA Stops API" : "SEPTA unavailable - walking times only",
      landmarks: LANDMARKS.map((lm) => planFor(lm, stops)),
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
