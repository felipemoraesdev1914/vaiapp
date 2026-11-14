import { Router, type IRouter } from "express";
import catalog from "../data/barueri-cittamobi-routes.json";

const router: IRouter = Router();

const routes = catalog.routes;
const lines = [...new Set(routes.map((route) => route.lineCode))].sort();

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
        sourceUrl: route.sourceUrl,
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
