// Vercel serverless function.
//
// Why this file exists: the browser cannot call www3.septa.org directly
// (no CORS headers on SEPTA's API), so the page calls /api/septa on its own
// origin and this function does the cross-origin call server-side.
//
// SEPTA has no "minutes until this bus reaches this stop" endpoint, so we
// compute the estimate here from each vehicle's live position. That estimate
// is HARD CODE: an explicit, rule-based calculation.

const STOP = {
  id: "14885",
  name: "Walnut St & 11th St",
  lat: 39.948704,
  lng: -75.15883,
};

const ROUTES = [
  { id: "9", headsign: "Andorra" },
  { id: "12", headsign: "50th-Woodland" },
  { id: "21", headsign: "69th St Transit Center" },
  { id: "42", headsign: "Wycombe" },
];

const GRID_FACTOR = 1.25; // streets are a grid, so road distance > straight line
const BUS_SPEED_MS = 3.1; // ~7 mph average in Center City, including dwell time
const MAX_MINUTES = 45; // ignore vehicles further out than this
const LAT_BAND = 0.004; // ~440 m: keeps buses on the Walnut St corridor
const DELAY_MIN = 2; // minutes late before the screen calls it a delay

function haversineMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Walnut St is one-way WESTBOUND. Test the compass heading, not the Direction
// string (route 9's NORTHBOUND trip is the one that runs west on Walnut).
function headingIsWestward(h) {
  return typeof h === "number" && h > 200 && h < 340;
}

function isRealVehicle(b) {
  if (!b.VehicleID || b.VehicleID === "None") return false;
  if (typeof b.late === "number" && b.late >= 900) return false;
  return true;
}

async function fetchRoute(routeId) {
  const url = "https://www3.septa.org/api/TransitView/index.php?route=" + routeId;
  // Give up after 6 s so a slow SEPTA never makes the whole function fail.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "from-here-prototype" }, signal: ctl.signal });
    if (!res.ok) throw new Error("SEPTA " + routeId + " returned " + res.status);
    const json = await res.json();
    return Array.isArray(json.bus) ? json.bus : [];
  } finally {
    clearTimeout(timer);
  }
}

function seatState(raw) {
  const s = String(raw || "").toUpperCase();
  if (s === "EMPTY" || s === "MANY_SEATS_AVAILABLE") return "seats";
  if (s === "FEW_SEATS_AVAILABLE") return "few";
  if (s === "STANDING_ROOM_ONLY") return "standing";
  if (s === "FULL" || s === "CRUSHED_STANDING_ROOM_ONLY") return "full";
  return "unknown";
}

function nextArrival(buses, route) {
  const candidates = [];
  for (const b of buses) {
    const lat = parseFloat(b.lat);
    const lng = parseFloat(b.lng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    if (!isRealVehicle(b)) continue;
    if (lng <= STOP.lng) continue;
    if (Math.abs(lat - STOP.lat) > LAT_BAND) continue;
    if (!headingIsWestward(b.heading)) continue;

    const meters = haversineMeters(lat, lng, STOP.lat, STOP.lng) * GRID_FACTOR;
    const minutes = Math.round(meters / BUS_SPEED_MS / 60);
    if (minutes > MAX_MINUTES) continue;

    candidates.push({
      minutes,
      vehicle: b.VehicleID,
      destination: b.destination || route.headsign,
      nextStop: b.next_stop_name || null,
      late: typeof b.late === "number" ? b.late : null,
      seats: seatState(b.estimated_seat_availability),
      seatsRaw: b.estimated_seat_availability || null,
      meters: Math.round(meters),
    });
  }
  candidates.sort((a, b) => a.minutes - b.minutes);
  return candidates;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45");
  try {
    const board = [];
    const results = await Promise.all(
      ROUTES.map(async (route) => {
        try {
          const buses = await fetchRoute(route.id);
          const queue = nextArrival(buses, route);
          const next = queue[0] || null;
          for (const c of queue) {
            board.push({
              route: route.id,
              minutes: c.minutes,
              destination: c.destination,
              vehicle: c.vehicle,
              late: c.late,
              delayed: typeof c.late === "number" && c.late >= DELAY_MIN,
              seats: c.seats,
              seatsRaw: c.seatsRaw,
            });
          }
          const late = next ? next.late : null;
          return {
            route: route.id,
            destination: next ? next.destination : route.headsign,
            minutes: next ? next.minutes : null,
            vehicle: next ? next.vehicle : null,
            nextStop: next ? next.nextStop : null,
            late,
            delayed: typeof late === "number" && late >= DELAY_MIN,
            seats: next ? next.seats : "unknown",
            distanceMeters: next ? next.meters : null,
            vehiclesTracked: buses.length,
          };
        } catch (err) {
          return {
            route: route.id,
            destination: route.headsign,
            minutes: null,
            delayed: false,
            seats: "unknown",
            error: String(err.message || err),
          };
        }
      })
    );
    board.sort((a, b) => a.minutes - b.minutes);
    res.status(200).json({
      stop: STOP,
      updated: new Date().toISOString(),
      source: "SEPTA TransitView (live vehicle positions)",
      method: "straight-line distance x " + GRID_FACTOR + " grid factor / " + BUS_SPEED_MS + " m/s",
      arrivals: results,
      board: board.slice(0, 6),
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
