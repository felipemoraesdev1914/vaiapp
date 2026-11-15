import { performance } from "node:perf_hooks";
import type {
  TransitRouteLeg,
  TransitRouteOption,
  TransitRouteSearchInput,
  TransitRouteSearchResponse,
} from "@workspace/api-zod";
import {
  getArtespGtfsFeed,
  type GeoPoint,
  type GtfsFeed,
  type GtfsRoute,
  type GtfsStop,
  type GtfsStopTime,
  type GtfsTrip,
} from "./artespGtfsSource";

const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";
const WALKING_ROUTER =
  "https://routing.openstreetmap.de/routed-foot/table/v1/driving";
const MAX_WALK_STRAIGHT_LINE_METERS = 2_000;
// Evaluate a wider set because the geographically closest stop is not always
// the easiest one to reach on foot (barriers, highways and disconnected streets).
const MAX_STOPS_TO_EVALUATE_PER_SIDE = 4;
const MAX_STOPS_PER_SIDE = 3;
const MAX_ACCESS_WALK_METERS = 1_000;
const WALKING_CACHE_TTL_MS = 15 * 60 * 1_000;
const MAX_WALKING_CACHE_ENTRIES = 4_000;
const MAX_ROUTE_RESULTS = 8;
const MAX_SEARCH_HORIZON_MS = 18 * 60 * 60 * 1_000;
const MAX_INITIAL_WAIT_SECONDS = 60 * 60;
const MAX_TRANSFER_WAIT_SECONDS = 45 * 60;
const MAX_ITINERARY_DURATION_SECONDS = 3 * 60 * 60;
const MINIMUM_TRANSFER_SECONDS = 5 * 60;
const WALKING_ROUTER_TIMEOUT_MS = 4_000;
const ROUTE_RESULT_CACHE_TTL_MS = 30_000;
const ROUTE_RESULT_CACHE_MAX_ENTRIES = 256;

type WalkingPath = {
  distanceMeters: number;
  durationSeconds: number;
  geometry: GeoPoint[];
};

type ServiceDay = {
  key: string;
  midnightEpoch: number;
  serviceIds: Set<string>;
};

type ScheduledTrip = {
  trip: GtfsTrip;
  route: GtfsRoute;
  times: GtfsStopTime[];
  midnightEpoch: number;
};

type RideSegment = {
  schedule: ScheduledTrip;
  fromIndex: number;
  toIndex: number;
  departureEpoch: number;
  arrivalEpoch: number;
  fromStop: GtfsStop;
  toStop: GtfsStop;
  geometry: GeoPoint[];
};

type SecondRide = {
  schedule: ScheduledTrip;
  fromIndex: number;
  toIndex: number;
  departureEpoch: number;
};

type Candidate = {
  rides: RideSegment[];
  firstWalk: WalkingPath;
  lastWalk: WalkingPath;
  firstStop: GtfsStop;
  lastStop: GtfsStop;
  departureEpoch: number;
  arrivalEpoch: number;
  transferStopId?: string;
  totalMinutes: number;
  walkingMinutes: number;
  transitMinutes: number;
  transferCount: number;
};

type CachedWalkingPath = {
  expiresAt: number;
  promise: Promise<WalkingPath | undefined>;
};

type OsrmTableResponse = {
  code?: string;
  distances?: Array<Array<number | null>>;
  durations?: Array<Array<number | null>>;
};

type RouteSearchTiming = (
  stage: string,
  durationMs: number,
  details?: Record<string, number | string | boolean>,
) => void;

type CachedRouteResponse = {
  expiresAt: number;
  response: TransitRouteSearchResponse;
  candidateCount: number;
};

type ShapePoint = { index: number; point: GeoPoint };
type ShapeSpatialIndex = { cells: Map<string, ShapePoint[]> };
type ShapeMatch = { index: number; distance: number };

const walkingPathCache = new Map<string, CachedWalkingPath>();
const routeResponseCache = new Map<string, CachedRouteResponse>();
const scheduledTripCache = new Map<string, ScheduledTrip[]>();
const shapeSpatialIndexes = new WeakMap<GtfsFeed, Map<string, ShapeSpatialIndex>>();
const shapeMatchCache = new WeakMap<GtfsFeed, Map<string, ShapeMatch>>();
const shapeSegmentCache = new WeakMap<GtfsFeed, Map<string, GeoPoint[]>>();

// The public FOSSGIS routing service asks clients to stay at or below
// one request per second. One batched Table request replaces up to eight
// serial route requests for a journey.
const WALKING_ROUTER_MIN_INTERVAL_MS = 1_100;
let nextWalkingRouterRequestAt = 0;
let walkingRouterQueue: Promise<void> = Promise.resolve();

function fetchWalkingTableRateLimited(
  url: string,
  signal?: AbortSignal,
): Promise<OsrmTableResponse> {
  const request = walkingRouterQueue.then(async () => {
    const waitMs = Math.max(0, nextWalkingRouterRequestAt - Date.now());
    if (waitMs > 0) {
      await waitForDelay(waitMs, signal);
    }
    throwIfAborted(signal);
    nextWalkingRouterRequestAt = Date.now() + WALKING_ROUTER_MIN_INTERVAL_MS;
    const timeoutSignal = AbortSignal.timeout(WALKING_ROUTER_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(url, {
      signal: requestSignal,
      headers: {
        accept: "application/json",
        "user-agent": "VAI Mobilidade/1.0 (pedestrian routing from OSM data)",
      },
    });
    if (!response.ok) {
      throw new Error(`O roteador de caminhada respondeu HTTP ${response.status}.`);
    }
    const body = (await response.json()) as OsrmTableResponse;
    if (
      body.code !== "Ok" ||
      !Array.isArray(body.distances) ||
      !Array.isArray(body.durations)
    ) {
      throw new Error("O roteador de caminhada retornou uma matriz inválida.");
    }
    return body;
  });
  walkingRouterQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("A busca foi cancelada.", "AbortError");
  }
}

function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("A busca foi cancelada.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("A busca foi cancelada.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function haversineMeters(left: GeoPoint, right: GeoPoint): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SAO_PAULO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateKeyOffset(key: string, offset: number): string {
  const day = new Date(`${key}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

function weekdayKey(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
  })
    .format(new Date(`${dateKey}T12:00:00Z`))
    .toLowerCase();
}

function gtfsDate(dateKey: string): string {
  return dateKey.replaceAll("-", "");
}

function serviceDaysFor(feed: GtfsFeed, requestedAt: Date): ServiceDay[] {
  const today = localDateKey(requestedAt);
  return [-1, 0, 1].flatMap((offset) => {
    const key = dateKeyOffset(today, offset);
    const day = weekdayKey(key);
    const encodedDate = gtfsDate(key);
    const serviceIds = new Set<string>();
    for (const service of feed.calendar.values()) {
      if (
        service.startDate <= encodedDate &&
        service.endDate >= encodedDate &&
        service.weekdays[day]
      ) {
        serviceIds.add(service.serviceId);
      }
    }
    if (serviceIds.size === 0) return [];

    // São Paulo uses UTC−03:00 in the feed's current coverage period.
    return [
      {
        key,
        midnightEpoch: Date.parse(`${key}T00:00:00-03:00`),
        serviceIds,
      },
    ];
  });
}

function nearestStops(
  feed: GtfsFeed,
  point: GeoPoint,
): Array<{ stop: GtfsStop; straightLineMeters: number }> {
  return [...feed.stops.values()]
    .map((stop) => ({
      stop,
      straightLineMeters: haversineMeters(point, stop.coordinates),
    }))
    .filter(
      (candidate) =>
        candidate.straightLineMeters <= MAX_WALK_STRAIGHT_LINE_METERS,
    )
    .sort((left, right) => left.straightLineMeters - right.straightLineMeters)
    .slice(0, MAX_STOPS_TO_EVALUATE_PER_SIDE);
}

function coordinateKey(point: GeoPoint): string {
  return `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
}

function walkingCacheKey(from: GeoPoint, to: GeoPoint): string {
  return `${coordinateKey(from)}>${coordinateKey(to)}`;
}

function getCachedWalkingPath(key: string): Promise<WalkingPath | undefined> | undefined {
  const cached = walkingPathCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    walkingPathCache.delete(key);
    return undefined;
  }
  walkingPathCache.delete(key);
  walkingPathCache.set(key, cached);
  return cached.promise;
}

function cacheWalkingPath(key: string, path: WalkingPath | undefined): void {
  walkingPathCache.delete(key);
  walkingPathCache.set(key, {
    expiresAt: Date.now() + WALKING_CACHE_TTL_MS,
    promise: Promise.resolve(path),
  });
  while (walkingPathCache.size > MAX_WALKING_CACHE_ENTRIES) {
    const oldestKey = walkingPathCache.keys().next().value;
    if (!oldestKey) break;
    walkingPathCache.delete(oldestKey);
  }
}

type WalkingPair = {
  side: "origin" | "destination";
  stop: GtfsStop;
  from: GeoPoint;
  to: GeoPoint;
  key: string;
};

function tableCoordinate(point: GeoPoint): string {
  return `${point.longitude},${point.latitude}`;
}

async function walkingPathsForStops(
  origin: GeoPoint,
  destination: GeoPoint,
  originStops: GtfsStop[],
  destinationStops: GtfsStop[],
  signal?: AbortSignal,
): Promise<{
  origin: Map<string, WalkingPath>;
  destination: Map<string, WalkingPath>;
  pairCount: number;
  cacheHits: number;
  externalPairs: number;
  externalRequests: number;
}> {
  const pairs: WalkingPair[] = [
    ...originStops.map((stop) => ({
      side: "origin" as const,
      stop,
      from: origin,
      to: stop.coordinates,
      key: walkingCacheKey(origin, stop.coordinates),
    })),
    ...destinationStops.map((stop) => ({
      side: "destination" as const,
      stop,
      from: stop.coordinates,
      to: destination,
      key: walkingCacheKey(stop.coordinates, destination),
    })),
  ];
  const cached = new Map<string, WalkingPath | undefined>();
  const missing = new Map<string, WalkingPair>();
  for (const pair of pairs) {
    if (haversineMeters(pair.from, pair.to) < 5) {
      cached.set(pair.key, {
        distanceMeters: Math.round(haversineMeters(pair.from, pair.to)),
        durationSeconds: 0,
        geometry: [],
      });
      continue;
    }
    const cachedPromise = getCachedWalkingPath(pair.key);
    if (cachedPromise) {
      cached.set(pair.key, await waitForAbort(cachedPromise, signal));
    } else {
      missing.set(pair.key, pair);
    }
  }

  let externalRequests = 0;
  if (missing.size > 0) {
    externalRequests = 1;
    const uniqueCoordinates = new Map<string, GeoPoint>();
    for (const pair of missing.values()) {
      uniqueCoordinates.set(coordinateKey(pair.from), pair.from);
      uniqueCoordinates.set(coordinateKey(pair.to), pair.to);
    }
    const coordinates = [...uniqueCoordinates.values()];
    const coordinateIndexes = new Map(
      coordinates.map((point, index) => [coordinateKey(point), index]),
    );
    const sourceIndexes = [
      ...new Set(
        [...missing.values()].map((pair) => coordinateIndexes.get(coordinateKey(pair.from))!),
      ),
    ];
    const destinationIndexes = [
      ...new Set(
        [...missing.values()].map((pair) => coordinateIndexes.get(coordinateKey(pair.to))!),
      ),
    ];
    const url = `${WALKING_ROUTER}/${coordinates.map(tableCoordinate).join(";")}?annotations=duration,distance&sources=${sourceIndexes.join(";")}&destinations=${destinationIndexes.join(";")}`;
    const table = await waitForAbort(
      fetchWalkingTableRateLimited(url, signal),
      signal,
    );
    for (const [key, pair] of missing) {
      const rowIndex = sourceIndexes.indexOf(
        coordinateIndexes.get(coordinateKey(pair.from))!,
      );
      const columnIndex = destinationIndexes.indexOf(
        coordinateIndexes.get(coordinateKey(pair.to))!,
      );
      const distance = table.distances?.[rowIndex]?.[columnIndex];
      const duration = table.durations?.[rowIndex]?.[columnIndex];
      const path =
        typeof distance === "number" &&
        Number.isFinite(distance) &&
        typeof duration === "number" &&
        Number.isFinite(duration)
          ? {
              distanceMeters: Math.max(0, Math.round(distance)),
              durationSeconds: Math.max(0, duration),
              // The Table endpoint provides network distance and duration but
              // no geometry; leaving it empty avoids drawing a fabricated line.
              geometry: [],
            }
          : undefined;
      cached.set(key, path);
      cacheWalkingPath(key, path);
    }
  }

  const originPaths = new Map<string, WalkingPath>();
  const destinationPaths = new Map<string, WalkingPath>();
  for (const pair of pairs) {
    const path = cached.get(pair.key);
    if (!path || path.distanceMeters > MAX_ACCESS_WALK_METERS) continue;
    const collection = pair.side === "origin" ? originPaths : destinationPaths;
    const current = collection.get(pair.stop.id);
    if (!current || path.distanceMeters < current.distanceMeters) {
      collection.set(pair.stop.id, path);
    }
  }

  const keepClosest = (paths: Map<string, WalkingPath>) =>
    new Map(
      [...paths.entries()]
        .sort((left, right) => left[1].distanceMeters - right[1].distanceMeters)
        .slice(0, MAX_STOPS_PER_SIDE),
    );
  return {
    origin: keepClosest(originPaths),
    destination: keepClosest(destinationPaths),
    pairCount: pairs.length,
    cacheHits: pairs.length - missing.size,
    externalPairs: missing.size,
    externalRequests,
  };
}

const SHAPE_GRID_DEGREES = 0.005;
const SHAPE_GRID_SEARCH_RADIUS = 3;

function shapeGridKey(latitudeCell: number, longitudeCell: number): string {
  return `${latitudeCell}:${longitudeCell}`;
}

function shapeSpatialIndex(
  feed: GtfsFeed,
  shapeId: string,
  shape: GeoPoint[],
): ShapeSpatialIndex {
  let feedIndexes = shapeSpatialIndexes.get(feed);
  if (!feedIndexes) {
    feedIndexes = new Map();
    shapeSpatialIndexes.set(feed, feedIndexes);
  }
  const existing = feedIndexes.get(shapeId);
  if (existing) return existing;

  const cells = new Map<string, ShapePoint[]>();
  shape.forEach((point, index) => {
    const key = shapeGridKey(
      Math.floor(point.latitude / SHAPE_GRID_DEGREES),
      Math.floor(point.longitude / SHAPE_GRID_DEGREES),
    );
    const points = cells.get(key) ?? [];
    points.push({ index, point });
    cells.set(key, points);
  });
  const index = { cells };
  feedIndexes.set(shapeId, index);
  return index;
}

function nearestShapePoint(
  feed: GtfsFeed,
  shapeId: string,
  shape: GeoPoint[],
  point: GeoPoint,
): ShapeMatch {
  let feedMatches = shapeMatchCache.get(feed);
  if (!feedMatches) {
    feedMatches = new Map();
    shapeMatchCache.set(feed, feedMatches);
  }
  const key = `${shapeId}:${coordinateKey(point)}`;
  const cached = feedMatches.get(key);
  if (cached) return cached;

  const index = shapeSpatialIndex(feed, shapeId, shape);
  const latitudeCell = Math.floor(point.latitude / SHAPE_GRID_DEGREES);
  const longitudeCell = Math.floor(point.longitude / SHAPE_GRID_DEGREES);
  let nearest: ShapeMatch = { index: -1, distance: Number.POSITIVE_INFINITY };
  for (
    let latitudeOffset = -SHAPE_GRID_SEARCH_RADIUS;
    latitudeOffset <= SHAPE_GRID_SEARCH_RADIUS;
    latitudeOffset += 1
  ) {
    for (
      let longitudeOffset = -SHAPE_GRID_SEARCH_RADIUS;
      longitudeOffset <= SHAPE_GRID_SEARCH_RADIUS;
      longitudeOffset += 1
    ) {
      const points = index.cells.get(
        shapeGridKey(latitudeCell + latitudeOffset, longitudeCell + longitudeOffset),
      );
      if (!points) continue;
      for (const candidate of points) {
        const distance = haversineMeters(point, candidate.point);
        if (distance < nearest.distance) {
          nearest = { index: candidate.index, distance };
        }
      }
    }
  }
  feedMatches.set(key, nearest);
  while (feedMatches.size > 30_000) {
    const oldestKey = feedMatches.keys().next().value;
    if (!oldestKey) break;
    feedMatches.delete(oldestKey);
  }
  return nearest;
}

function shapeSegment(
  feed: GtfsFeed,
  shapeId: string,
  from: GeoPoint,
  to: GeoPoint,
): GeoPoint[] {
  const shape = feed.shapes.get(shapeId);
  if (!shape || shape.length < 2) return [];
  const key = `${shapeId}:${coordinateKey(from)}>${coordinateKey(to)}`;
  let feedSegments = shapeSegmentCache.get(feed);
  if (!feedSegments) {
    feedSegments = new Map();
    shapeSegmentCache.set(feed, feedSegments);
  }
  const cached = feedSegments.get(key);
  if (cached) return cached;

  const fromMatch = nearestShapePoint(feed, shapeId, shape, from);
  const toMatch = nearestShapePoint(feed, shapeId, shape, to);
  if (
    fromMatch.index < 0 ||
    toMatch.index < 0 ||
    fromMatch.distance > 1_000 ||
    toMatch.distance > 1_000 ||
    fromMatch.index === toMatch.index
  ) {
    return [];
  }

  const start = Math.min(fromMatch.index, toMatch.index);
  const end = Math.max(fromMatch.index, toMatch.index);
  const segment = shape.slice(start, end + 1);
  const result = fromMatch.index <= toMatch.index ? segment : segment.reverse();
  feedSegments.set(key, result);
  while (feedSegments.size > 12_000) {
    const oldestKey = feedSegments.keys().next().value;
    if (!oldestKey) break;
    feedSegments.delete(oldestKey);
  }
  return result;
}

function scheduledTrips(
  feed: GtfsFeed,
  days: ServiceDay[],
  requestEpoch: number,
): ScheduledTrip[] {
  const maximumEpoch = requestEpoch + MAX_SEARCH_HORIZON_MS;
  const cacheKey = `${feed.source.version}|${days
    .map((day) => `${day.key}:${[...day.serviceIds].sort().join("+")}`)
    .join(";")}`;
  let datedSchedules = scheduledTripCache.get(cacheKey);
  if (!datedSchedules) {
    datedSchedules = [];
    for (const day of days) {
      for (const [tripId, times] of feed.stopTimesByTrip) {
        const trip = feed.trips.get(tripId);
        const route = trip && feed.routes.get(trip.routeId);
        if (!trip || !route || !day.serviceIds.has(trip.serviceId)) continue;
        datedSchedules.push({ trip, route, times, midnightEpoch: day.midnightEpoch });
      }
    }
    scheduledTripCache.set(cacheKey, datedSchedules);
    while (scheduledTripCache.size > 16) {
      const oldestKey = scheduledTripCache.keys().next().value;
      if (!oldestKey) break;
      scheduledTripCache.delete(oldestKey);
    }
  }

  return datedSchedules.filter((schedule) => {
    const firstTime = schedule.times[0];
    const lastTime = schedule.times.at(-1);
    if (!firstTime || !lastTime) return false;
    const firstDeparture =
      schedule.midnightEpoch + firstTime.departureSeconds * 1_000;
    const lastDeparture =
      schedule.midnightEpoch + lastTime.departureSeconds * 1_000;
    // GTFS stop_times are sequence-sorted and validated during feed load.
    return lastDeparture >= requestEpoch && firstDeparture <= maximumEpoch;
  });
}

function buildRideSegment(
  feed: GtfsFeed,
  schedule: ScheduledTrip,
  fromIndex: number,
  toIndex: number,
): RideSegment | undefined {
  const fromTime = schedule.times[fromIndex];
  const toTime = schedule.times[toIndex];
  const fromStop = fromTime && feed.stops.get(fromTime.stopId);
  const toStop = toTime && feed.stops.get(toTime.stopId);
  if (!fromTime || !toTime || !fromStop || !toStop) return undefined;

  const geometry = shapeSegment(
    feed,
    schedule.trip.shapeId,
    fromStop.coordinates,
    toStop.coordinates,
  );
  if (geometry.length < 2) return undefined;

  return {
    schedule,
    fromIndex,
    toIndex,
    departureEpoch:
      schedule.midnightEpoch + fromTime.departureSeconds * 1_000,
    arrivalEpoch: schedule.midnightEpoch + toTime.arrivalSeconds * 1_000,
    fromStop,
    toStop,
    geometry,
  };
}

function minutesFromSeconds(seconds: number): number {
  return Math.max(0, Math.ceil(seconds / 60));
}

function buildCandidate(
  rides: RideSegment[],
  firstWalk: WalkingPath,
  lastWalk: WalkingPath,
  requestEpoch: number,
  transferStopId?: string,
): Candidate | undefined {
  const firstRide = rides[0];
  const lastRide = rides.at(-1);
  if (!firstRide || !lastRide) return undefined;
  const walkingSeconds =
    firstWalk.durationSeconds + lastWalk.durationSeconds;
  const arrivalEpoch =
    lastRide.arrivalEpoch + lastWalk.durationSeconds * 1_000;
  const initialWaitSeconds =
    (firstRide.departureEpoch - requestEpoch) / 1_000;
  const totalDurationSeconds = (arrivalEpoch - requestEpoch) / 1_000;
  // Do not present trips that require waiting hours for the first bus or
  // spending most of the journey parked at a transfer stop.
  if (
    arrivalEpoch <= requestEpoch ||
    initialWaitSeconds < 0 ||
    initialWaitSeconds > MAX_INITIAL_WAIT_SECONDS ||
    totalDurationSeconds > MAX_ITINERARY_DURATION_SECONDS
  ) {
    return undefined;
  }

  return {
    rides,
    firstWalk,
    lastWalk,
    firstStop: firstRide.fromStop,
    lastStop: lastRide.toStop,
    departureEpoch: firstRide.departureEpoch,
    arrivalEpoch,
    transferStopId,
    totalMinutes: minutesFromSeconds((arrivalEpoch - requestEpoch) / 1_000),
    walkingMinutes: minutesFromSeconds(walkingSeconds),
    transitMinutes: rides.reduce(
      (sum, ride) =>
        sum +
        minutesFromSeconds((ride.arrivalEpoch - ride.departureEpoch) / 1_000),
      0,
    ),
    transferCount: rides.length - 1,
  };
}

function dateTimeAt(epoch: number): Date {
  return new Date(epoch);
}

function rideLeg(ride: RideSegment): TransitRouteLeg {
  const { route } = ride.schedule;
  return {
    mode: "bus",
    from: {
      label: ride.fromStop.name,
      coordinates: ride.fromStop.coordinates,
    },
    to: {
      label: ride.toStop.name,
      coordinates: ride.toStop.coordinates,
    },
    durationMinutes: minutesFromSeconds(
      (ride.arrivalEpoch - ride.departureEpoch) / 1_000,
    ),
    distanceMeters: Math.round(
      ride.geometry.slice(1).reduce(
        (distance, point, index) =>
          distance + haversineMeters(ride.geometry[index]!, point),
        0,
      ),
    ),
    geometry: ride.geometry,
    lineCode: route.shortName,
    lineName: route.longName,
    headsign: ride.schedule.trip.headsign || route.longName,
    departureAt: dateTimeAt(ride.departureEpoch),
    arrivalAt: dateTimeAt(ride.arrivalEpoch),
    boardingStop: ride.fromStop,
    alightingStop: ride.toStop,
  };
}

function walkingLeg(
  from: { label: string; coordinates: GeoPoint },
  to: { label: string; coordinates: GeoPoint },
  path: WalkingPath,
  departureEpoch: number,
): TransitRouteLeg {
  return {
    mode: "walk",
    from,
    to,
    durationMinutes: minutesFromSeconds(path.durationSeconds),
    distanceMeters: path.distanceMeters,
    geometry: path.geometry,
    lineCode: null,
    lineName: null,
    headsign: null,
    departureAt: dateTimeAt(departureEpoch),
    arrivalAt: dateTimeAt(departureEpoch + path.durationSeconds * 1_000),
    boardingStop: null,
    alightingStop: null,
  };
}

function candidateToOption(
  candidate: Candidate,
  request: TransitRouteSearchInput,
  requestEpoch: number,
): TransitRouteOption {
  const firstRide = candidate.rides[0]!;
  const lastRide = candidate.rides.at(-1)!;
  const lineCodes = [
    ...new Set(candidate.rides.map((ride) => ride.schedule.route.shortName)),
  ];
  const longNames = [
    ...new Set(candidate.rides.map((ride) => ride.schedule.route.longName)),
  ];
  const routeLabel = lineCodes.join(" + ");
  const legs: TransitRouteLeg[] = [
    walkingLeg(
      {
        label: request.origin.label,
        coordinates: request.origin.coordinates,
      },
      {
        label: candidate.firstStop.name,
        coordinates: candidate.firstStop.coordinates,
      },
      candidate.firstWalk,
      requestEpoch,
    ),
    ...candidate.rides.map(rideLeg),
    walkingLeg(
      {
        label: candidate.lastStop.name,
        coordinates: candidate.lastStop.coordinates,
      },
      {
        label: request.destination.label,
        coordinates: request.destination.coordinates,
      },
      candidate.lastWalk,
      lastRide.arrivalEpoch,
    ),
  ];

  return {
    recommended: false,
    id: [
      candidate.rides.map((ride) => ride.schedule.trip.id).join("-"),
      candidate.firstStop.id,
      candidate.lastStop.id,
      candidate.transferStopId ?? "direct",
    ].join(":"),
    lineCodes,
    label: `${routeLabel} · ${longNames.join(" / ")}`,
    departureAt: dateTimeAt(firstRide.departureEpoch),
    arrivalAt: dateTimeAt(candidate.arrivalEpoch),
    totalMinutes: candidate.totalMinutes,
    walkingMinutes: candidate.walkingMinutes,
    transitMinutes: candidate.transitMinutes,
    transferCount: candidate.transferCount,
    boardingStop: candidate.firstStop,
    alightingStop: candidate.lastStop,
    legs,
  };
}

function candidateKey(candidate: Candidate): string {
  return [
    candidate.rides.map((ride) => ride.schedule.route.id).join("+"),
    candidate.firstStop.id,
    candidate.lastStop.id,
    candidate.transferStopId ?? "direct",
  ].join("|");
}

function recommendationScore(candidate: Candidate): number {
  return (
    candidate.totalMinutes +
    candidate.walkingMinutes * 0.25 +
    candidate.transferCount * 7
  );
}

function activeTripsAtStops(
  schedules: ScheduledTrip[],
  stopIds: Set<string>,
): Array<{ schedule: ScheduledTrip; index: number; departureEpoch: number }> {
  const boardings: Array<{
    schedule: ScheduledTrip;
    index: number;
    departureEpoch: number;
  }> = [];

  for (const schedule of schedules) {
    schedule.times.forEach((time, index) => {
      if (!stopIds.has(time.stopId)) return;
      boardings.push({
        schedule,
        index,
        departureEpoch:
          schedule.midnightEpoch + time.departureSeconds * 1_000,
      });
    });
  }
  return boardings.sort(
    (left, right) => left.departureEpoch - right.departureEpoch,
  );
}

function buildSecondRideIndex(
  schedules: ScheduledTrip[],
  destinationStopIds: Set<string>,
  maximumEpoch: number,
): Map<string, SecondRide[]> {
  const index = new Map<string, SecondRide[]>();
  for (const schedule of schedules) {
    const destinationIndexes = schedule.times.flatMap((time, position) =>
      destinationStopIds.has(time.stopId) ? [position] : [],
    );
    if (destinationIndexes.length === 0) continue;

    for (let fromIndex = 0; fromIndex < schedule.times.length - 1; fromIndex += 1) {
      const fromTime = schedule.times[fromIndex]!;
      const departureEpoch =
        schedule.midnightEpoch + fromTime.departureSeconds * 1_000;
      if (departureEpoch > maximumEpoch) continue;
      for (const destinationIndex of destinationIndexes) {
        if (destinationIndex <= fromIndex) continue;
        const destinationTime = schedule.times[destinationIndex]!;
        const arrivalEpoch =
          schedule.midnightEpoch + destinationTime.arrivalSeconds * 1_000;
        if (arrivalEpoch <= departureEpoch) continue;
        const choices = index.get(fromTime.stopId) ?? [];
        choices.push({ schedule, fromIndex, toIndex: destinationIndex, departureEpoch });
        index.set(fromTime.stopId, choices);
      }
    }
  }

  for (const choices of index.values()) {
    choices.sort((left, right) => left.departureEpoch - right.departureEpoch);
  }
  return index;
}

function findNextTransferRide(
  choices: SecondRide[],
  firstRide: RideSegment,
  maximumEpoch: number,
  feed: GtfsFeed,
): RideSegment | undefined {
  const earliestBoarding =
    firstRide.arrivalEpoch + MINIMUM_TRANSFER_SECONDS * 1_000;
  let lower = 0;
  let upper = choices.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (choices[middle]!.departureEpoch < earliestBoarding) lower = middle + 1;
    else upper = middle;
  }
  for (let index = lower; index < choices.length; index += 1) {
    const choice = choices[index]!;
    if (choice.departureEpoch > maximumEpoch) break;
    const waitSeconds =
      (choice.departureEpoch - firstRide.arrivalEpoch) / 1_000;
    if (waitSeconds > MAX_TRANSFER_WAIT_SECONDS) break;
    if (choice.schedule.route.id === firstRide.schedule.route.id) continue;
    const ride = buildRideSegment(feed, choice.schedule, choice.fromIndex, choice.toIndex);
    if (ride) return ride;
  }
  return undefined;
}

function addCandidate(
  candidates: Map<string, Candidate>,
  candidate: Candidate | undefined,
): void {
  if (!candidate) return;
  const key = candidateKey(candidate);
  const current = candidates.get(key);
  if (!current || recommendationScore(candidate) < recommendationScore(current)) {
    candidates.set(key, candidate);
  }
}

function makeResponse(
  status: TransitRouteSearchResponse["status"],
  message: string,
  requestedAt: Date,
  feed: GtfsFeed,
  routes: TransitRouteOption[],
): TransitRouteSearchResponse {
  return {
    status,
    message,
    requestedAt,
    source: {
      ...feed.source,
      updatedAt: new Date(feed.source.updatedAt),
    },
    routes,
  };
}

function routeResponseCacheKey(
  request: TransitRouteSearchInput,
  requestedAt: Date,
  feed: GtfsFeed,
): string {
  return [
    feed.source.version,
    Math.floor(requestedAt.getTime() / 60_000),
    coordinateKey(request.origin.coordinates),
    coordinateKey(request.destination.coordinates),
  ].join("|");
}

function cachedResponseForRequest(
  cached: CachedRouteResponse,
  request: TransitRouteSearchInput,
  requestedAt: Date,
): TransitRouteSearchResponse | undefined {
  const requestEpoch = requestedAt.getTime();
  const routes = cached.response.routes.flatMap((route) => {
    const legs = route.legs.map((leg) => ({
      ...leg,
      from: { ...leg.from, coordinates: { ...leg.from.coordinates } },
      to: { ...leg.to, coordinates: { ...leg.to.coordinates } },
      geometry: [...leg.geometry],
    }));
    const firstWalk = legs[0];
    const lastWalk = legs.at(-1);
    if (
      !firstWalk?.departureAt ||
      !firstWalk.arrivalAt ||
      !lastWalk ||
      !route.departureAt ||
      !route.arrivalAt
    ) {
      return [];
    }
    const firstWalkSeconds =
      (firstWalk.arrivalAt.getTime() - firstWalk.departureAt.getTime()) / 1_000;
    const departureEpoch = route.departureAt.getTime();
    const arrivalEpoch = route.arrivalAt.getTime();
    const initialWaitSeconds =
      (departureEpoch - requestEpoch) / 1_000 - firstWalkSeconds;
    const totalDurationSeconds = (arrivalEpoch - requestEpoch) / 1_000;
    if (
      initialWaitSeconds < 0 ||
      initialWaitSeconds > MAX_INITIAL_WAIT_SECONDS ||
      totalDurationSeconds <= 0 ||
      totalDurationSeconds > MAX_ITINERARY_DURATION_SECONDS
    ) {
      return [];
    }
    firstWalk.from = {
      label: request.origin.label,
      coordinates: { ...request.origin.coordinates },
    };
    firstWalk.departureAt = requestedAt;
    firstWalk.arrivalAt = new Date(requestEpoch + firstWalkSeconds * 1_000);
    lastWalk.to = {
      label: request.destination.label,
      coordinates: { ...request.destination.coordinates },
    };
    return [{
      ...route,
      totalMinutes: minutesFromSeconds(totalDurationSeconds),
      legs,
    }];
  });
  if (routes.length === 0) return undefined;
  routes.sort((left, right) => {
    const scoreDifference =
      left.totalMinutes + left.walkingMinutes * 0.25 + left.transferCount * 7 -
      (right.totalMinutes + right.walkingMinutes * 0.25 + right.transferCount * 7);
    return scoreDifference || left.totalMinutes - right.totalMinutes;
  });
  routes.forEach((route, index) => {
    route.recommended = index === 0;
  });
  return {
    ...cached.response,
    requestedAt,
    status: "routes_found",
    routes,
  };
}

function rememberRouteResponse(
  key: string,
  response: TransitRouteSearchResponse,
  candidateCount: number,
): void {
  routeResponseCache.delete(key);
  routeResponseCache.set(key, {
    expiresAt: Date.now() + ROUTE_RESULT_CACHE_TTL_MS,
    response,
    candidateCount,
  });
  while (routeResponseCache.size > ROUTE_RESULT_CACHE_MAX_ENTRIES) {
    const oldestKey = routeResponseCache.keys().next().value;
    if (!oldestKey) break;
    routeResponseCache.delete(oldestKey);
  }
}

export async function searchTransitRoutes(
  request: TransitRouteSearchInput,
  options: { signal?: AbortSignal; onTiming?: RouteSearchTiming } = {},
): Promise<TransitRouteSearchResponse> {
  const totalStartedAt = performance.now();
  const reportTiming = options.onTiming ?? (() => undefined);
  const signal = options.signal;
  const timed = (
    stage: string,
    startedAt: number,
    details?: Record<string, number | string | boolean>,
  ) => reportTiming(stage, Math.round(performance.now() - startedAt), details);
  const requestedAt = request.departureAt ?? new Date();
  const requestEpoch = requestedAt.getTime();
  const feedStartedAt = performance.now();
  const feed = await waitForAbort(getArtespGtfsFeed(), signal);
  timed("gtfs_feed", feedStartedAt, {
    version: feed.source.version,
    stops: feed.stops.size,
    trips: feed.trips.size,
  });
  throwIfAborted(signal);

  const cacheKey = routeResponseCacheKey(request, requestedAt, feed);
  const cachedRouteResponse = routeResponseCache.get(cacheKey);
  if (cachedRouteResponse && cachedRouteResponse.expiresAt > Date.now()) {
    routeResponseCache.delete(cacheKey);
    routeResponseCache.set(cacheKey, cachedRouteResponse);
    const cachedResponse = cachedResponseForRequest(
      cachedRouteResponse,
      request,
      requestedAt,
    );
    if (cachedResponse) {
      reportTiming("route_cache_hit", 0, {
        candidateCount: cachedRouteResponse.candidateCount,
      });
      reportTiming("total", Math.round(performance.now() - totalStartedAt), {
        cached: true,
        routes: cachedResponse.routes.length,
      });
      return cachedResponse;
    }
  } else if (cachedRouteResponse) {
    routeResponseCache.delete(cacheKey);
  }

  const originPoint = request.origin.coordinates;
  const destinationPoint = request.destination.coordinates;
  const stopsStartedAt = performance.now();
  const nearbyOriginStops = nearestStops(feed, originPoint);
  const nearbyDestinationStops = nearestStops(feed, destinationPoint);
  timed("nearby_stops", stopsStartedAt, {
    originCandidates: nearbyOriginStops.length,
    destinationCandidates: nearbyDestinationStops.length,
  });

  if (nearbyOriginStops.length === 0 || nearbyDestinationStops.length === 0) {
    const response = makeResponse(
      "no_routes",
      "Não encontramos paradas do GTFS metropolitano próximas dos dois endereços. As linhas municipais de Barueri ainda não têm feed integrado.",
      requestedAt,
      feed,
      [],
    );
    rememberRouteResponse(cacheKey, response, 0);
    reportTiming("total", Math.round(performance.now() - totalStartedAt), {
      cached: false,
      routes: 0,
    });
    return response;
  }

  const calendarStartedAt = performance.now();
  const serviceDays = serviceDaysFor(feed, requestedAt);
  timed("service_calendar", calendarStartedAt, { activeDays: serviceDays.length });
  if (serviceDays.length === 0) {
    const response = makeResponse(
      "no_routes",
      "O calendário oficial não informa viagens para essa data. A publicação atual não inclui exceções de feriados.",
      requestedAt,
      feed,
      [],
    );
    rememberRouteResponse(cacheKey, response, 0);
    reportTiming("total", Math.round(performance.now() - totalStartedAt), {
      cached: false,
      routes: 0,
    });
    return response;
  }

  const walkingStartedAt = performance.now();
  const walkingPromise = walkingPathsForStops(
    originPoint,
    destinationPoint,
    nearbyOriginStops.map((candidate) => candidate.stop),
    nearbyDestinationStops.map((candidate) => candidate.stop),
    signal,
  );
  const schedulesStartedAt = performance.now();
  const schedules = scheduledTrips(
    feed,
    serviceDays,
    requestEpoch,
  );
  timed("scheduled_trips", schedulesStartedAt, { tripCount: schedules.length });
  const walking = await waitForAbort(walkingPromise, signal);
  const originWalks = walking.origin;
  const destinationWalks = walking.destination;
  timed("walking_network", walkingStartedAt, {
    candidatePairs: walking.pairCount,
    cacheHits: walking.cacheHits,
    externalPairs: walking.externalPairs,
    externalRequests: walking.externalRequests,
    originStops: originWalks.size,
    destinationStops: destinationWalks.size,
  });

  const originStopIds = new Set(originWalks.keys());
  const destinationStopIds = new Set(destinationWalks.keys());
  if (originStopIds.size === 0 || destinationStopIds.size === 0) {
    const response = makeResponse(
      "no_routes",
      "Não encontramos pontos de ônibus atendidos pelo GTFS a até 1 km de caminhada da origem e do destino. As linhas municipais de Barueri ainda não têm feed integrado.",
      requestedAt,
      feed,
      [],
    );
    rememberRouteResponse(cacheKey, response, 0);
    reportTiming("total", Math.round(performance.now() - totalStartedAt), {
      cached: false,
      routes: 0,
    });
    return response;
  }

  throwIfAborted(signal);
  const maximumEpoch = requestEpoch + MAX_SEARCH_HORIZON_MS;
  const candidates = new Map<string, Candidate>();

  const directStartedAt = performance.now();
  let directRidePairsChecked = 0;
  for (const schedule of schedules) {
    for (let fromIndex = 0; fromIndex < schedule.times.length - 1; fromIndex += 1) {
      const originTime = schedule.times[fromIndex]!;
      if (!originStopIds.has(originTime.stopId)) continue;
      const firstStop = feed.stops.get(originTime.stopId);
      const firstWalk = originWalks.get(originTime.stopId);
      if (!firstStop || !firstWalk) continue;
      const departureEpoch =
        schedule.midnightEpoch + originTime.departureSeconds * 1_000;
      if (
        departureEpoch <
          requestEpoch + firstWalk.durationSeconds * 1_000 ||
        departureEpoch > maximumEpoch
      ) {
        continue;
      }

      for (
        let toIndex = fromIndex + 1;
        toIndex < schedule.times.length;
        toIndex += 1
      ) {
        const destinationTime = schedule.times[toIndex]!;
        if (!destinationStopIds.has(destinationTime.stopId)) continue;
        const lastWalk = destinationWalks.get(destinationTime.stopId);
        if (!lastWalk) continue;
        directRidePairsChecked += 1;
        const ride = buildRideSegment(feed, schedule, fromIndex, toIndex);
        if (!ride || ride.arrivalEpoch <= departureEpoch) continue;
        addCandidate(
          candidates,
          buildCandidate([ride], firstWalk, lastWalk, requestEpoch),
        );
      }
    }
  }
  timed("direct_routes", directStartedAt, {
    ridePairsChecked: directRidePairsChecked,
    candidates: candidates.size,
  });

  const transferIndexStartedAt = performance.now();
  const secondRideIndex = buildSecondRideIndex(
    schedules,
    destinationStopIds,
    maximumEpoch,
  );
  timed("transfer_index", transferIndexStartedAt, {
    transferStops: secondRideIndex.size,
  });

  const boardings = activeTripsAtStops(schedules, originStopIds)
    .filter((boarding) => {
      const stop = boarding.schedule.times[boarding.index];
      const path = stop && originWalks.get(stop.stopId);
      return (
        path !== undefined &&
        boarding.departureEpoch >= requestEpoch + path.durationSeconds * 1_000 &&
        boarding.departureEpoch <= maximumEpoch
      );
    });
  const transferStartedAt = performance.now();
  let transferChoicesChecked = 0;

  for (const boarding of boardings) {
    const firstTime = boarding.schedule.times[boarding.index]!;
    const firstStop = feed.stops.get(firstTime.stopId);
    const firstWalk = originWalks.get(firstTime.stopId);
    if (!firstStop || !firstWalk) continue;

    for (
      let transferIndex = boarding.index + 1;
      transferIndex < boarding.schedule.times.length - 1;
      transferIndex += 1
    ) {
      const transferTime = boarding.schedule.times[transferIndex]!;
      if (destinationStopIds.has(transferTime.stopId)) continue;
      const transferStop = feed.stops.get(transferTime.stopId);
      const secondChoices = secondRideIndex.get(transferTime.stopId);
      if (!transferStop || !secondChoices?.length) continue;
      transferChoicesChecked += 1;

      const firstRide = buildRideSegment(
        feed,
        boarding.schedule,
        boarding.index,
        transferIndex,
      );
      if (!firstRide) continue;
      const secondRide = findNextTransferRide(
        secondChoices,
        firstRide,
        maximumEpoch,
        feed,
      );
      if (!secondRide) continue;
      const lastWalk = destinationWalks.get(secondRide.toStop.id);
      if (!lastWalk) continue;

      addCandidate(
        candidates,
        buildCandidate(
          [firstRide, secondRide],
          firstWalk,
          lastWalk,
          requestEpoch,
          transferStop.id,
        ),
      );
    }
  }
  timed("transfer_routes", transferStartedAt, {
    originBoardings: boardings.length,
    transferChoicesChecked,
    candidates: candidates.size,
  });

  const orderedCandidates = [...candidates.values()].sort((left, right) => {
    const scoreDifference =
      recommendationScore(left) - recommendationScore(right);
    if (scoreDifference !== 0) return scoreDifference;
    return left.totalMinutes - right.totalMinutes;
  });
  const selectedCandidates = orderedCandidates.slice(0, MAX_ROUTE_RESULTS);
  const routes = selectedCandidates.map((candidate) =>
    candidateToOption(candidate, request, requestEpoch),
  );
  if (routes[0]) routes[0].recommended = true;

  const response = makeResponse(
    routes.length > 0 ? "routes_found" : "no_routes",
    routes.length > 0
      ? "Alternativas calculadas com viagens do GTFS da ARTESP e caminhos a pé do OpenStreetMap."
      : "Nenhuma viagem futura foi encontrada para esses pontos no calendário atual. As linhas municipais de Barueri não fazem parte do feed conectado.",
    requestedAt,
    feed,
    routes,
  );
  const waitBoundaryRisk = boardings.some((boarding) => {
    const time = boarding.schedule.times[boarding.index];
    const path = time && originWalks.get(time.stopId);
    if (!path) return false;
    const waitSeconds =
      (boarding.departureEpoch - requestEpoch) / 1_000 - path.durationSeconds;
    return Math.abs(waitSeconds - MAX_INITIAL_WAIT_SECONDS) <= 120;
  });
  const cacheSafe =
    routes.length > 0 &&
    candidates.size <= MAX_ROUTE_RESULTS &&
    !waitBoundaryRisk &&
    routes.every((route) => route.totalMinutes <= 150);
  if (cacheSafe) rememberRouteResponse(cacheKey, response, candidates.size);
  reportTiming("total", Math.round(performance.now() - totalStartedAt), {
    cached: false,
    routes: routes.length,
    candidates: candidates.size,
  });
  return response;
}
