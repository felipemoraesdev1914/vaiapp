import { Router, type IRouter } from "express";
import catalog from "../data/barueri-cittamobi-routes.json";

const router: IRouter = Router();

const routes = catalog.routes;
const lines = [...new Set(routes.map((route) => route.lineCode))].sort();

function stopHasCoordinates(stop: unknown): boolean {
  if (!stop || typeof stop !== 'object') return false;
  const record = stop as Record<string, unknown>;
  const coordinates = record.coordinates && typeof record.coordinates === 'object'
    ? record.coordinates as Record<string, unknown>
    : record;
  return Number.isFinite(coordinates.latitude) && Number.isFinite(coordinates.longitude);
}

router.get("/municipal/routes", (req, res) => {
  const requestedLine = typeof req.query.line === "string"
    ? req.query.line.trim().toUpperCase()
    : undefined;

  const selected = requestedLine
    ? routes.filter((route) => route.lineCode.toUpperCase() === requestedLine)
    : routes;

  if (requestedLine && selected.length === 0) {
    res.status(404).json({
      error: "Linha municipal não encontrada no catálogo publicado.",
      availableLines: lines,
    });
    return;
  }

  const stopRecords = selected.reduce((total, route) => total + route.stops.length, 0);
  res.json({
    city: catalog.city,
    state: catalog.state,
    country: catalog.country,
    status: catalog.status,
    source: catalog.source,
    summary: {
      lineCount: new Set(selected.map((route) => route.lineCode)).size,
      directionCount: selected.length,
      stopRecordCount: stopRecords,
    },
    availableLines: lines,
    routes: selected,
  });
});

router.get("/municipal/lines", (_req, res) => {
  const summary = lines.map((lineCode) => {
    const lineRoutes = routes.filter((route) => route.lineCode === lineCode);
    return {
      lineCode,
      directionCount: lineRoutes.length,
      stopRecordCount: lineRoutes.reduce((total, route) => total + route.stops.length, 0),
      directions: lineRoutes.map((route) => ({
        routeId: route.routeId,
        headsign: route.headsign,
        direction: route.direction,
        stopCount: route.stops.length,
        itineraryComplete: route.stops.length >= 2,
        coordinatesAvailable: route.stops.length > 0 && route.stops.every(stopHasCoordinates),
        integrationStatus: route.integrationStatus ?? catalog.status,
        sourceUrl: route.sourceUrl,
        sourceUrls: route.sourceUrls ?? [route.sourceUrl],
        lastCheckedAt: route.observedAt ?? null,
        schedule: route.schedule,
      })),
    };
  });

  res.json({
    city: catalog.city,
    state: catalog.state,
    source: catalog.source.name,
    status: catalog.status,
    totalLines: summary.length,
    totalDirections: routes.length,
    totalStopRecords: routes.reduce((total, route) => total + route.stops.length, 0),
    lines: summary,
  });
});


router.get("/municipal/probe-cittamobi", async (_req, res) => {
  const candidates = [
    { serviceId: "c8432720-5cea-4685-aa99-b4ace325490b", stopId: "304b77ac-0c56-4c51-89e1-cdbbf6495415", agencyId: "b893bc70-d6af-4293-bbc0-81da5e38eaac" },
    { serviceId: "011a3116-c6b4-4b29-a405-82b71576dbb8", stopId: "491f51e2-e6ea-4fed-8e56-354438aff7e0", agencyId: "b893bc70-d6af-4293-bbc0-81da5e38eaac" },
  ];
  const hosts = ["api.cittamobi.com.br", "linhas.cittamobi.com.br", "api-linhas.cittamobi.com.br", "linhas-api.cittamobi.com.br", "api-linhas.cittamobi.com.br"];
  const checks = candidates.flatMap((item) => hosts.flatMap((host) => [
    { host, path: `/linesroutes/service/predictions?serviceId=${item.serviceId}&stopId=${item.stopId}` },
    { host, path: `/linesroutes/service/stops?serviceId=${item.serviceId}` },
    { host, path: `/m3p/js/stops/service/v2/${item.serviceId}?agencyId=${item.agencyId}` },
  ]));
  const results = await Promise.all(checks.map(async ({ host, path }) => {
    try {
      const response = await fetch(`https://${host}${path}`, {
        signal: AbortSignal.timeout(3500),
        headers: { accept: "application/json, text/plain, */*", "user-agent": "Mozilla/5.0 VAI/1.0" },
      });
      const body = await response.text();
      return { host, path, status: response.status, contentType: response.headers.get("content-type"), length: body.length, body: body.slice(0, 500) };
    } catch (error) {
      return { host, path, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  res.json({ tested: results.length, results });
});

export default router;
