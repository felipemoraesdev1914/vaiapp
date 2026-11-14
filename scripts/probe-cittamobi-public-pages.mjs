import { mkdir, writeFile } from "node:fs/promises";

const base = "https://linhas.cittamobi.com.br";
const apiBase = "https://api.cittamobi.com.br";
const listingUrl = `${base}/linhas/estado/sao-paulo/barueri`;
const knownRouteUrl = `${base}/linha/transporte_publico-Barueri-BenficaMunicipal-Barueri-A260-TerminalbarueriviaHospital-fb3b732a7a9a`;
const headers = {
  "user-agent": "Mozilla/5.0 (compatible; VAI-Mobilidade/1.0; Barueri public transit integration)",
  "accept": "text/html,application/xhtml+xml,application/json,*/*",
};

async function getText(url, accept = headers.accept, referer = base + "/") {
  const response = await fetch(url, {
    headers: { ...headers, accept, referer, origin: base },
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 300)}`);
  return body;
}

function decode(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function stripTags(value = "") {
  return decode(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}
function extractLinks(html, origin) {
  const found = [];
  const regex = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    try {
      found.push({
        url: new URL(decode(match[2]), origin).href,
        text: stripTags(match[3]).slice(0, 180),
      });
    } catch {}
  }
  return found;
}
function hiddenInputValue(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\]/g, "\$&");
  const byIdFirst = html.match(new RegExp(`<input[^>]*id=["']${escapedId}["'][^>]*value=["']([^"']+)["']`, "i"));
  if (byIdFirst) return decode(byIdFirst[1]);
  const valueFirst = html.match(new RegExp(`<input[^>]*value=["']([^"']+)["'][^>]*id=["']${escapedId}["']`, "i"));
  return valueFirst ? decode(valueFirst[1]) : null;
}
function parseStopsFromHtml(html) {
  const matches = [...html.matchAll(/data-stop-id=["']([^"']+)["']/gi)];
  return matches.map((match, index) => {
    const start = Math.max(0, match.index - 500);
    const end = Math.min(html.length, matches[index + 1]?.index ?? match.index + 1800);
    const snippet = html.slice(start, end);
    const text = stripTags(snippet).replace(/\s+/g, " ").slice(0, 1000);
    const attributes = [...snippet.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)=["']([^"']*)["']/g)]
      .map((item) => [item[1], decode(item[2])]);
    return {
      id: match[1],
      sequence: index + 1,
      text,
      attributes: Object.fromEntries(attributes),
    };
  });
}
function parseStopDepartures(html) {
  const match = html.match(/<script[^>]*id=["']line-departures-v1["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
function normalizeApiStop(stop, index) {
  const latitude = Number(stop?.location?.lat);
  const longitude = Number(stop?.location?.lng);
  return {
    sequence: index + 1,
    id: String(stop?.id ?? ""),
    name: stop?.mnemonic ?? null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    bearing: Number.isFinite(Number(stop?.bearing)) ? Number(stop.bearing) : null,
    status: stop?.status ?? null,
    kind: stop?.kind ?? null,
    routeTypes: stop?.routeTypes ?? null,
  };
}
async function fetchServiceGeometry(serviceId, routeUrl) {
  const url = `${apiBase}/m3p/js/stops/service/v2/${encodeURIComponent(serviceId)}`;
  try {
    const content = await getText(url, "application/json,text/plain,*/*", routeUrl);
    const json = JSON.parse(content);
    const apiStops = Array.isArray(json.stops) ? json.stops : [];
    const stops = apiStops.map(normalizeApiStop);
    return {
      status: "ok",
      endpoint: url,
      stopCount: stops.length,
      geocodedStopCount: stops.filter((stop) => stop.latitude !== null && stop.longitude !== null).length,
      polyline: typeof json.polyline === "string" ? json.polyline : null,
      stops,
    };
  } catch (error) {
    return {
      status: "error",
      endpoint: url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const listingHtml = await getText(listingUrl);
const routeLinks = [...new Map(
  extractLinks(listingHtml, base)
    .filter((link) => new URL(link.url).pathname.startsWith("/linha/"))
    .map((link) => [link.url, link]),
).values()];

const queue = [...new Set([knownRouteUrl, ...routeLinks.map((link) => link.url)])].slice(0, 120);
const pages = [];
for (let index = 0; index < queue.length; index += 3) {
  const chunk = queue.slice(index, index + 3);
  const results = await Promise.all(chunk.map(async (url) => {
    try {
      const html = url === knownRouteUrl ? await getText(url) : await getText(url);
      const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      const agencyId = hiddenInputValue(html, "agencyId");
      const serviceId = hiddenInputValue(html, "serviceId");
      const stopDom = parseStopsFromHtml(html);
      const departures = parseStopDepartures(html);
      const municipal = /(?:Benfica|Ralip)Municipal-/i.test(url);
      const record = {
        url,
        title: stripTags(title),
        municipal,
        agencyId,
        serviceId,
        stopsFromHtml: stopDom,
        departuresByStopIndex: departures,
        departureStopIndexCount: departures ? Object.keys(departures).length : 0,
        htmlLength: html.length,
      };
      if (municipal && serviceId) {
        record.geometry = await fetchServiceGeometry(serviceId, url);
      } else if (municipal) {
        record.geometry = { status: "missing-service-id" };
      }
      return record;
    } catch (error) {
      return { url, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  pages.push(...results);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

const municipalPages = pages.filter((page) => page.municipal);
const routesWithGeometry = municipalPages.filter((page) => page.geometry?.status === "ok");
const allStops = routesWithGeometry.flatMap((page) =>
  (page.geometry.stops ?? []).map((stop) => ({
    ...stop,
    routeUrl: page.url,
    routeTitle: page.title,
    serviceId: page.serviceId,
  })),
);
const distinctStops = new Map();
for (const stop of allStops) {
  if (stop.id && !distinctStops.has(stop.id)) distinctStops.set(stop.id, stop);
}

const output = {
  schemaVersion: 1,
  source: "Cittamobi public route pages and public stops/service API",
  capturedAt: new Date().toISOString(),
  listingUrl,
  listingRouteLinkCount: routeLinks.length,
  pageCount: pages.length,
  municipalRoutePageCount: municipalPages.length,
  routesWithGeometryCount: routesWithGeometry.length,
  routesWithErrors: municipalPages.filter((page) => page.geometry?.status !== "ok"),
  totalRouteStopRecords: allStops.length,
  uniqueStopCount: distinctStops.size,
  uniqueGeocodedStopCount: [...distinctStops.values()].filter((stop) => stop.latitude !== null && stop.longitude !== null).length,
  routes: municipalPages,
  uniqueStops: [...distinctStops.values()],
};

const outputPath = "artifacts/api-server/src/data/barueri-cittamobi-geocoded-lines.json";
await mkdir("artifacts/api-server/src/data", { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  listingRoutes: routeLinks.length,
  pagesFetched: pages.length,
  municipalRoutePages: municipalPages.length,
  routesWithGeometry: routesWithGeometry.length,
  routesWithErrors: output.routesWithErrors.length,
  totalRouteStopRecords: allStops.length,
  uniqueStops: distinctStops.size,
  geocodedStops: output.uniqueGeocodedStopCount,
  errorSamples: output.routesWithErrors.slice(0, 8).map((route) => ({
    url: route.url,
    serviceId: route.serviceId,
    error: route.geometry?.error ?? route.geometry?.status,
  })),
  routeSamples: municipalPages.slice(0, 3).map((route) => ({
    url: route.url,
    stopCount: route.stopsFromHtml?.length,
    departureStopIndexCount: route.departureStopIndexCount,
    firstStops: route.stopsFromHtml?.slice(0, 3),
    firstDepartureEntries: Object.entries(route.departuresByStopIndex ?? {}).slice(0, 3),
  })),
}));
