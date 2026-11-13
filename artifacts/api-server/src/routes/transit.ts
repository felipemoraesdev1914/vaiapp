import { Router, type IRouter } from "express";
import {
  SearchTransitRoutesBody,
  SearchTransitRoutesResponse,
} from "@workspace/api-zod";
import { searchTransitRoutes } from "../lib/routingEngine";

const router: IRouter = Router();

const WALKING_UNAVAILABLE_MESSAGE =
  "O cálculo a pé está indisponível no momento. Tente novamente em instantes.";
const TRANSIT_DATA_UNAVAILABLE_MESSAGE =
  "Os horários oficiais de transporte não estão disponíveis agora. Tente novamente mais tarde.";
const GENERIC_SERVICE_MESSAGE =
  "Não foi possível calcular as rotas agora. Tente novamente em instantes.";

// Traduz falhas técnicas (rede, HTTP, arquivos) em mensagens seguras para o usuário.
function userFacingServiceMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/caminhada|OpenStreetMap|roteador|routed-foot|FOSSGIS/i.test(text)) {
    return WALKING_UNAVAILABLE_MESSAGE;
  }
  if (/GTFS|ARTESP|catálogo|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|timeout|aborted|HTTP \d{3}|ZIP|feed/i.test(text)) {
    return TRANSIT_DATA_UNAVAILABLE_MESSAGE;
  }
  return GENERIC_SERVICE_MESSAGE;
}

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
    // O erro técnico completo fica nos logs; ao usuário vai uma mensagem em português.
    req.log.error({ err: error }, "Transit route search failed");
    res.status(503).json({ error: userFacingServiceMessage(error) });
  }
});

export default router;
