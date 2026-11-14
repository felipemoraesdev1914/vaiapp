import { mkdir, readFile, writeFile } from "node:fs/promises";

const INPUT = "artifacts/api-server/src/data/barueri-cittamobi-lines-source.json";
const OUTPUT = "artifacts/api-server/src/data/barueri-cittamobi-geocoded-stops.json";
const CENTER = { lat: -23.5113, lon: -46.8765 };
const REQUEST_LIMIT = Number(process.env.GEOCODE_LIMIT ?? 0);
const INTERVAL_MS = 1_050;

const source = JSON.parse(await readFile(INPUT, "utf8"));
const normalize = (value = "") =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function haversineKm(left, right) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(right.lat - left.lat);
  const dLon = rad(right.lon - left.lon);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(left.lat)) * Math.cos(rad(right.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function houseNumber(address) {
  const first = address.split(",")[0] ?? "";
  const match = first.match(/\b(\d+[A-Za-z]?)\s*$/i);
  return match ? match[1].toLowerCase() : null;
}

function addressStreet(address) {
  const first = address.split(",")[0] ?? "";
  return normalize(first
    .replace(/^(rua|r\.?|avenida|av\.?|estrada|est\.?|alameda|rodovia)\s*/i, "")
    .replace(/\s+\d+[A-Za-z]?\s*$/i, ""));
}

function selectCandidate(address, features) {
  const expectedStreet = addressStreet(address);
  const expectedNumber = houseNumber(address);
  const ranked = features.map((feature) => {
    const properties = feature.properties ?? {};
    const coordinates = feature.geometry?.coordinates ?? [];
    const point = { lat: Number(coordinates[1]), lon: Number(coordinates[0]) };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      return { properties, point, score: -Infinity, confidence: "none" };
    }

    const candidateStreet = normalize(properties.street ?? properties.name ?? "");
    const candidateNumber = String(properties.housenumber ?? "").toLowerCase();
    const streetMatches = expectedStreet.length >= 5 &&
      (candidateStreet.includes(expectedStreet) || expectedStreet.includes(candidateStreet));
    const numberMatches = Boolean(expectedNumber && candidateNumber === expectedNumber);
    const city = normalize([
      properties.city, properties.district, properties.locality, properties.county,
    ].filter(Boolean).join(" "));
    const cityMatches = city.includes("barueri") ||
      /jandira|santana de parnaiba|itapevi/.test(city);
    const distanceFromCenterKm = haversineKm(point, CENTER);
    const photonScore = Number(properties.score ?? 0);
    const score = photonScore +
      (streetMatches ? 2 : 0) +
      (numberMatches ? 2 : 0) +
      (cityMatches ? 0.5 : 0) -
      Math.max(0, distanceFromCenterKm - 5) * 0.12;

    let confidence = "low";
    if (streetMatches && numberMatches && cityMatches && distanceFromCenterKm <= 12) {
      confidence = "high";
    } else if (streetMatches && cityMatches && distanceFromCenterKm <= 12) {
      confidence = "medium";
    }
    return {
      properties, point, score, confidence, streetMatches, numberMatches,
      cityMatches, distanceFromCenterKm: Math.round(distanceFromCenterKm * 100) / 100,
    };
  }).sort((left, right) => right.score - left.score);

  const best = ranked[0];
  return {
    selected: best && (best.confidence === "high" || best.confidence === "medium") ? {
      latitude: best.point.lat,
      longitude: best.point.lon,
      confidence: best.confidence,
      precision: best.confidence === "high" ? "house-number-match" : "street-center-approximation",
      source: "Photon / OpenStreetMap geocoder",
      label: best.properties.name ?? best.properties.street ?? null,
      city: best.properties.city ?? best.properties.district ?? best.properties.locality ?? null,
      street: best.properties.street ?? best.properties.name ?? null,
      houseNumber: best.properties.housenumber ?? null,
      distanceFromBarueriCenterKm: best.distanceFromCenterKm,
    } : null,
    candidates: ranked.slice(0, 3).map((candidate) => ({
      label: candidate.properties.name ?? candidate.properties.street ?? null,
      street: candidate.properties.street ?? null,
      houseNumber: candidate.properties.housenumber ?? null,
      city: candidate.properties.city ?? candidate.properties.district ?? candidate.properties.locality ?? null,
      latitude: candidate.point.lat,
      longitude: candidate.point.lon,
      osmType: candidate.properties.osm_type ?? null,
      osmValue: candidate.properties.osm_value ?? null,
      photonScore: candidate.properties.score ?? null,
      matchConfidence: candidate.confidence,
      distanceFromBarueriCenterKm: candidate.distanceFromCenterKm ?? null,
    })),
  };
}

const routeEntries = (source.lines ?? []).map((route) => {
  const seenStopIds = new Set();
  const stops = (route.stops ?? []).filter((stop) => {
    if (!stop.id || seenStopIds.has(stop.id)) return false;
    seenStopIds.add(stop.id);
    return Boolean((stop.address ?? "").trim());
  }).map((stop) => ({
    id: stop.id,
    sequence: stop.sequence,
    address: stop.address.trim(),
    mapImage: stop.mapImage ?? null,
    departureTimes: stop.departureTimes ?? [],
  }));

  return {
    routeId: route.url.split("/linha/")[1] ?? route.lineCode,
    sourceUrl: route.url,
    lineCode: route.lineCode,
    operator: route.operator,
    directionLabel: route.title.replace(/^Linha\s+/i, "").replace(/:\s*horários[\s\S]*$/i, ""),
    agencyId: route.agencyId,
    serviceId: route.serviceId,
    observedScheduleDate: route.observedScheduleDate,
    departureTimeListAtOrigin: route.departureTimeListAtOrigin ?? [],
    scheduleByDay: route.scheduleByDay ?? [],
    stopCount: stops.length,
    stops,
  };
});

const addressByKey = new Map();
for (const route of routeEntries) {
  for (const stop of route.stops) {
    const key = normalize(stop.address);
    if (key && !addressByKey.has(key)) addressByKey.set(key, stop.address);
  }
}
const allAddresses = [...addressByKey.entries()];
const addresses = REQUEST_LIMIT > 0 ? allAddresses.slice(0, REQUEST_LIMIT) : allAddresses;
const results = {};
let lastRequestAt = 0;

for (let index = 0; index < addresses.length; index += 1) {
  const [key, address] = addresses[index];
  const waitMs = Math.max(0, INTERVAL_MS - (Date.now() - lastRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));

  let query = address;
  if (!/barueri|jandira|itapevi|santana de parnaiba/i.test(address)) {
    query += ", Barueri, São Paulo, Brasil";
  } else if (!/brasil|brazil/i.test(address)) {
    query += ", Brasil";
  }

  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("lat", String(CENTER.lat));
  url.searchParams.set("lon", String(CENTER.lon));
  url.searchParams.set("zoom", "13");
  url.searchParams.set("limit", "5");

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "VAI-Mobilidade/1.0 (Barueri municipal bus stop mapping)",
        "accept": "application/geo+json, application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    lastRequestAt = Date.now();
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + (await response.text()).slice(0, 200));
    const json = await response.json();
    results[key] = {
      query,
      ...selectCandidate(address, json.features ?? []),
      featureCount: (json.features ?? []).length,
    };
  } catch (error) {
    results[key] = {
      query,
      selected: null,
      candidates: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if ((index + 1) % 25 === 0 || index + 1 === addresses.length) {
    console.log("Geocoded " + (index + 1) + "/" + addresses.length);
  }
}

for (const route of routeEntries) {
  for (const stop of route.stops) {
    const match = results[normalize(stop.address)];
    stop.coordinates = match?.selected ?? null;
    stop.geocodingCandidates = match?.candidates ?? [];
  }
}

const matchedKeys = new Set(routeEntries.flatMap((route) =>
  route.stops.filter((stop) => stop.coordinates).map((stop) => normalize(stop.address))
));
const highKeys = new Set(routeEntries.flatMap((route) =>
  route.stops.filter((stop) => stop.coordinates?.confidence === "high").map((stop) => normalize(stop.address))
));
const output = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  source: "Cittamobi public municipal route pages",
  coordinateSource: "Photon / OpenStreetMap geocoder",
  coordinateNote: "High confidence requires a matching street, house number and city. Medium confidence is an approximate street-level coordinate, not an exact bus-stop pole location. Low-confidence and unmatched candidates are not used as stop coordinates.",
  scheduleNote: "Per-stop times are copied from the route page's line-departures-v1 snapshot (observedScheduleDate). Weekly operating windows and average headways are stored separately. Snapshot times must not be assumed to apply to every day of the week.",
  totalMunicipalDirections: routeEntries.length,
  totalStopRecords: routeEntries.reduce((sum, route) => sum + route.stops.length, 0),
  uniqueAddressesAvailable: allAddresses.length,
  uniqueAddressesGeocoded: addresses.length,
  uniqueAddressesMatched: matchedKeys.size,
  uniqueHighConfidenceMatches: highKeys.size,
  uniqueStreetApproximationMatches: matchedKeys.size - highKeys.size,
  totalDirectionsWithWeeklySchedule: routeEntries.filter((route) => route.scheduleByDay.length === 7).length,
  routes: routeEntries,
  addressResults: results,
};
await mkdir("artifacts/api-server/src/data", { recursive: true });
await writeFile(OUTPUT, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  directions: routeEntries.length,
  stopRecords: output.totalStopRecords,
  uniqueAddresses: allAddresses.length,
  queried: addresses.length,
  matched: matchedKeys.size,
  highConfidence: highKeys.size,
  streetApproximation: matchedKeys.size - highKeys.size,
  errors: Object.values(results).filter((entry) => entry.error).length,
  unmatchedExamples: Object.entries(results).filter((entry) => !entry[1].selected).slice(0, 8).map((entry) => entry[0]),
}));
