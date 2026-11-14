import { mkdir, writeFile } from "node:fs/promises";

const base = "https://linhas.cittamobi.com.br";
const listingUrls = [
  `${base}/linhas/estado/sao-paulo/barueri/benfica-municipal-barueri`,
  `${base}/linhas/estado/sao-paulo/barueri/ralip-municipal-barueri`,
];
const headers = {
  "user-agent": "Mozilla/5.0 (compatible; VAI-Mobilidade/1.0; Barueri municipal transit research)",
  "accept": "text/html,application/xhtml+xml,application/json,*/*",
};

async function getText(url) {
  const response = await fetch(url, {
    headers: { ...headers, referer: base + "/", origin: base },
    signal: AbortSignal.timeout(50_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 250)}`);
  return body;
}
function decode(value = "") {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}
function stripTags(value = "") {
  return decode(value.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}
function extractLinks(html, origin) {
  const found = [];
  for (const match of html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    try { found.push({ url: new URL(decode(match[2]), origin).href, text: stripTags(match[3]).slice(0, 180) }); } catch {}
  }
  return found;
}
function extractStopRecords(html) {
  const matches = [...html.matchAll(/data-stop-id=["']([^"']+)["']/gi)];
  return matches.map((match, index) => {
    const start = Math.max(0, match.index - 500);
    const end = Math.min(html.length, matches[index + 1]?.index ?? match.index + 1800);
    const snippet = html.slice(start, end);
    const attributes = Object.fromEntries(
      [...snippet.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)=["']([^"']*)["']/g)]
        .map((item) => [item[1], decode(item[2])]),
    );
    return {
      id: match[1],
      sequence: index + 1,
      address: (attributes["aria-label"] ?? "").replace(/^Ver mapa da parada\s*/i, "").trim(),
      mapImage: attributes["data-deferred-src"] ?? null,
      attributes,
      text: stripTags(snippet).slice(0, 500),
    };
  });
}
function extractDepartures(html) {
  const match = html.match(/<script[^>]*id=["']line-departures-v1["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
function extractBusTripJsonLd(html) {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/application\/ld\+json/i.test(match[1])) continue;
    try {
      const parsed = JSON.parse(match[2]);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const trip = entries.find((entry) => entry?.["@type"] === "BusTrip");
      if (trip) return trip;
    } catch {}
  }
  return null;
}
function extractWeeklyTable(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const rows = [];
  for (const table of tables) {
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map((cell) => stripTags(cell[1]));
      if (cells.length >= 3 && /^(domingo|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado)$/i.test(cells[0])) {
        rows.push({ day: cells[0], operatingHours: cells[1], averageHeadway: cells[2] });
      }
    }
  }
  return rows;
}
function routeCodeFromUrl(url) {
  const slug = new URL(url).pathname.split("/linha/")[1] ?? "";
  return slug.match(/(?:BenficaMunicipal-Barueri|RalipMunicipalBarueri)-([A-Z0-9]+)-/i)?.[1]?.toUpperCase() ?? "UNKNOWN";
}
function operatorFromUrl(url) {
  return /RalipMunicipalBarueri/i.test(url) ? "Ralip Municipal Barueri" : "Benfica Municipal - Barueri";
}
function routeDate(busTrip) {
  const first = Array.isArray(busTrip?.departureTime) ? busTrip.departureTime[0] : null;
  if (!first) return null;
  const match = String(first).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

const listings = [];
for (const url of listingUrls) {
  const html = await getText(url);
  const links = [...new Map(
    extractLinks(html, base)
      .filter((link) => new URL(link.url).pathname.startsWith("/linha/"))
      .map((link) => [link.url, link]),
  ).values()];
  listings.push({ url, title: stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""), routeCount: links.length, links });
}
const allLinks = [...new Map(listings.flatMap((listing) => listing.links).map((link) => [link.url, link])).values()];
const routeUrls = allLinks.map((link) => link.url);
const pages = [];

for (let index = 0; index < routeUrls.length; index += 4) {
  const chunk = routeUrls.slice(index, index + 4);
  const results = await Promise.all(chunk.map(async (url) => {
    try {
      const html = await getText(url);
      const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      const agencyId = html.match(/<input[^>]*id=["']agencyId["'][^>]*value=["']([^"']+)["']/i)?.[1] ?? null;
      const serviceId = html.match(/<input[^>]*id=["']serviceId["'][^>]*value=["']([^"']+)["']/i)?.[1] ?? null;
      const stopDom = extractStopRecords(html);
      const departures = extractDepartures(html);
      const busTrip = extractBusTripJsonLd(html);
      const weeklySchedule = extractWeeklyTable(html);
      return {
        url,
        title,
        lineCode: routeCodeFromUrl(url),
        operator: operatorFromUrl(url),
        agencyId,
        serviceId,
        observedScheduleDate: routeDate(busTrip),
        departureTimeListAtOrigin: busTrip?.departureTime ?? [],
        startTime: busTrip?.transitSchedule?.startTime ?? null,
        endTime: busTrip?.transitSchedule?.endTime ?? null,
        stops: stopDom.map((stop) => ({
          ...stop,
          departureTimes: departures?.[String(stop.sequence - 1)] ?? [],
        })),
        scheduleByDay: weeklySchedule,
        scheduleRowsCount: weeklySchedule.length,
        departureStopIndexCount: departures ? Object.keys(departures).length : 0,
        htmlLength: html.length,
        timetableCoverage: departures ? Object.values(departures).filter(Array.isArray).map(value => value.length) : [],
      };
    } catch (error) {
      return { url, lineCode: routeCodeFromUrl(url), operator: operatorFromUrl(url), error: error instanceof Error ? error.message : String(error) };
    }
  }));
  pages.push(...results);
  console.log(`Fetched municipal line pages ${Math.min(index + chunk.length, routeUrls.length)}/${routeUrls.length}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const successful = pages.filter((page) => !page.error);
const allStops = successful.flatMap((page) => page.stops ?? []);
const uniqueStops = new Map();
for (const stop of allStops) if (!uniqueStops.has(stop.id)) uniqueStops.set(stop.id, stop);

const output = {
  schemaVersion: 2,
  source: "Cittamobi public municipal operator line pages",
  capturedAt: new Date().toISOString(),
  operators: ["Benfica Municipal - Barueri", "Ralip Municipal Barueri"],
  listingPages: listings.map(({ url, title, routeCount }) => ({ url, title, routeCount })),
  listedRoutePageCount: routeUrls.length,
  fetchedRoutePageCount: successful.length,
  failedRoutePages: pages.filter((page) => page.error),
  totalDirectionStopRecords: allStops.length,
  uniqueStopIdentifiers: uniqueStops.size,
  stopRecordsWithAddresses: allStops.filter((stop) => stop.address).length,
  directionsWithStopTimes: successful.filter((page) => page.departureStopIndexCount > 0).length,
  directionsWithWeeklySchedule: successful.filter((page) => page.scheduleRowsCount > 0).length,
  lines: successful,
};
const outputPath = "artifacts/api-server/src/data/barueri-cittamobi-lines-source.json";
await mkdir("artifacts/api-server/src/data", { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  operators: listings.map(({ url, routeCount }) => ({ url, routeCount })),
  listedRoutePages: routeUrls.length,
  fetchedRoutePages: successful.length,
  failures: pages.filter((page) => page.error).length,
  directionsWithStops: successful.filter((page) => (page.stops?.length ?? 0) > 0).length,
  directionStopRecords: allStops.length,
  uniqueStopIds: uniqueStops.size,
  withAddresses: allStops.filter((stop) => stop.address).length,
  directionsWithStopTimes: output.directionsWithStopTimes,
  directionsWithWeeklySchedule: output.directionsWithWeeklySchedule,
  lineCodes: [...new Set(successful.map((page) => page.lineCode))].sort(),
}));
