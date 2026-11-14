import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, type Readable as NodeReadable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import { openPromise } from "yauzl";

export type GeoPoint = {
  latitude: number;
  longitude: number;
};

export type GtfsStop = {
  id: string;
  name: string;
  coordinates: GeoPoint;
};

export type GtfsStopTime = {
  stopId: string;
  sequence: number;
  arrivalSeconds: number;
  departureSeconds: number;
};

export type GtfsTrip = {
  id: string;
  routeId: string;
  serviceId: string;
  shapeId: string;
  headsign: string;
};

export type GtfsRoute = {
  id: string;
  shortName: string;
  longName: string;
};

export type GtfsCalendar = {
  serviceId: string;
  startDate: string;
  endDate: string;
  weekdays: Record<string, boolean>;
};

export type GtfsFeed = {
  source: {
    name: string;
    url: string;
    license: string;
    version: string;
    updatedAt: string;
    coverage: string;
    limitations: string[];
  };
  stops: Map<string, GtfsStop>;
  routes: Map<string, GtfsRoute>;
  trips: Map<string, GtfsTrip>;
  stopTimesByTrip: Map<string, GtfsStopTime[]>;
  calendar: Map<string, GtfsCalendar>;
  shapes: Map<string, GeoPoint[]>;
};

type CkanResource = {
  format?: string;
  url?: string;
  size?: number;
  last_modified?: string;
  description?: string;
};

type CkanResponse = {
  success?: boolean;
  result?: {
    resources?: CkanResource[];
  };
};

const DATASET_PAGE = "https://dadosabertos.artesp.sp.gov.br/dataset/gtfs";
const DATASET_API =
  "https://dadosabertos.artesp.sp.gov.br/api/3/action/package_show?id=gtfs";
const DATASET_HOST = "dadosabertos.artesp.sp.gov.br";
const CACHE_DIRECTORY = path.join(tmpdir(), "vai-artesp-gtfs");
const MAX_FEED_BYTES = 100 * 1024 * 1024;

// This bounded index keeps the regional feed useful for Barueri while avoiding
// loading every stop-time and shape in the state into the process heap.
const BARUERI_SERVICE_AREA = {
  south: -23.56,
  north: -23.46,
  west: -46.93,
  east: -46.82,
};

const FEED_LIMITATIONS = [
  "O feed reúne linhas metropolitanas fiscalizadas pela ARTESP, não a malha completa de ônibus municipais de Barueri.",
  "O calendário publicado contém dias úteis, sábado e domingo; não há exceções de feriados em calendar_dates.txt.",
  "A ARTESP informa que parte dos horários em stop_times.txt é interpolada entre a primeira e a última parada.",
];

let feedPromise: Promise<GtfsFeed> | undefined;

function parseGtfsTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function getLatestResource(): Promise<Required<Pick<CkanResource, "url">> & CkanResource> {
  const response = await fetch(DATASET_API, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`O catálogo GTFS da ARTESP respondeu HTTP ${response.status}.`);
  }

  const body = (await response.json()) as CkanResponse;
  if (!body.success || !Array.isArray(body.result?.resources)) {
    throw new Error("O catálogo da ARTESP não retornou os recursos do GTFS.");
  }

  const resources = body.result.resources
    .filter(
      (resource): resource is Required<Pick<CkanResource, "url">> & CkanResource =>
        resource.format?.toLowerCase() === "zip" && typeof resource.url === "string",
    )
    .sort(
      (left, right) =>
        Date.parse(right.last_modified ?? "") - Date.parse(left.last_modified ?? ""),
    );
  const latest = resources[0];
  if (!latest) throw new Error("A ARTESP não publicou um arquivo GTFS ZIP disponível.");

  const downloadUrl = new URL(latest.url);
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.hostname !== DATASET_HOST ||
    !downloadUrl.pathname.includes("/dataset/")
  ) {
    throw new Error("A URL de download do GTFS não corresponde ao domínio oficial da ARTESP.");
  }
  if (latest.size !== undefined && latest.size > MAX_FEED_BYTES) {
    throw new Error("O arquivo GTFS da ARTESP excede o limite de tamanho aceito pelo serviço.");
  }

  return latest;
}

async function downloadFeed(resource: CkanResource & { url: string }): Promise<string> {
  await mkdir(CACHE_DIRECTORY, { recursive: true });
  const modifiedKey = (resource.last_modified ?? "latest").replace(/[^0-9]/g, "");
  const archivePath = path.join(CACHE_DIRECTORY, `artesp-${modifiedKey}.zip`);
  const partialPath = `${archivePath}.download`;

  try {
    const cached = await stat(archivePath);
    if (
      cached.size > 0 &&
      cached.size <= MAX_FEED_BYTES &&
      (resource.size === undefined || cached.size === resource.size)
    ) {
      return archivePath;
    }
  } catch {
    // The cache is optional; a missing file is downloaded below.
  }

  const response = await fetch(resource.url, {
    signal: AbortSignal.timeout(180_000),
    headers: { accept: "application/zip, application/octet-stream" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Não foi possível baixar o GTFS da ARTESP (HTTP ${response.status}).`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FEED_BYTES) {
    throw new Error("O arquivo GTFS da ARTESP excede o limite de tamanho aceito pelo serviço.");
  }

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(partialPath, { flags: "w" }),
      { signal: AbortSignal.timeout(180_000) },
    );
    const downloaded = await stat(partialPath);
    if (
      downloaded.size === 0 ||
      downloaded.size > MAX_FEED_BYTES ||
      (resource.size !== undefined && downloaded.size !== resource.size)
    ) {
      throw new Error("O tamanho do arquivo GTFS baixado não corresponde ao catálogo da ARTESP.");
    }
    await rename(partialPath, archivePath);
    return archivePath;
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}

async function openEntry(
  archivePath: string,
  fileName: string,
): Promise<{ stream: NodeReadable; close: () => void }> {
  const zip = await openPromise(archivePath, {
    autoClose: false,
    lazyEntries: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });

  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== fileName) continue;
      const stream = await zip.openReadStreamPromise(entry);
      return { stream, close: () => zip.close() };
    }
  } catch (error) {
    zip.close();
    throw error;
  }

  zip.close();
  throw new Error(`O feed GTFS não contém o arquivo obrigatório ${fileName}.`);
}

async function forEachCsvRow(
  archivePath: string,
  fileName: string,
  callback: (row: Record<string, string>) => void | Promise<void>,
): Promise<void> {
  const { stream, close } = await openEntry(archivePath, fileName);
  const parser = parse({
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  stream.on("error", (error) => parser.destroy(error));
  stream.pipe(parser);

  try {
    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      await callback(row);
    }
  } finally {
    close();
  }
}

function isInBarueriServiceArea(latitude: number, longitude: number): boolean {
  return (
    latitude >= BARUERI_SERVICE_AREA.south &&
    latitude <= BARUERI_SERVICE_AREA.north &&
    longitude >= BARUERI_SERVICE_AREA.west &&
    longitude <= BARUERI_SERVICE_AREA.east
  );
}

async function loadFeed(): Promise<GtfsFeed> {
  const resource = await getLatestResource();
  const archivePath = await downloadFeed(resource);

  const stops = new Map<string, GtfsStop>();
  await forEachCsvRow(archivePath, "stops.txt", (row) => {
    const latitude = Number(row.stop_lat);
    const longitude = Number(row.stop_lon);
    if (
      !row.stop_id ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !isInBarueriServiceArea(latitude, longitude)
    ) {
      return;
    }
    stops.set(row.stop_id, {
      id: row.stop_id,
      name: row.stop_name?.trim() || `Parada ${row.stop_id}`,
      coordinates: { latitude, longitude },
    });
  });
  if (stops.size === 0) {
    throw new Error("O GTFS da ARTESP não contém paradas na área regional de Barueri.");
  }

  const routes = new Map<string, GtfsRoute>();
  await forEachCsvRow(archivePath, "routes.txt", (row) => {
    if (!row.route_id) return;
    routes.set(row.route_id, {
      id: row.route_id,
      shortName: row.route_short_name?.trim() || row.route_id,
      longName: row.route_long_name?.trim() || row.route_short_name?.trim() || row.route_id,
    });
  });

  const trips = new Map<string, GtfsTrip>();
  await forEachCsvRow(archivePath, "trips.txt", (row) => {
    if (!row.trip_id || !row.route_id || !row.service_id) return;
    trips.set(row.trip_id, {
      id: row.trip_id,
      routeId: row.route_id,
      serviceId: row.service_id,
      shapeId: row.shape_id ?? "",
      headsign: row.trip_headsign?.trim() ?? "",
    });
  });

  const calendar = new Map<string, GtfsCalendar>();
  await forEachCsvRow(archivePath, "calendar.txt", (row) => {
    if (!row.service_id || !row.start_date || !row.end_date) return;
    calendar.set(row.service_id, {
      serviceId: row.service_id,
      startDate: row.start_date,
      endDate: row.end_date,
      weekdays: {
        monday: row.monday === "1",
        tuesday: row.tuesday === "1",
        wednesday: row.wednesday === "1",
        thursday: row.thursday === "1",
        friday: row.friday === "1",
        saturday: row.saturday === "1",
        sunday: row.sunday === "1",
      },
    });
  });

  const stopTimesByTrip = new Map<string, GtfsStopTime[]>();
  await forEachCsvRow(archivePath, "stop_times.txt", (row) => {
    if (!stops.has(row.stop_id) || !trips.has(row.trip_id)) return;
    const arrivalSeconds =
      parseGtfsTime(row.arrival_time) ?? parseGtfsTime(row.departure_time);
    const departureSeconds =
      parseGtfsTime(row.departure_time) ?? parseGtfsTime(row.arrival_time);
    const sequence = Number(row.stop_sequence);
    if (
      arrivalSeconds === undefined ||
      departureSeconds === undefined ||
      !Number.isFinite(sequence)
    ) {
      return;
    }

    const tripTimes = stopTimesByTrip.get(row.trip_id) ?? [];
    tripTimes.push({
      stopId: row.stop_id,
      sequence,
      arrivalSeconds,
      departureSeconds,
    });
    stopTimesByTrip.set(row.trip_id, tripTimes);
  });

  const relevantShapeIds = new Set<string>();
  for (const tripId of stopTimesByTrip.keys()) {
    const shapeId = trips.get(tripId)?.shapeId;
    if (shapeId) relevantShapeIds.add(shapeId);
  }
  const orderedShapes = new Map<string, Array<{ sequence: number; point: GeoPoint }>>();
  await forEachCsvRow(archivePath, "shapes.txt", (row) => {
    if (!relevantShapeIds.has(row.shape_id)) return;
    const latitude = Number(row.shape_pt_lat);
    const longitude = Number(row.shape_pt_lon);
    const sequence = Number(row.shape_pt_sequence);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(sequence)
    ) {
      return;
    }
    const points = orderedShapes.get(row.shape_id) ?? [];
    points.push({ sequence, point: { latitude, longitude } });
    orderedShapes.set(row.shape_id, points);
  });

  const shapes = new Map<string, GeoPoint[]>(
    [...orderedShapes.entries()].map(([shapeId, points]) => [
      shapeId,
      points
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ point }) => point),
    ]),
  );

  const feedInfo: Record<string, string> = {};
  await forEachCsvRow(archivePath, "feed_info.txt", (row) => {
    Object.assign(feedInfo, row);
  });

  const updatedAt =
    (resource.last_modified && new Date(resource.last_modified).toISOString()) ||
    new Date().toISOString();

  return {
    source: {
      name: "GTFS metropolitano da ARTESP",
      url: DATASET_PAGE,
      license: "Creative Commons Atribuição (CC BY)",
      version: feedInfo.feed_version || feedInfo.feed_start_date || "versão informada pela ARTESP",
      updatedAt,
      coverage:
        "Linhas metropolitanas fiscalizadas pela ARTESP com paradas no entorno de Barueri e municípios vizinhos.",
      limitations: FEED_LIMITATIONS,
    },
    stops,
    routes,
    trips,
    stopTimesByTrip,
    calendar,
    shapes,
  };
}

export function getArtespGtfsFeed(): Promise<GtfsFeed> {
  if (!feedPromise) {
    feedPromise = loadFeed().catch((error: unknown) => {
      feedPromise = undefined;
      throw error;
    });
  }
  return feedPromise;
}

export function parseGtfsTimeToSeconds(value: string): number | undefined {
  return parseGtfsTime(value);
}
