import type {
  GeoPoint,
  GtfsCalendar,
  GtfsFeed,
  GtfsRoute,
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
} from "./artespGtfsSource";
import catalog from "../data/barueri-cittamobi-routes.json";

type MunicipalRoute = (typeof catalog.routes)[number];
type CittamobiStop = {
  id?: number | string;
  mnemonic?: string;
  location?: { lat?: number; lng?: number };
};
type CittamobiService = {
  polyline?: string;
  stops?: CittamobiStop[];
};
type RouteData = {
  route: MunicipalRoute;
  stops: GtfsStop[];
  shape: GeoPoint[];
};

const API_BASE = "https://api.cittamobi.com.br/m3p/js/stops/service/v2";
const CITY_BOUNDS = { south: -23.56, north: -23.46, west: -46.93, east: -46.78 };
const FETCH_TIMEOUT_MS = 8_000;
const CONCURRENCY = 8;
let municipalFeedPromise: Promise<GtfsFeed> | undefined;

function emptyFeed(): GtfsFeed {
  return {
    source: {
      name: "Linhas municipais de Barueri (Cittamobi)",
      url: "https://linhas.cittamobi.com.br/linhas/estado/sao-paulo/barueri",
      license: "Dados públicos de itinerário; uso conforme autorização e condições da fonte",
      version: "municipal-pending",
      updatedAt: new Date().toISOString(),
      coverage: "Linhas municipais publicadas para Barueri.",
      limitations: [
        "A integração municipal só habilita itinerários cujas paradas e geometrias tenham coordenadas válidas fornecidas pela fonte.",
        "As frequências são estimativas derivadas do intervalo médio publicado; não são horários exatos por parada nem previsão em tempo real.",
      ],
    },
    stops: new Map(),
    routes: new Map(),
    trips: new Map(),
    stopTimesByTrip: new Map(),
    calendar: new Map(),
    shapes: new Map(),
  };
}

function decodePolyline(encoded: string): GeoPoint[] {
  const points: GeoPoint[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length) {
    const readDelta = (): number => {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length) throw new Error("Polyline municipal incompleta.");
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63) throw new Error("Polyline municipal inválida.");
        result |= (byte & 0x1f) << shift;
        shift += 5;
        if (shift > 30) throw new Error("Polyline municipal excede o limite.");
      } while (byte >= 0x20);
      return (result & 1) ? ~(result >> 1) : result >> 1;
    };
    latitude += readDelta();
    longitude += readDelta();
    const point = { latitude: latitude / 100_000, longitude: longitude / 100_000 };
    if (
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      point.latitude >= CITY_BOUNDS.south - 0.02 &&
      point.latitude <= CITY_BOUNDS.north + 0.02 &&
      point.longitude >= CITY_BOUNDS.west - 0.02 &&
      point.longitude <= CITY_BOUNDS.east + 0.02
    ) points.push(point);
  }
  return points;
}

function serviceIdFromHtml(html: string): string | undefined {
  const patterns = [
    /id=["']serviceId["'][^>]*value=["']([a-f0-9]{8}-[a-f0-9-]{27})["']/i,
    /["']serviceId["']\s*:\s*["']?(\d{3,})/i,
    /["']service_id["']\s*:\s*["']?(\d{3,})/i,
    /["']idService["']\s*:\s*["']?(\d{3,})/i,
    /data-service-id=["'](\d{3,})["']/i,
    /\/service\/(?:v2\/)?(\d{3,})(?:["'/?]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  // Some page builds serialize route metadata under Next/Nuxt hydration data.
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const script of scripts) {
    if (!/service|route/i.test(script)) continue;
    const match = script.match(/(?:serviceId|service_id|idService)\s*["']?\s*:\s*["']?(\d{3,})/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "user-agent": "VAI Mobilidade/1.0 (municipal transit integration)",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cittamobi respondeu HTTP ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json();
}

async function fetchRouteData(route: MunicipalRoute): Promise<RouteData | undefined> {
  try {
    const source = new URL(route.sourceUrl);
    if (source.protocol !== "https:" || !["linhas.cittamobi.com.br", "linhas-preview.cittamobi.com.br"].includes(source.hostname)) {
      return undefined;
    }
    const pageResponse = await fetch(source, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/html", "user-agent": "VAI Mobilidade/1.0" },
    });
    if (!pageResponse.ok) throw new Error(`Página da linha ${route.lineCode}: HTTP ${pageResponse.status}.`);
    const html = await pageResponse.text();
    const serviceId = serviceIdFromHtml(html) ?? source.pathname.match(/-([a-f0-9]{12})$/i)?.[1];
    if (route.lineCode === "A260") {
      const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((match) => match[1]).slice(0, 30);
      const agencyId = html.match(/id=["']agencyId["'][^>]*value=["']([^"']+)["']/i)?.[1];
      const apiContexts = [...html.matchAll(/.{0,100}(?:CittamobiAPI|api\.cittamobi|linesroutes|m3p\/js).{0,160}/gi)]
        .slice(0, 30)
        .map((match) => match[0].replace(/\s+/g, " ").slice(0, 240));
      const apiProbePaths = agencyId ? [
        "/m3p/js/services/agency/" + agencyId,
        "/m3p/js/services/agency/v2/" + agencyId,
        "/m3p/js/services/" + agencyId,
        "/m3p/js/stops/service/v2/" + serviceId + "?agencyId=" + agencyId,
        "/linesroutes/service/stops?serviceId=" + serviceId,
        "/linesroutes/service/itinerary?serviceId=" + serviceId,
        "/linesroutes/service/route?serviceId=" + serviceId,
        "/linesroutes/service/map?serviceId=" + serviceId,
        "/linesroutes/service/shape?serviceId=" + serviceId,
        "/linesroutes/service/geometry?serviceId=" + serviceId,
        "/linesroutes/service/stops/" + serviceId,
      ] : [];
      const apiProbeResults = await Promise.all(apiProbePaths.map(async (path) => {
        try {
          const response = await fetch(new URL(path, "https://api.cittamobi.com.br"), {
            signal: AbortSignal.timeout(3_000),
            headers: { accept: "application/json", "user-agent": "VAI Mobilidade/1.0" },
          });
          return { path, status: response.status, body: (await response.text()).slice(0, 260) };
        } catch (error) {
          return { path, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      const coordinateContexts = [...html.matchAll(/.{0,80}(?:latitude|longitude|\blat\b|\blng\b).{0,100}/gi)]
        .slice(0, 20)
        .map((match) => match[0].replace(/\s+/g, " ").slice(0, 220));
      const scriptPath = html.match(/<script[^>]+src=["']([^"']*route-line\.js[^"']*)/i)?.[1];
      let scriptContexts: string[] = [];
      if (scriptPath) {
        const scriptUrl = new URL(scriptPath, source.origin);
        const scriptResponse = await fetch(scriptUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { accept: "application/javascript", "user-agent": "VAI Mobilidade/1.0" },
        });
        const scriptText = scriptResponse.ok ? await scriptResponse.text() : "";
        scriptContexts = [...scriptText.matchAll(/.{0,100}(?:stops\/service|api\.cittamobi|serviceId|agencyId).{0,180}/gi)]
          .slice(0, 30)
          .map((match) => match[0].replace(/\s+/g, " ").slice(0, 260));
      }
      console.info(JSON.stringify({
        event: "municipal_cittamobi_api_probe",
        routeId: route.routeId,
        serviceIdCandidate: serviceId,
        scriptPath,
        scriptSrcs,
        agencyId,
        apiContexts,
        apiProbeResults,
        coordinateContexts,
        scriptContexts,
      }));
    }
    if (route.lineCode === "A260") {
      const contexts = [...html.matchAll(/.{0,90}(?:service|route|\bid\b).{0,130}/gi)]
        .slice(0, 35)
        .map((match) => match[0].replace(/\s+/g, " ").slice(0, 240));
      console.info(JSON.stringify({
        event: "municipal_cittamobi_page_probe",
        routeId: route.routeId,
        sourceUrl: route.sourceUrl,
        htmlLength: html.length,
        serviceIdCandidate: serviceId,
        contexts,
      }));
    }
    if (!serviceId) {
      console.warn(JSON.stringify({ event: "municipal_route_id_missing", line: route.lineCode, routeId: route.routeId }));
      return undefined;
    }
    const raw = await fetchJson(`${API_BASE}/${encodeURIComponent(serviceId)}`);
    const service = raw as CittamobiService;
    if (route.lineCode === "A260") {
      console.info(JSON.stringify({
        event: "municipal_cittamobi_payload_probe",
        routeId: route.routeId,
        serviceKeys: raw && typeof raw === "object" ? Object.keys(raw as Record<string, unknown>) : [],
        polylineType: typeof service?.polyline,
        stopCount: Array.isArray(service?.stops) ? service.stops.length : null,
        firstStop: Array.isArray(service?.stops) ? service.stops[0] : null,
      }));
    }
    if (!service || typeof service.polyline !== "string" || !Array.isArray(service.stops)) return undefined;
    const shape = decodePolyline(service.polyline);
    const stops = service.stops.flatMap((item, index) => {
      const latitude = item.location?.lat;
      const longitude = item.location?.lng;
      if (
        (typeof item.id !== "string" && typeof item.id !== "number") ||
        typeof item.mnemonic !== "string" ||
        typeof latitude !== "number" ||
        typeof longitude !== "number" ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < CITY_BOUNDS.south - 0.02 ||
        latitude > CITY_BOUNDS.north + 0.02 ||
        longitude < CITY_BOUNDS.west - 0.02 ||
        longitude > CITY_BOUNDS.east + 0.02
      ) return [];
      return [{
        id: `barueri:${item.id}`,
        name: item.mnemonic.trim() || `Parada ${index + 1}`,
        coordinates: { latitude, longitude },
      }];
    });
    if (stops.length < 2 || shape.length < 2) return undefined;
    return { route, stops, shape };
  } catch (error) {
    console.warn(JSON.stringify({
      event: "municipal_route_data_unavailable",
      line: route.lineCode,
      routeId: route.routeId,
      message: error instanceof Error ? error.message : String(error),
    }));
    return undefined;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await callback(values[index]!);
    }
  }));
  return results;
}

function secondsFromClock(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return undefined;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes > 59) return undefined;
  return hours * 3600 + minutes * 60;
}

function weekdayKey(date: Date): "weekday" | "saturday" | "sunday" {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(date);
  if (day === "Sat") return "saturday";
  if (day === "Sun") return "sunday";
  return "weekday";
}

function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function buildMunicipalFeed(data: RouteData[]): GtfsFeed {
  const feed = emptyFeed();
  const today = new Date();
  const dateVersion = today.toISOString().slice(0, 10);
  feed.source.version = `cittamobi-barueri-${dateVersion}`;
  feed.source.updatedAt = new Date(Math.max(
    ...data.map(({ route }) => Date.parse(route.observedAt ?? "") || 0),
    Date.now(),
  )).toISOString();

  for (const { route, stops, shape } of data) {
    const routeId = `municipal:${route.routeId}`;
    const shapeId = routeId;
    const gtfsRoute: GtfsRoute = {
      id: routeId,
      shortName: route.lineCode,
      longName: route.headsign,
    };
    feed.routes.set(routeId, gtfsRoute);
    feed.shapes.set(shapeId, shape);
    for (const stop of stops) feed.stops.set(stop.id, stop);

    const shapeDistance = shape.slice(1).reduce((sum, point, index) =>
      sum + distanceMeters(shape[index]!, point), 0);
    const estimatedDuration = Math.min(90 * 60, Math.max(8 * 60,
      Math.round(shapeDistance / (18_000 / 3_600) + stops.length * 25)));
    const cumulative = [0];
    for (let index = 1; index < stops.length; index += 1) {
      cumulative.push(cumulative[index - 1]! + distanceMeters(stops[index - 1]!.coordinates, stops[index]!.coordinates));
    }
    const totalStopDistance = cumulative.at(-1) || 1;
    const dayConfigs = [
      { key: "weekday", serviceId: `${routeId}:wd`, day: "weekday" },
      { key: "saturday", serviceId: `${routeId}:sat`, day: "saturday" },
      { key: "sunday", serviceId: `${routeId}:sun`, day: "sunday" },
    ] as const;

    for (const config of dayConfigs) {
      const schedule = route.schedule[config.key];
      const first = secondsFromClock(schedule?.firstDeparture);
      const last = secondsFromClock(schedule?.lastDeparture);
      const headway = Math.max(5, Math.round(schedule?.averageHeadwayMinutes ?? 0)) * 60;
      if (first === undefined || last === undefined || last < first || !schedule?.averageHeadwayMinutes) continue;
      const weekdays: GtfsCalendar["weekdays"] = {
        monday: config.day === "weekday",
        tuesday: config.day === "weekday",
        wednesday: config.day === "weekday",
        thursday: config.day === "weekday",
        friday: config.day === "weekday",
        saturday: config.day === "saturday",
        sunday: config.day === "sunday",
      };
      feed.calendar.set(config.serviceId, {
        serviceId: config.serviceId,
        startDate: "20260101",
        endDate: "20301231",
        weekdays,
      });

      for (let departure = first, tripNumber = 0; departure <= last && tripNumber < 80; departure += headway, tripNumber += 1) {
        const tripId = `${routeId}:${config.key}:${tripNumber}`;
        const times: GtfsStopTime[] = stops.map((stop, index) => {
          const progress = cumulative[index]! / totalStopDistance;
          const offset = Math.round(estimatedDuration * progress);
          return {
            stopId: stop.id,
            sequence: index + 1,
            arrivalSeconds: departure + offset,
            departureSeconds: departure + offset + (index > 0 && index < stops.length - 1 ? 20 : 0),
          };
        });
        feed.trips.set(tripId, {
          id: tripId,
          routeId,
          serviceId: config.serviceId,
          shapeId,
          headsign: route.headsign,
        } satisfies GtfsTrip);
        feed.stopTimesByTrip.set(tripId, times);
      }
    }
  }
  feed.source.coverage = `Itinerários municipais de Barueri com coordenadas de paradas fornecidas pela Cittamobi; ${data.length} sentidos integrados.`;
  feed.source.limitations = [
    "A frequência média publicada pela operadora foi usada para estimar partidas; horários por parada são aproximações e não substituem a tabela oficial.",
    "O tempo de percurso entre paradas é estimado pela extensão do itinerário e não representa trânsito ou GPS em tempo real.",
    "Somente itinerários com coordenadas de paradas e geometria válidas foram habilitados.",
  ];
  return feed;
}

async function loadMunicipalFeed(): Promise<GtfsFeed> {
  const routes = catalog.routes as MunicipalRoute[];
  const results = await mapWithConcurrency(routes, CONCURRENCY, fetchRouteData);
  const valid = results.filter((item): item is RouteData => Boolean(item));
  const feed = buildMunicipalFeed(valid);
  console.info(JSON.stringify({
    event: "municipal_gtfs_loaded",
    catalogDirections: routes.length,
    integratedDirections: valid.length,
    stops: feed.stops.size,
    trips: feed.trips.size,
    version: feed.source.version,
  }));
  return feed;
}

export function getBarueriMunicipalGtfsFeed(): Promise<GtfsFeed> {
  if (!municipalFeedPromise) {
    municipalFeedPromise = loadMunicipalFeed().catch((error: unknown) => {
      municipalFeedPromise = undefined;
      console.error(JSON.stringify({
        event: "municipal_gtfs_load_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
      return emptyFeed();
    });
  }
  return municipalFeedPromise;
}
