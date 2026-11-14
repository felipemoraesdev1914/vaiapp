import { mkdir, readFile, writeFile } from "node:fs/promises";

const INPUT = "artifacts/api-server/src/data/barueri-cittamobi-geocoded-lines.json";
const OUTPUT = "artifacts/api-server/src/data/barueri-cittamobi-geocoded-stops.json";
const CENTER = { lat: -23.5113, lon: -46.8765 };
const SAMPLE_LIMIT = Number(process.env.GEOCODE_LIMIT ?? 40);
const INTERVAL_MS = 1_050;

const source = JSON.parse(await readFile(INPUT, "utf8"));
const normalize = (value = "") =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function stopAddress(stop) {
  const label = stop.attributes?.["aria-label"] ?? "";
  const fromLabel = label.replace(/^Ver mapa da parada\s*/i, "").trim();
  if (fromLabel) return fromLabel;

  const text = stop.text ?? "";
  const afterSvg = text.replace(/^[\s\S]*?>\s*/, "");
  const beforeRealtime = afterSvg.split(/\s+Tempo Real\s+/i)[0] ?? "";
  return beforeRealtime.replace(/\s+/g, " ").trim();
}

function haversineKm(left, right) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(right.lat - left.lat);
  const dLon = rad(right.lon - left.lon);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(left.lat)) * Math.cos(rad(right.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function houseNumber(address) {
  return address.match(/,\s*(\d+[A-Za-z]?)(?:\s|$|[-,/])/i)?.[1]?.toLowerCase() ?? null;
}

function addressStreet(address) {
  const first = address.split(",")[0] ?? "";
  return normalize(first.replace(/^(rua|r\.?|avenida|av\.?|estrada|est\.?|alameda|rodovia)\s*/i, ""));
}

function selectCandidate(address, features) {
  const expectedStreet = addressStreet(address);
  const expectedNumber = houseNumber(address);
  const ranked = features.map((feature) => {
    const properties = feature.properties ?? {};
    const point = {
      lat: Number(feature.geometry?.coordinates?.[1]),
      lon: Number(feature.geometry?.coordinates?.[0]),
    };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      return { feature, properties, point, score: -Infinity, confidence: "none" };
    }

    const candidateStreet = normalize(properties.street ?? properties.name ?? "");
    const candidateNumber = String(properties.housenumber ?? "").toLowerCase();
    const streetMatches = expectedStreet.length >= 5 &&
      (candidateStreet.includes(expectedStreet) || expectedStreet.includes(candidateStreet));
    const numberMatches = Boolean(expectedNumber && candidateNumber === expectedNumber);
    const city = normalize([properties.city, properties.district, properties.locality].filter(Boolean).join(" "));
    const cityMatches = city.includes("barueri") ||
      /jandira|santana de parnaiba|itapevi/.test(city);
    const distanceFromCenterKm = haversineKm(point, CENTER);
    const photonScore = Number(properties.score ?? 0);
    const score = photonScore +
      (streetMatches ? 1.5 : 0) +
      (numberMatches ? 1.0 : 0) +
      (cityMatches ? 0.45 : 0) -
      Math.max(0, distanceFromCenterKm - 5) * 0.12;

    let confidence = "low";
    if (streetMatches && numberMatches && cityMatches && distanceFromCenterKm <= 12) {
      confidence = "high";
    } else if (streetMatches && cityMatches && distanceFromCenterKm <= 12) {
      confidence = "medium";
    }
    return {
      feature,
      properties,
      point,
      score,
      confidence,
      streetMatches,
      numberMatches,
      cityMatches,
      distanceFromCenterKm: Math.round(distanceFromCenterKm * 100) / 100,
    };
  }).sort((left, right) => right.score - left.score);

  const best = ranked[0];
  return {
    selected: best && best.confidence !== "low" ? {
      latitude: best.point.lat,
      longitude: best.point.lon,
      confidence: best.confidence,
      source: "Photon / OpenStreetMap geocoder",
      label: best.properties.name ?? best.properties.street ?? null,
      city: best.properties.city ?? best.properties.district ?? null,
      street: best.properties.street ?? null,
      houseNumber: best.properties.housenumber ?? null,
      distanceFromBarueriCenterKm: best.distanceFromCenterKm,
    } : null,
    candidates: ranked.slice(0, 5).map((candidate) => ({
      label: candidate.properties.name ?? candidate.properties.street ?? null,
      street: candidate.properties.street ?? null,
      houseNumber: candidate.properties.housenumber ?? null,
      city: candidate.properties.city ?? candidate.properties.district ?? null,
      latitude: candidate.point.lat,
      longitude: candidate.point.lon,
      photonScore: candidate.properties.score ?? null,
      matchConfidence: candidate.confidence,
      distanceFromBarueriCenterKm: candidate.distanceFromCenterKm ?? null,
    })),
  };
}

const routeEntries = (source.routes ?? []).map((route, routeIndex) => {
  const slug = route.url.split("/linha/")[1] ?? "";
  const match = slug.match(/(?:Benfica|Ralip)Municipal-.*?-([A-Z0-9]+)-/i);
  const lineCode = match?.[1]?.toUpperCase() ?? "UNKNOWN";
  const titleMatch = route.title.match(/^Linha\s+(.+?):\s*horários/i);
  const directionLabel = titleMatch?.[1] ?? route.title;

  const stops = (route.stopsFromHtml ?? []).map((stop) => ({
    id: stop.id,
    sequence: stop.sequence,
    address: stopAddress(stop),
    departureTimes: route.departuresByStopIndex?.[String(stop.sequence - 1)] ?? [],
  }));
  return {
    routeId: slug.replace(/-[a-f0-9]{8,}$/i, ""),
    sourceUrl: route.url,
    lineCode,
    directionLabel,
    serviceId: route.serviceId,
    agencyId: route.agencyId,
    stopCount: stops.length,
    stops,
  };
});

const addressByKey = new Map();
for (const route of routeEntries) {
  for (const stop of route.stops) {
    if (!stop.address) continue;
    const key = normalize(stop.address);
    if (key && !addressByKey.has(key)) addressByKey.set(key, stop.address);
  }
}
const addresses = [...addressByKey.entries()].slice(0, SAMPLE_LIMIT);
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
        "user-agent": "VAI-Mobilidade/1.0 (Barueri bus stop mapping)",
        "accept": "application/geo+json, application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    lastRequestAt = Date.now();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
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
  if ((index + 1) % 10 === 0 || index + 1 === addresses.length) {
    console.log(`Geocoded ${index + 1}/${addresses.length}`);
  }
}

for (const route of routeEntries) {
  for (const stop of route.stops) {
    const match = results[normalize(stop.address)];
    stop.coordinates = match?.selected ?? null;
    stop.geocodingCandidates = match?.candidates ?? [];
  }
}

const accepted = [...new Set(routeEntries.flatMap(route =>
  route.stops.filter(stop => stop.coordinates).map(stop => normalize(stop.address))
))];
const acceptedHigh = [...new Set(routeEntries.flatMap(route =>
  route.stops.filter(stop => stop.coordinates?.confidence === "high").map(stop => normalize(stop.address))
))];
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "Cittamobi public route pages",
  scheduleNote: "Departure arrays are copied by stop position from line-departures-v1. Their weekday applicability must be checked before treating them as a permanent weekly calendar.",
  geocoder: "Photon / OpenStreetMap",
  geocodingScope: "Sample only; set GEOCODE_LIMIT to all addresses after inspecting quality.",
  totalMunicipalDirections: routeEntries.length,
  totalStopRecords: routeEntries.reduce((sum, route) => sum + route.stops.length, 0),
  uniqueAddressesAvailable: addressByKey.size,
  uniqueAddressesGeocoded: addresses.length,
  uniqueAddressesMatched: accepted.length,
  uniqueHighConfidenceMatches: acceptedHigh.length,
  routes: routeEntries,
  addressResults: results,
};
await mkdir("artifacts/api-server/src/data", { recursive: true });
await writeFile(OUTPUT, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  sample: addresses.length,
  totalUniqueAddresses: addressByKey.size,
  matched: accepted.length,
  highConfidence: acceptedHigh.length,
  errors: Object.values(results).filter((entry) => entry.error).length,
  sampleMatches: Object.entries(results).slice(0, 6).map(([address, result]) => ({
    address,
    selected: result.selected,
    firstCandidates: result.candidates?.slice(0, 2),
    error: result.error,
  })),
}));
