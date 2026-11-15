import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routeCatalogPath = resolve(
  repoRoot,
  'artifacts/api-server/src/data/barueri-cittamobi-routes.json',
);
const discoveryPath = resolve(
  repoRoot,
  'artifacts/api-server/src/data/barueri-cittamobi-discovery.json',
);
const municipalIndexUrl =
  'https://linhas.cittamobi.com.br/linhas/estado/sao-paulo/barueri';
const minimumRequestIntervalMs = 1_100;
const dryRun = process.argv.includes('--dry-run');
let lastRequestAt = 0;

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

async function fetchHtml(url) {
  const delay = Math.max(0, minimumRequestIntervalMs - (Date.now() - lastRequestAt));
  if (delay > 0) await wait(delay);
  lastRequestAt = Date.now();

  const response = await fetch(url, {
    signal: AbortSignal.timeout(25_000),
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'VAI Mobilidade public-data catalog sync/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`Cittamobi respondeu HTTP ${response.status} em ${url}`);
  }
  if (new URL(response.url).hostname !== 'linhas.cittamobi.com.br') {
    throw new Error(`A página redirecionou para um domínio inesperado: ${response.url}`);
  }
  return { response, html: await response.text() };
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function municipalLineFromUrl(url) {
  const path = new URL(url).pathname;
  const match = path.match(
    /-(?:BenficaMunicipal-Barueri|RalipMunicipalBarueri)-([A-Z0-9]+)-/i,
  );
  return match?.[1]?.toUpperCase();
}

function routeIdentity(routeOrUrl, lineCode) {
  const url = typeof routeOrUrl === 'string' ? routeOrUrl : routeOrUrl.sourceUrl;
  const code = lineCode ?? routeOrUrl.lineCode;
  if (!url || !code) return undefined;
  const pathname = new URL(url).pathname.replace(/\.pdf$/i, '');
  const hash = pathname.match(/-([\da-f]{8,})$/i)?.[1]?.toLowerCase();
  return hash ? `${code.toUpperCase()}|${hash}` : undefined;
}

function busTripData(html) {
  const scripts = [...html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const [, raw] of scripts) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.['@graph'])
        ? parsed['@graph']
        : [parsed];
    const busTrip = candidates.find((candidate) =>
      (Array.isArray(candidate?.['@type'])
        ? candidate['@type']
        : [candidate?.['@type']]
      ).includes('BusTrip'),
    );
    if (busTrip) return busTrip;
  }
  return undefined;
}

function stopListFromHtml(html) {
  const stops = [...html.matchAll(
    /aria-label=["']Ver mapa da parada ([^"']+)["']/gi,
  )].map(([, label]) => decodeHtml(label));
  const positions = [...html.matchAll(/id=["']collapseStop(\d+)["']/gi)]
    .map(([, position]) => Number(position));
  const positionsAreOrdered = positions.length === stops.length &&
    positions.every((position, index) => position === index);
  if (!positionsAreOrdered || stops.some((stop) => stop.length < 5)) {
    throw new Error(
      `A sequência HTML de paradas está incompleta ou fora de ordem (${stops.length} rótulos, ${positions.length} posições).`,
    );
  }
  return stops;
}

function headsignFromName(name, lineCode) {
  const prefix = new RegExp(`^Linha\\s*${lineCode}\\s*[-–:]?\\s*`, 'i');
  return name.replace(prefix, '').trim();
}

async function catalogMunicipalPages() {
  const visitedIndexPages = new Set();
  const routePages = new Map();
  let nextUrl = municipalIndexUrl;

  while (nextUrl && !visitedIndexPages.has(nextUrl)) {
    visitedIndexPages.add(nextUrl);
    const { response, html } = await fetchHtml(nextUrl);
    const links = [...html.matchAll(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    )].map(([, href, label]) => ({
      url: new URL(href, response.url).href,
      label: decodeHtml(label.replace(/<[^>]*>/g, ' ')),
    }));

    for (const { url } of links) {
      if (
        new URL(url).hostname === 'linhas.cittamobi.com.br' &&
        new URL(url).pathname.startsWith('/linha/') &&
        municipalLineFromUrl(url)
      ) {
        routePages.set(routeIdentity(url, municipalLineFromUrl(url)), url);
      }
    }

    const nextPage = links.find(({ url, label }) =>
      /[?&]page=\d+/i.test(url) && /pr[oó]xima|next/i.test(label),
    );
    nextUrl = nextPage?.url;
  }

  if (routePages.size === 0) {
    throw new Error('O catálogo público não retornou páginas municipais.');
  }
  return { indexPages: [...visitedIndexPages], routePages };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const [catalog, discovery] = await Promise.all([
  readJson(routeCatalogPath),
  readJson(discoveryPath),
]);
const observedAt = localDateKey();
const { indexPages, routePages } = await catalogMunicipalPages();
const existingByIdentity = new Map();
const existingRoutesWithoutIdentity = [];
for (const route of catalog.routes) {
  const identity = routeIdentity(route);
  if (identity) existingByIdentity.set(identity, route);
  else existingRoutesWithoutIdentity.push(route);
}
const existingRoutesOutsideIndex = [...existingByIdentity.entries()]
  .filter(([identity]) => !routePages.has(identity))
  .map(([, route]) => route);

const scrapedPages = [];
const failures = [];
let completed = 0;
for (const [identity, url] of routePages) {
  try {
    const { html } = await fetchHtml(url);
    const trip = busTripData(html);
    const urlLineCode = municipalLineFromUrl(url);
    const lineCode = String(trip?.routeCode ?? '').trim().toUpperCase();
    const operator = String(trip?.provider?.name ?? '').trim();
    const routeName = String(trip?.name ?? '').trim();
    if (!trip || !lineCode || lineCode !== urlLineCode) {
      throw new Error(`O código da linha no HTML não corresponde ao link (${urlLineCode ?? 'sem código'}).`);
    }
    if (!operator.toLowerCase().includes('municipal') || operator.toLowerCase().includes('intermunicipal')) {
      throw new Error(`Operadora não classificada como municipal: ${operator || 'ausente'}.`);
    }
    if (!routeName || !trip.departureStation || !trip.arrivalStation) {
      throw new Error('A página não informa nome, origem e destino estruturados.');
    }
    const stops = stopListFromHtml(html);
    if (stops.length < 2) throw new Error('A página não apresenta um itinerário completo.');
    scrapedPages.push({
      identity,
      sourceUrl: url,
      lineCode,
      operator,
      headsign: headsignFromName(routeName, lineCode),
      origin: String(trip.departureStation).trim(),
      destination: String(trip.arrivalStation).trim(),
      stops,
    });
  } catch (error) {
    failures.push({ url, error: error instanceof Error ? error.message : String(error) });
  }
  completed += 1;
  if (completed % 10 === 0 || completed === routePages.size) {
    console.log(`Páginas municipais verificadas: ${completed}/${routePages.size}.`);
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ failedPages: failures.length, failures }, null, 2));
  throw new Error('A sincronização foi cancelada; nenhum arquivo foi alterado.');
}

const lineCodes = new Set(scrapedPages.map(({ lineCode }) => lineCode));
const sourceDifferences = [];
const addedRoutes = [];
const updatedRoutes = [];
for (const page of scrapedPages) {
  const existing = existingByIdentity.get(page.identity);
  if (existing) {
    if (existing.stops.length !== page.stops.length) {
      const difference = {
        identity: page.identity,
        lineCode: page.lineCode,
        operator: page.operator,
        headsign: page.headsign,
        sourceUrl: page.sourceUrl,
        previousSourceUrl: existing.sourceUrl,
        catalogStopCount: existing.stops.length,
        pageStopCount: page.stops.length,
        origin: page.origin,
        destination: page.destination,
        observedAt,
      };
      sourceDifferences.push(difference);
      existing.sourceReview = {
        selectedSourceUrl: page.sourceUrl,
        previousSourceUrl: existing.sourceUrl,
        previousStopCount: existing.stops.length,
        selectedStopCount: page.stops.length,
        selectedAt: observedAt,
        note: 'A página individual atual do Cittamobi apresentou uma sequência completa numerada diferente do registro anterior. A sequência da página foi selecionada e a fonte anterior foi preservada em sourceUrls.',
      };
    }
    existing.stops = page.stops;
    existing.observedAt = observedAt;
    existing.integrationStatus = 'catalog-only-needs-verified-stop-coordinates';
    existing.sourceUrls = [...new Set([
      ...(Array.isArray(existing.sourceUrls) ? existing.sourceUrls : [existing.sourceUrl]),
      ...(catalog.source.pages ?? []).filter((url) => routeIdentity(url, page.lineCode) === page.identity),
      page.sourceUrl,
    ].filter(Boolean))];
    existing.sourceUrl = page.sourceUrl;
    updatedRoutes.push(existing);
    continue;
  }

  const hash = page.identity.split('|').at(-1);
  const route = {
    routeId: `BARUERI-${page.lineCode}-${hash}`,
    lineCode: page.lineCode,
    operator: page.operator,
    headsign: page.headsign,
    direction: `${page.origin} para ${page.destination}`,
    sourceUrl: page.sourceUrl,
    observedAt,
    integrationStatus: 'catalog-only-needs-verified-stop-coordinates',
    stops: page.stops,
  };
  catalog.routes.push(route);
  existingByIdentity.set(page.identity, route);
  addedRoutes.push(route);
}

const sourceOnlyRouteCount = existingRoutesOutsideIndex.length + existingRoutesWithoutIdentity.length;
if (catalog.routes.length !== routePages.size + sourceOnlyRouteCount) {
  throw new Error(
    `A atualização geraria ${catalog.routes.length} registros para ${routePages.size} páginas e ${sourceOnlyRouteCount} registros de outras fontes; há duplicações que exigem conferência.`,
  );
}
for (const route of catalog.routes) {
  route.integrationStatus ??= 'catalog-only-needs-verified-stop-coordinates';
}

catalog.source.operators = [...new Set(scrapedPages.map(({ operator }) => operator))].sort();
catalog.source.operatorLabel = catalog.source.operators.join('; ');
catalog.source.lastCheckedAt = observedAt;
catalog.source.indexPages = [...new Set([
  ...(catalog.source.indexPages ?? []),
  ...indexPages,
])];
catalog.source.pages = [...new Set([
  ...(catalog.source.pages ?? []),
  ...scrapedPages.map(({ sourceUrl }) => sourceUrl),
])];
catalog.source.notes = [...new Set([
  ...(catalog.source.notes ?? []),
  `Atualização ${observedAt}: ${scrapedPages.length} sentidos municipais do índice Cittamobi foram conferidos; ${addedRoutes.length} incluídos e ${updatedRoutes.length} atualizados com a sequência numerada da página individual. Em ${sourceDifferences.length} sentido(s), a contagem da página atual divergiu do registro anterior; a página atual foi selecionada e a fonte anterior foi mantida em sourceUrls. ${sourceOnlyRouteCount} registro(s) de outras fontes foram preservados fora do índice atual. As paradas continuam sem coordenadas verificadas e fora do cálculo de rotas.`,
])];

const routeByIdentity = new Map();
for (const route of catalog.routes) {
  const identity = routeIdentity(route);
  if (identity) routeByIdentity.set(identity, route);
}
const differenceByIdentity = new Map(sourceDifferences.map((difference) => [difference.identity, difference]));
const coverageRows = scrapedPages.map((page) => {
  const route = routeByIdentity.get(page.identity);
  const difference = differenceByIdentity.get(page.identity);
  return {
    routeId: route?.routeId,
    lineCode: page.lineCode,
    operator: page.operator,
    headsign: page.headsign,
    direction: `${page.origin} para ${page.destination}`,
    stopCount: page.stops.length,
    catalogStopCount: route?.stops.length ?? 0,
    previousCatalogStopCount: difference?.catalogStopCount,
    previousSourceUrl: difference?.previousSourceUrl,
    itineraryComplete: page.stops.length >= 2,
    coordinatesAvailable: false,
    sourceUrl: page.sourceUrl,
    lastCheckedAt: observedAt,
    integrationStatus: difference
      ? 'current-page-selected-previous-source-differs-coordinates-pending'
      : 'stop-list-transcribed-coordinates-pending',
  };
});
for (const route of [...existingRoutesOutsideIndex, ...existingRoutesWithoutIdentity]) {
  coverageRows.push({
    routeId: route.routeId,
    lineCode: route.lineCode,
    operator: route.operator,
    headsign: route.headsign,
    direction: route.direction,
    stopCount: route.stops.length,
    catalogStopCount: route.stops.length,
    itineraryComplete: route.stops.length >= 2,
    coordinatesAvailable: false,
    sourceUrl: route.sourceUrl,
    lastCheckedAt: null,
    integrationStatus: 'catalog-source-not-listed-in-current-index-manual-review',
  });
}
discovery.routes = coverageRows;
discovery.status = sourceOnlyRouteCount > 0
  ? 'municipal-catalog-transcribed-source-only-review-and-geocoding-pending'
  : 'municipal-catalog-transcribed-geocoding-pending';
discovery.observedAt = observedAt;
discovery.catalogCounts = {
  municipalLineCodes: lineCodes.size,
  directionPagesInCittamobiIndex: scrapedPages.length,
  sourceOnlyDirections: sourceOnlyRouteCount,
  catalogDirections: catalog.routes.length,
  stopRecords: catalog.routes.reduce((total, route) => total + route.stops.length, 0),
  directionsWithVerifiedCoordinates: 0,
};
discovery.source.notes = (discovery.source.notes ?? []).map((note) =>
  note.includes('The full ordered stop list must be transcribed')
    ? 'The ordered stop lists from every municipal route page currently linked by the public index are transcribed in the main route catalog; geographic validation remains pending.'
    : note,
);
discovery.source.lastCheckedAt = observedAt;

const summary = {
  observedAt,
  indexPages: indexPages.length,
  municipalDirections: scrapedPages.length,
  municipalLineCodes: lineCodes.size,
  addedDirections: addedRoutes.length,
  refreshedDirections: updatedRoutes.length,
  sourceDifferences,
  sourceOnlyDirections: sourceOnlyRouteCount,
  catalogDirections: catalog.routes.length,
  catalogStopRecords: catalog.routes.reduce((total, route) => total + route.stops.length, 0),
  dryRun,
};

if (!dryRun) {
  await writeFile(routeCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(summary, null, 2));
