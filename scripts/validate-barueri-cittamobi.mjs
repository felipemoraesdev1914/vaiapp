import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dataPath = resolve(
  process.cwd(),
  "artifacts/api-server/src/data/barueri-cittamobi-routes.json",
);
const data = JSON.parse(await readFile(dataPath, "utf8"));

const errors = [];
if (data.schemaVersion !== 1) errors.push("schemaVersion deve ser 1.");
if (!Array.isArray(data.routes) || data.routes.length === 0) {
  errors.push("O catálogo precisa conter ao menos uma rota.");
}

const routeIds = new Set();
let totalStops = 0;
for (const [index, route] of (data.routes ?? []).entries()) {
  const prefix = `routes[${index}]`;
  if (!route.routeId || routeIds.has(route.routeId)) {
    errors.push(`${prefix}: routeId ausente ou duplicado (${route.routeId ?? "vazio"}).`);
  }
  routeIds.add(route.routeId);
  if (!route.lineCode || !route.operator || !route.direction) {
    errors.push(`${prefix}: linha, operadora e sentido são obrigatórios.`);
  }
  if (!route.sourceUrl || !/^https:\/\//.test(route.sourceUrl)) {
    errors.push(`${prefix}: sourceUrl HTTPS ausente ou inválida.`);
  }
  if (!Array.isArray(route.stops) || route.stops.length < 2) {
    errors.push(`${prefix}: precisa ter ao menos duas paradas.`);
  } else {
    totalStops += route.stops.length;
    route.stops.forEach((stop, stopIndex) => {
      if (typeof stop !== "string" || stop.trim().length < 5) {
        errors.push(`${prefix}.stops[${stopIndex}]: endereço inválido.`);
      }
    });
  }
  if (route.schedule && route.schedule.precision === undefined) {
    errors.push(`${prefix}: schedule precisa declarar a precisão dos horários.`);
  }
}

if (errors.length) {
  console.error("Validação do catálogo Cittamobi falhou:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Catálogo Cittamobi válido: ${data.routes.length} sentidos, ${totalStops} registros de paradas, ${new Set(data.routes.map((route) => route.lineCode)).size} linhas.`,
  );
  console.log("Observação: validação estrutural; não confirma coordenadas nem operação em campo.");
}
