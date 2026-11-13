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
  "https://routing.openstreetmap.de/routed-foot/route/v1/driving";
const MAX_WALK_STRAIGHT_LINE_METERS = 2_000;
const MAX_STOPS_PER_SIDE = 4;
const MAX_ROUTE_RESULTS = 8;
const MAX_SEARCH_HORIZON_MS = 18 * 60 * 60 * 1_000;
const MINIMUM_TRANSFER_SECONDS = 5 * 60;
const MAX_FIRST_LEGS_TO_EXPLORE = 180;

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
  ride: RideSegment;
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

type OsrmResponse = {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: {
      coordinates?: Array<[number, number]>;
    };
  }>;
};

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
    .slice(0, MAX_STOPS_PER_SIDE);
}

async function walkingPath(
  from: GeoPoint,
  to: GeoPoint,
): Promise<WalkingPath | undefined> {
  const straightLineMeters = haversineMeters(from, to);
  if (straightLineMeters < 5) {
    return {
      distanceMeters: Math.round(straightLineMeters),
      durationSeconds: 0,
      geometry: [from, to],
    };
  }

  const url = `${WALKING_ROUTER}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson&steps=false`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: {
      accept: "application/json",
      "user-agent": "VAI Mobilidade/1.0 (pedestrian routing from OSM data)",
    },
  });
  if (!response.ok) {
    throw new Error(`O roteador de caminhada respondeu HTTP ${response.status}.`);
  }

  const body = (await response.json()) as OsrmResponse;
  const route = body.routes?.[0];
  if (body.code === "NoRoute" || !route) return undefined;
  if (
    body.code !== "Ok" ||
    !Number.isFinite(route.distance) ||
    !Number.isFinite(route.duration) ||
    !Array.isArray(route.geometry?.coordinates)
  ) {
    throw new Error("O roteador de caminhada retornou uma resposta inválida.");
  }

  const geometry = route.geometry.coordinates.flatMap(([longitude, latitude]) =>
    Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [{ latitude, longitude }]
      : [],
  );
  if (geometry.length === 0) return undefined;

  return {
    distanceMeters: Math.max(0, Math.round(route.distance ?? 0)),
    durationSeconds: Math.max(0, route.duration ?? 0),
    geometry,
  };
}

async function walkingPathsForStops(
  point: GeoPoint,
  stops: GtfsStop[],
): Promise<Map<string, WalkingPath>> {
  const pairs = stops.map((stop) => ({ stop, point: stop.coordinates }));
  const paths = new Map<string, WalkingPath>();
  let nextIndex = 0;
  let errorCount = 0;
  const workers = Array.from(
    { length: Math.min(4, pairs.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        const pair = pairs[index];
        if (!pair) return;
        try {
          const path = await walkingPath(point, pair.point);
          if (path) paths.set(pair.stop.id, path);
        } catch {
          errorCount += 1;
        }
      }
    },
  );
  await Promise.all(workers);

  if (paths.size === 0 && errorCount > 0) {
    throw new Error("O serviço público de cálculo de caminhada está indisponível.");
  }
  return paths;
}

function shapeSegment(
  feed: GtfsFeed,
  shapeId: string,
  from: GeoPoint,
  to: GeoPoint,
): GeoPoint[] {
  const shape = feed.shapes.get(shapeId);
  if (!shape || shape.length < 2) return [];

  const nearestIndex = (point: GeoPoint) => {
    let result = -1;
    let minimumDistance = Number.POSITIVE_INFINITY;
    shape.forEach((candidate, index) => {
      const distance = haversineMeters(point, candidate);
      if (distance < minimumDistance) {
        minimumDistance = distance;
        result = index;
      }
    });
    return { index: result, distance: minimumDistance };
  };

  const fromMatch = nearestIndex(from);
  const toMatch = nearestIndex(to);
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
  return fromMatch.index <= toMatch.index ? segment : segment.reverse();
}

function scheduledTrips(
  feed: GtfsFeed,
  days: ServiceDay[],
  requestEpoch: number,
): ScheduledTrip[] {
  const maximumEpoch = requestEpoch + MAX_SEARCH_HORIZON_MS;
  const result: ScheduledTrip[] = [];
  for (const day of days) {
    for (const [tripId, times] of feed.stopTimesByTrip) {
      const trip = feed.trips.get(tripId);
      const route = trip && feed.routes.get(trip.routeId);
      if (!trip || !route || !day.serviceIds.has(trip.serviceId)) continue;
      if (
        !times.some((stopTime) => {
          const departureEpoch =
            day.midnightEpoch + stopTime.departureSeconds * 1_000;
          return departureEpoch >= requestEpoch && departureEpoch <= maximumEpoch;
        })
      ) {
        // A previous service day may still have an after-midnight trip.
        if (
          !times.some(
            (stopTime) =>
              day.midnightEpoch + stopTime.departureSeconds * 1_000 >=
              requestEpoch,
          )
        ) {
          continue;
        }
      }
      result.push({ trip, route, times, midnightEpoch: day.midnightEpoch });
    }
  }
  return result;
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
  if (arrivalEpoch <= requestEpoch) return undefined;

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
  feed: GtfsFeed,
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
      const destinationIndex = destinationIndexes.find(
        (candidateIndex) => candidateIndex > fromIndex,
      );
      if (destinationIndex === undefined) continue;
      const ride = buildRideSegment(
        feed,
        schedule,
        fromIndex,
        destinationIndex,
      );
      if (!ride || ride.departureEpoch > maximumEpoch) continue;
      const choices = index.get(fromTime.stopId) ?? [];
      choices.push({ ride });
      index.set(fromTime.stopId, choices);
    }
  }

  for (const choices of index.values()) {
    choices.sort((left, right) => left.ride.departureEpoch - right.ride.departureEpoch);
  }
  return index;
}

function findNextTransferRide(
  choices: SecondRide[],
  firstRide: RideSegment,
  maximumEpoch: number,
): RideSegment | undefined {
  const earliestBoarding =
    firstRide.arrivalEpoch + MINIMUM_TRANSFER_SECONDS * 1_000;
  for (const choice of choices) {
    if (choice.ride.departureEpoch > maximumEpoch) break;
    if (choice.ride.departureEpoch < earliestBoarding) continue;
    if (choice.ride.schedule.route.id === firstRide.schedule.route.id) continue;
    return choice.ride;
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

export async function searchTransitRoutes(
  request: TransitRouteSearchInput,
): Promise<TransitRouteSearchResponse> {
  const requestedAt = request.departureAt ?? new Date();
  const requestEpoch = requestedAt.getTime();
  const feed = await getArtespGtfsFeed();
  const originPoint = request.origin.coordinates;
  const destinationPoint = request.destination.coordinates;
  const nearbyOriginStops = nearestStops(feed, originPoint);
  const nearbyDestinationStops = nearestStops(feed, destinationPoint);

  if (nearbyOriginStops.length === 0 || nearbyDestinationStops.length === 0) {
    return makeResponse(
      "no_routes",
      "Não encontramos paradas do GTFS metropolitano a até 2 km de cada ponto. As linhas municipais de Barueri ainda não têm feed integrado.",
      requestedAt,
      feed,
      [],
    );
  }

  const serviceDays = serviceDaysFor(feed, requestedAt);
  if (serviceDays.length === 0) {
    return makeResponse(
      "no_routes",
      "O calendário oficial não informa viagens para essa data. A publicação atual não inclui exceções de feriados.",
      requestedAt,
      feed,
      [],
    );
  }

  let originWalks: Map<string, WalkingPath>;
  let destinationWalks: Map<string, WalkingPath>;
  try {
    [originWalks, destinationWalks] = await Promise.all([
      walkingPathsForStops(
        originPoint,
        nearbyOriginStops.map((candidate) => candidate.stop),
      ),
      walkingPathsForStops(
        destinationPoint,
        nearbyDestinationStops.map((candidate) => candidate.stop),
      ),
    ]);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "Não foi possível calcular os trechos a pé pelo OpenStreetMap.",
    );
  }

  const originStopIds = new Set(originWalks.keys());
  const destinationStopIds = new Set(destinationWalks.keys());
  if (originStopIds.size === 0 || destinationStopIds.size === 0) {
    return makeResponse(
      "no_routes",
      "O roteador OpenStreetMap não encontrou caminho a pé entre um dos endereços e as paradas próximas.",
      requestedAt,
      feed,
      [],
    );
  }

  const schedules = scheduledTrips(feed, serviceDays, requestEpoch);
  const maximumEpoch = requestEpoch + MAX_SEARCH_HORIZON_MS;
  const candidates = new Map<string, Candidate>();

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
        const ride = buildRideSegment(feed, schedule, fromIndex, toIndex);
        if (!ride || ride.arrivalEpoch <= departureEpoch) continue;
        addCandidate(
          candidates,
          buildCandidate([ride], firstWalk, lastWalk, requestEpoch),
        );
      }
    }
  }

  const secondRideIndex = buildSecondRideIndex(
    schedules,
    destinationStopIds,
    feed,
    maximumEpoch,
  );
  const boardings = activeTripsAtStops(schedules, originStopIds)
    .filter((boarding) => {
      const stop = boarding.schedule.times[boarding.index];
      const path = stop && originWalks.get(stop.stopId);
      return (
        path !== undefined &&
        boarding.departureEpoch >= requestEpoch + path.durationSeconds * 1_000 &&
        boarding.departureEpoch <= maximumEpoch
      );
    })
    .slice(0, MAX_FIRST_LEGS_TO_EXPLORE);

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

  return makeResponse(
    routes.length > 0 ? "routes_found" : "no_routes",
    routes.length > 0
      ? "Alternativas calculadas com viagens do GTFS da ARTESP e caminhos a pé do OpenStreetMap."
      : "Nenhuma viagem futura foi encontrada para esses pontos no calendário atual. As linhas municipais de Barueri não fazem parte do feed conectado.",
    requestedAt,
    feed,
    routes,
  );
}
