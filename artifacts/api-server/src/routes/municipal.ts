import { Router, type IRouter } from "express";
import catalog from "../data/barueri-cittamobi-routes.json";
import { getBarueriMunicipalGtfsFeed } from "../lib/barueriMunicipalGtfsSource";

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

router.get("/municipal/diagnostics", async (_req, res) => {
  const feed = await getBarueriMunicipalGtfsFeed();
  res.json({
    source: feed.source,
    routes: feed.routes.size,
    stops: feed.stops.size,
    trips: feed.trips.size,
    shapes: feed.shapes.size,
  });
});

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

export default router;
