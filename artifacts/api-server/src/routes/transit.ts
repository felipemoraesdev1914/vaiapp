import { Router, type IRouter } from "express";
import {
  SearchTransitRoutesBody,
  SearchTransitRoutesResponse,
} from "@workspace/api-zod";
import { searchTransitRoutes } from "../lib/routingEngine";

const router: IRouter = Router();

router.post("/routes/search", async (req, res): Promise<void> => {
  const parsed = SearchTransitRoutesBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.issues }, "Invalid route search request");
    res
      .status(400)
      .json({ error: "Informe origem, destino e coordenadas válidas." });
    return;
  }

  try {
    const result = await searchTransitRoutes(parsed.data);
    res.json(SearchTransitRoutesResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Transit route search failed");
    const message =
      error instanceof Error
        ? error.message
        : "Os dados oficiais de transporte não estão disponíveis no momento.";
    res.status(503).json({ error: message });
  }
});

export default router;
