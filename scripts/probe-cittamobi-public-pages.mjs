import { mkdir, writeFile } from "node:fs/promises";

const base = "https://linhas.cittamobi.com.br";
const listingUrl = `${base}/linhas/estado/sao-paulo/barueri`;
const knownRouteUrl = `${base}/linha/transporte_publico-Barueri-BenficaMunicipal-Barueri-A260-TerminalbarueriviaHospital-fb3b732a7a9a`;
const headers = {
  "user-agent": "Mozilla/5.0 (compatible; VAI-Mobilidade/1.0; Barueri transit research)",
  "accept": "text/html,application/xhtml+xml,application/json,*/*",
};

async function get(url, accept = headers.accept) {
  const response = await fetch(url, {
    headers: { ...headers, accept },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
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
  return decode(value.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ")).trim();
}
function extractLinks(html, origin) {
  const found = [];
  const regex = /<a\\b[^>]*href=(["'])(.*?)\\1[^>]*>([\\s\\S]*?)<\\/a>/gi;
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
function extractScripts(html, origin) {
  return [...html.matchAll(/<script\\b[^>]*src=(["'])(.*?)\\1/gi)]
    .map((match) => {
      try { return new URL(decode(match[2]), origin).href; } catch { return null; }
    })
    .filter(Boolean);
}
function extractInlineJson(html) {
  return [...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)]
    .map((match) => ({
      attrs: match[1].slice(0, 300),
      content: match[2].trim(),
    }))
    .filter((item) => item.content.startsWith("{") || item.content.startsWith("[") ||
      /__NEXT_DATA__|application\\/ld\\+json/i.test(item.attrs))
    .map((item) => ({
      attrs: item.attrs,
      content: item.content.slice(0, 120_000),
    }));
}
function keywordSnippets(text, patterns) {
  const snippets = [];
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, "ig");
    let match;
    while ((match = regex.exec(text)) && snippets.length < 70) {
      const start = Math.max(0, match.index - 240);
      const end = Math.min(text.length, match.index + match[0].length + 420);
      snippets.push({ keyword: pattern, text: text.slice(start, end) });
      regex.lastIndex = match.index + Math.max(1, match[0].length);
    }
  }
  return snippets;
}

const listingHtml = await get(listingUrl);
const knownHtml = await get(knownRouteUrl);
const routeLinks = [...new Map(
  extractLinks(listingHtml, base)
    .filter((link) => new URL(link.url).pathname.startsWith("/linha/"))
    .map((link) => [link.url, link]),
).values()];

const pages = [];
const queue = [...new Map(
  [knownRouteUrl, ...routeLinks.map((link) => link.url)].map((url) => [url, url]),
).values()].slice(0, 80);

for (let index = 0; index < queue.length; index += 3) {
  const chunk = queue.slice(index, index + 3);
  const results = await Promise.all(chunk.map(async (url) => {
    try {
      const html = url === knownRouteUrl ? knownHtml : await get(url);
      const title = decode(html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)?.[1] ?? "");
      const links = extractLinks(html, base);
      const scripts = extractScripts(html, base);
      const json = extractInlineJson(html);
      const geoTerms = keywordSnippets(html, [
        "api\\.cittamobi\\.com\\.br", "serviceId", "stopId", "routeId",
        "latitude", "longitude", "coordinates", "stops/service", "m3p",
        "lat", "lng", "mapbox", "polyline", "geometry",
      ]);
      return {
        url, title, htmlLength: html.length, scripts,
        mapRelatedLinks: links.filter((link) => /map|linha|stop|parada/i.test(link.text + " " + link.url)).slice(0, 40),
        inlineJson: json,
        geoTerms,
        htmlMarkers: keywordSnippets(html, ["Ver no mapa", "latitude", "longitude", "data-lat", "data-lng"]).slice(0, 30),
      };
    } catch (error) {
      return { url, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  pages.push(...results);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const scriptUrls = [...new Set(pages.flatMap((page) => page.scripts ?? []))].slice(0, 24);
const assets = [];
for (let index = 0; index < scriptUrls.length; index += 4) {
  const chunk = scriptUrls.slice(index, index + 4);
  const results = await Promise.all(chunk.map(async (url) => {
    try {
      const source = await get(url, "application/javascript,*/*");
      return {
        url, length: source.length,
        apiTerms: keywordSnippets(source, [
          "api\\.cittamobi\\.com\\.br", "m3p/js/stops", "serviceId",
          "stopId", "routeId", "latitude", "longitude", "stops/service",
        ]).slice(0, 80),
        endpoints: [...new Set(source.match(/https?:\\/\\/[^"'\\s\\\\]+/g) ?? [])]
          .filter((value) => /cittamobi|m3p|api/i.test(value)).slice(0, 100),
      };
    } catch (error) {
      return { url, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  assets.push(...results);
}

const output = {
  schemaVersion: 1,
  source: "Public Cittamobi Barueri line pages",
  capturedAt: new Date().toISOString(),
  listingUrl,
  listingRouteLinks: routeLinks,
  knownRouteHtmlLength: knownHtml.length,
  listingHtmlLength: listingHtml.length,
  pageCount: pages.length,
  scriptAssetCount: assets.length,
  pages,
  assets,
};

const outputPath = "artifacts/api-server/src/data/barueri-cittamobi-web-probe.json";
await mkdir("artifacts/api-server/src/data", { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  routesDiscovered: routeLinks.length,
  pagesFetched: pages.length,
  pagesFailed: pages.filter((page) => page.error).length,
  scriptAssetsInspected: assets.length,
  assetsWithApiTerms: assets.filter((asset) => asset.apiTerms?.length).length,
  pagesWithGeoTerms: pages.filter((page) => page.geoTerms?.length).length,
}));
