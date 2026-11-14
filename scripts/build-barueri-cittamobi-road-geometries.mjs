import { mkdir, readFile, writeFile } from "node:fs/promises";

const INPUT = "artifacts/api-server/src/data/barueri-cittamobi-geocoded-stops.json";
const OUTPUT = "artifacts/api-server/src/data/barueri-cittamobi-road-geometries.json";
const INTERVAL_MS = 1_100;
const endpoints = [
  "https://routing.openstreetmap.de/routed-car/route/v1/driving/",
  "https://router.project-osrm.org/route/v1/driving/",
];

const network = JSON.parse(await readFile(INPUT, "utf8"));
const routes = network.routes ?? [];
const result = {};
let lastRequestAt = 0;

const haversineMeters = (left, right) => {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(right.latitude - left.latitude);
  const dLon = rad(right.longitude - left.longitude);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(left.latitude)) * Math.cos(rad(right.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

async function fetchRoadRoute(points) {
  const coordinates = points.map((point) => point.longitude + "," + point.latitude).join(";");
  const errors = [];
  for (const endpoint of endpoints) {
    const url = endpoint + coordinates +
      "?overview=full&geometries=geojson&steps=false&generate_hints=false";
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "VAI-Mobilidade/1.0 (public transit stop-to-stop geometry)",
          "accept": "application/json",
        },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error("HTTP " + response.status + ": " + (await response.text()).slice(0, 180));
      const body = await response.json();
      const route = body.routes?.[0];
      const rawCoordinates = route?.geometry?.coordinates;
      const waypoints = body.waypoints;
      if (body.code !== "Ok" || !Array.isArray(rawCoordinates) || rawCoordinates.length < 2 ||
          !Array.isArray(waypoints) || waypoints.length !== points.length) {
        throw new Error("The road router returned incomplete geometry or waypoint indexes");
      }
      const shape = rawCoordinates.flatMap((pair) => {
        const longitude = Number(pair?.[0]);
        const latitude = Number(pair?.[1]);
        return Number.isFinite(latitude) && Number.isFinite(longitude)
          ? [{ latitude, longitude }]
          : [];
      });
      const stopPathIndexes = waypoints.map((waypoint) => Number(waypoint.waypoint_index));
      if (shape.length < 2 || stopPathIndexes.some((index) =>
        !Number.isInteger(index) || index < 0 || index >= shape.length
      )) {
        throw new Error("The road router returned invalid stop-to-shape indexes");
      }
      return {
        status: "road-network-route",
        endpoint,
        distanceMeters: Math.round(Number(route.distance) || 0),
        durationSeconds: Math.round(Number(route.duration) || 0),
        shape,
        stopPathIndexes,
      };
    } catch (error) {
      errors.push(endpoint + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return { status: "fallback-stop-connection", errors };
}

for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
  const route = routes[routeIndex];
  const locatedStops = (route.stops ?? []).filter((stop) =>
    stop.coordinates &&
    Number.isFinite(stop.coordinates.latitude) &&
    Number.isFinite(stop.coordinates.longitude)
  );

  if (locatedStops.length < 2) {
    result[route.routeId] = {
      status: "insufficient-geocoded-stops",
      locatedStopCount: locatedStops.length,
      shape: locatedStops.map((stop) => stop.coordinates),
      stopPathIndexes: locatedStops.map((_, index) => index),
    };
    continue;
  }

  const uniquePoints = [];
  const originalToUnique = [];
  for (const stop of locatedStops) {
    const point = {
      latitude: stop.coordinates.latitude,
      longitude: stop.coordinates.longitude,
    };
    const previous = uniquePoints.at(-1);
    if (previous && haversineMeters(previous, point) < 15) {
      originalToUnique.push(uniquePoints.length - 1);
    } else {
      uniquePoints.push(point);
      originalToUnique.push(uniquePoints.length - 1);
    }
  }

  if (uniquePoints.length < 2) {
    result[route.routeId] = {
      status: "insufficient-distinct-coordinates",
      locatedStopCount: locatedStops.length,
      shape: uniquePoints,
      stopPathIndexes: originalToUnique,
    };
    continue;
  }

  const waitMs = Math.max(0, INTERVAL_MS - (Date.now() - lastRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const fetched = await fetchRoadRoute(uniquePoints);
  lastRequestAt = Date.now();

  if (fetched.status === "road-network-route") {
    result[route.routeId] = {
      ...fetched,
      locatedStopCount: locatedStops.length,
      uniqueWaypointCount: uniquePoints.length,
      stopPathIndexes: originalToUnique.map((uniqueIndex) => fetched.stopPathIndexes[uniqueIndex]),
    };
  } else {
    result[route.routeId] = {
      ...fetched,
      locatedStopCount: locatedStops.length,
      uniqueWaypointCount: uniquePoints.length,
      shape: uniquePoints,
      stopPathIndexes: originalToUnique,
    };
  }

  if ((routeIndex + 1) % 10 === 0 || routeIndex + 1 === routes.length) {
    console.log("Built road geometry " + (routeIndex + 1) + "/" + routes.length);
  }
}

const values = Object.values(result);
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "OpenStreetMap road routing through geocoded Cittamobi stops",
  note: "These are road-network paths connecting published stop locations, not operator-supplied bus traces. Medium-confidence stop coordinates are street-level approximations.",
  directionCount: routes.length,
  roadNetworkDirections: values.filter((route) => route.status === "road-network-route").length,
  fallbackDirections: values.filter((route) => route.status === "fallback-stop-connection").length,
  directionsWithInsufficientStops: values.filter((route) => route.status.startsWith("insufficient")).length,
  geometries: result,
};
await mkdir("artifacts/api-server/src/data", { recursive: true });
await writeFile(OUTPUT, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  directions: output.directionCount,
  routed: output.roadNetworkDirections,
  fallback: output.fallbackDirections,
  insufficient: output.directionsWithInsufficientStops,
}));
