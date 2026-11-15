import { Router, type IRouter } from "express";
import { getArtespGtfsFeed, type GtfsFeed, type GtfsStop, type GtfsTrip, type GtfsStopTime } from "../lib/artespGtfsSource";

const router: IRouter = Router();
const TIME_ZONE = "America/Sao_Paulo";
const MAX_BOUNDS_SPAN = 0.3;
const ARRIVAL_WINDOW_MS = 2 * 60 * 60 * 1_000;
const ARRIVAL_LIMIT = 8;

type StopTimeRecord = { trip: GtfsTrip; time: GtfsStopTime };
const stopTimeIndex = new WeakMap<GtfsFeed, Map<string, StopTimeRecord[]>>();

function indexStopTimes(feed: GtfsFeed): Map<string, StopTimeRecord[]> {
  const cached = stopTimeIndex.get(feed);
  if (cached) return cached;
  const index = new Map<string, StopTimeRecord[]>();
  for (const [tripId, times] of feed.stopTimesByTrip) {
    const trip = feed.trips.get(tripId);
    if (!trip) continue;
    for (const time of times) {
      const records = index.get(time.stopId) ?? [];
      records.push({ trip, time });
      index.set(time.stopId, records);
    }
  }
  stopTimeIndex.set(feed, index);
  return index;
}

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function offsetDate(key: string, offset: number): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function activeServices(feed: GtfsFeed, dateKey: string): Set<string> {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" })
    .format(new Date(`${dateKey}T12:00:00Z`)).toLowerCase();
  const encoded = dateKey.replaceAll("-", "");
  const active = new Set<string>();
  for (const service of feed.calendar.values()) {
    if (service.startDate <= encoded && service.endDate >= encoded && service.weekdays[weekday]) {
      active.add(service.serviceId);
    }
  }
  return active;
}

function validNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function publicStop(stop: GtfsStop) {
  return { id: stop.id, name: stop.name, latitude: stop.coordinates.latitude, longitude: stop.coordinates.longitude };
}

router.get("/stops", async (req, res): Promise<void> => {
  const west = validNumber(req.query.west);
  const south = validNumber(req.query.south);
  const east = validNumber(req.query.east);
  const north = validNumber(req.query.north);
  if ([west, south, east, north].some((value) => value === undefined) ||
      east! <= west! || north! <= south! ||
      east! - west! > MAX_BOUNDS_SPAN || north! - south! > MAX_BOUNDS_SPAN) {
    res.status(400).json({ error: "Informe os limites válidos da área do mapa." });
    return;
  }

  try {
    const feed = await getArtespGtfsFeed();
    const centerLat = (south! + north!) / 2;
    const centerLng = (west! + east!) / 2;
    const stops = [...feed.stops.values()]
      .filter((stop) => stop.coordinates.longitude >= west! && stop.coordinates.longitude <= east! &&
        stop.coordinates.latitude >= south! && stop.coordinates.latitude <= north!)
      .sort((a, b) => {
        const da = (a.coordinates.latitude - centerLat) ** 2 + (a.coordinates.longitude - centerLng) ** 2;
        const db = (b.coordinates.latitude - centerLat) ** 2 + (b.coordinates.longitude - centerLng) ** 2;
        return da - db;
      })
      .slice(0, 600)
      .map(publicStop);
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.json({ source: feed.source.name, updatedAt: feed.source.updatedAt, total: stops.length, stops });
  } catch (error) {
    req.log.error({ err: error }, "Bus stop map data unavailable");
    res.status(503).json({ error: "Os pontos de ônibus estão temporariamente indisponíveis." });
  }
});

router.get("/stops/:stopId/arrivals", async (req, res): Promise<void> => {
  const stopId = req.params.stopId;
  try {
    const feed = await getArtespGtfsFeed();
    const stop = feed.stops.get(stopId);
    if (!stop) {
      res.status(404).json({ error: "Ponto de ônibus não encontrado no feed disponível." });
      return;
    }

    const now = Date.now();
    const arrivals: Array<{ tripId: string; line: string; headsign: string; arrivalAt: string; minutesUntil: number }> = [];
    const records = indexStopTimes(feed).get(stopId) ?? [];
    const today = localDateKey(new Date(now));
    for (const offset of [-1, 0, 1]) {
      const dateKey = offsetDate(today, offset);
      const services = activeServices(feed, dateKey);
      if (!services.size) continue;
      const midnight = Date.parse(`${dateKey}T00:00:00-03:00`);
      for (const record of records) {
        if (!services.has(record.trip.serviceId)) continue;
        const epoch = midnight + record.time.arrivalSeconds * 1_000;
        if (epoch < now - 60_000 || epoch > now + ARRIVAL_WINDOW_MS) continue;
        const route = feed.routes.get(record.trip.routeId);
        arrivals.push({
          tripId: record.trip.id,
          line: route?.shortName ?? record.trip.routeId,
          headsign: record.trip.headsign || route?.longName || "Sentido não informado",
          arrivalAt: new Date(epoch).toISOString(),
          minutesUntil: Math.max(0, Math.ceil((epoch - now) / 60_000)),
        });
      }
    }
    arrivals.sort((a, b) => Date.parse(a.arrivalAt) - Date.parse(b.arrivalAt));
    const unique = arrivals.filter((item, index) =>
      arrivals.findIndex((other) => other.tripId === item.tripId && other.arrivalAt === item.arrivalAt) === index
    ).slice(0, ARRIVAL_LIMIT);

    res.setHeader("Cache-Control", "public, max-age=20, stale-while-revalidate=30");
    res.json({
      stop: publicStop(stop),
      source: "Horários programados do GTFS metropolitano da ARTESP",
      updatedAt: feed.source.updatedAt,
      isRealtime: false,
      arrivals: unique,
      message: unique.length ? undefined : "Não há partidas programadas nas próximas 2 horas para este ponto.",
    });
  } catch (error) {
    req.log.error({ err: error, stopId }, "Bus stop arrivals unavailable");
    res.status(503).json({ error: "Não foi possível consultar os próximos ônibus agora." });
  }
});

export default router;
