import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readJson(path) {
  return JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8'));
}

const [catalog, discovery, inventory] = await Promise.all([
  readJson('artifacts/api-server/src/data/barueri-cittamobi-routes.json'),
  readJson('artifacts/api-server/src/data/barueri-cittamobi-discovery.json'),
  readJson('artifacts/api-server/src/data/barueri-cittamobi-line-inventory.json'),
]);

const errors = [];
const routesById = new Map(catalog.routes.map((route) => [route.routeId, route]));
const coverageRows = discovery.routes ?? [];
const coverageById = new Map();

if (catalog.status !== 'catalog-only-not-yet-used-by-routing-engine') {
  errors.push('O catálogo não está marcado como fora do mecanismo de rotas.');
}
if (coverageRows.length !== catalog.routes.length) {
  errors.push(`Cobertura contém ${coverageRows.length} sentidos; o catálogo contém ${catalog.routes.length}.`);
}

for (const [index, row] of coverageRows.entries()) {
  const prefix = `routes[${index}]`;
  const route = routesById.get(row.routeId);
  if (!row.routeId || coverageById.has(row.routeId)) {
    errors.push(`${prefix}: routeId ausente ou duplicado.`);
    continue;
  }
  coverageById.set(row.routeId, row);
  if (!route) {
    errors.push(`${prefix}: routeId ${row.routeId} não existe no catálogo principal.`);
    continue;
  }
  if (row.lineCode !== route.lineCode || row.operator !== route.operator) {
    errors.push(`${prefix}: linha ou operadora diverge do catálogo principal.`);
  }
  if (row.sourceUrl !== route.sourceUrl) {
    errors.push(`${prefix}: sourceUrl diverge do catálogo principal.`);
  }
  if (row.catalogStopCount !== route.stops.length) {
    errors.push(`${prefix}: catalogStopCount diverge da sequência principal.`);
  }
  if (row.stopCount < 2 || route.stops.length < 2 || row.itineraryComplete !== true) {
    errors.push(`${prefix}: itinerário incompleto ou sem sequência suficiente de paradas.`);
  }
  const coordinatesAvailable = route.stops.length > 0 && route.stops.every((stop) =>
    typeof stop === 'object' &&
    Number.isFinite(stop?.latitude) &&
    Number.isFinite(stop?.longitude),
  );
  if (row.coordinatesAvailable !== coordinatesAvailable) {
    errors.push(`${prefix}: indicador de coordenadas diverge dos dados armazenados.`);
  }
  if (!row.integrationStatus || !/^https:\/\//.test(row.sourceUrl ?? '')) {
    errors.push(`${prefix}: fonte ou situação de integração ausente.`);
  }
}

for (const route of catalog.routes) {
  if (!coverageById.has(route.routeId)) {
    errors.push(`A rota ${route.routeId} não aparece na tabela de cobertura.`);
  }
  if (/intermunicipal/i.test(route.operator)) {
    errors.push(`A linha intermunicipal ${route.lineCode} foi misturada ao catálogo municipal.`);
  }
  if (route.integrationStatus === 'catalog-only-needs-verified-stop-coordinates') {
    if (!Array.isArray(route.stops) || route.stops.some((stop) => typeof stop !== 'string')) {
      errors.push(`A rota ${route.routeId} precisa manter suas paradas sem coordenadas inferidas.`);
    }
  }
}

const catalogCodes = new Set(catalog.routes.map(({ lineCode }) => lineCode));
const inventoryCodes = new Set(inventory.municipalLineCodes);
const missingInventoryCodes = [...inventoryCodes].filter((code) => !catalogCodes.has(code));
const sourceOnlyDirections = coverageRows.filter((row) =>
  row.integrationStatus === 'catalog-source-not-listed-in-current-index-manual-review',
).length;
if (sourceOnlyDirections !== discovery.catalogCounts?.sourceOnlyDirections) {
  errors.push('A contagem de sentidos preservados fora do índice atual diverge da tabela de cobertura.');
}
if (
  discovery.catalogCounts?.catalogDirections !== catalog.routes.length ||
  discovery.catalogCounts?.stopRecords !== catalog.routes.reduce((total, route) => total + route.stops.length, 0)
) {
  errors.push('As contagens resumidas da tabela de cobertura divergem do catálogo.');
}

if (errors.length > 0) {
  console.error('Validação da cobertura Cittamobi falhou:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Cobertura Cittamobi válida: ${catalog.routes.length} sentidos, ${catalogCodes.size} códigos municipais, ${catalog.routes.reduce((total, route) => total + route.stops.length, 0)} registros de paradas.`,
  );
  console.log(
    `Coordenadas verificadas: ${coverageRows.filter(({ coordinatesAvailable }) => coordinatesAvailable).length}; fora do índice atual e preservadas para revisão: ${sourceOnlyDirections}; códigos do inventário sem sentido no catálogo: ${missingInventoryCodes.length}.`,
  );
  if (missingInventoryCodes.length > 0) {
    console.log(`Códigos sem itinerário no catálogo: ${missingInventoryCodes.join(', ')}.`);
  }
}
