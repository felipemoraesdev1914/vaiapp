import { useCallback, useEffect, useRef, useState } from "react";
import { Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import { stopIcon } from "./markers";

type BusStop = { id: string; name: string; latitude: number; longitude: number };
type Arrival = { tripId: string; line: string; headsign: string; arrivalAt: string; minutesUntil: number };
type ArrivalsResponse = {
  stop: BusStop;
  source: string;
  isRealtime: boolean;
  arrivals: Arrival[];
  message?: string;
  error?: string;
};

const API_BASE_URL = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const apiUrl = (path: string) => `${API_BASE_URL}/api${path}`;

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date(value));
}

function formatWait(minutes: number): string {
  if (minutes <= 0) return "chegando";
  if (minutes === 1) return "em 1 min";
  return `em ${minutes} min`;
}

function StopPopup({ stop }: { stop: BusStop }) {
  const [data, setData] = useState<ArrivalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiUrl(`/stops/${encodeURIComponent(stop.id)}/arrivals`), {
        signal: controller.signal,
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = await response.json() as ArrivalsResponse;
      if (!response.ok) throw new Error(body.error || "Não foi possível consultar os horários.");
      if (!controller.signal.aborted) setData(body);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha ao consultar os horários.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [stop.id]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 60_000);
    return () => {
      window.clearInterval(interval);
      controllerRef.current?.abort();
    };
  }, [load]);

  return (
    <div className="vai-stop-popup">
      <div className="vai-stop-popup-head">
        <span className="vai-stop-popup-icon" aria-hidden="true">↗</span>
        <div><span className="vai-stop-popup-kicker">PONTO DE ÔNIBUS</span><strong>{stop.name}</strong></div>
      </div>
      <div className="vai-stop-arrivals-title"><span>Próximos ônibus</span><span className="vai-stop-live-dot" /></div>
      {loading && !data ? <div className="vai-stop-state">Consultando horários...</div> : null}
      {error ? <div className="vai-stop-state is-error">{error}</div> : null}
      {data?.arrivals?.length ? (
        <div className="vai-stop-arrivals">
          {data.arrivals.slice(0, 6).map((arrival) => (
            <div className="vai-stop-arrival" key={`${arrival.tripId}-${arrival.arrivalAt}`}>
              <span className="vai-stop-line-code">{arrival.line}</span>
              <span className="vai-stop-destination">{arrival.headsign}</span>
              <span className="vai-stop-wait"><strong>{formatWait(arrival.minutesUntil)}</strong><small>{formatTime(arrival.arrivalAt)}</small></span>
            </div>
          ))}
        </div>
      ) : null}
      {data && !data.arrivals.length ? <div className="vai-stop-state">{data.message || "Nenhum ônibus previsto nas próximas 2 horas."}</div> : null}
      <div className="vai-stop-popup-foot">
        <span>Horários programados · ARTESP</span>
        <button type="button" onClick={() => void load()} disabled={loading}>Atualizar</button>
      </div>
      {!data?.isRealtime && <p className="vai-stop-disclaimer">Previsão baseada na tabela de horários. O horário real pode variar.</p>}
    </div>
  );
}

export function StopsLayer() {
  const map = useMap();
  const [stops, setStops] = useState<BusStop[]>([]);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  const loadStops = useCallback(() => {
    const bounds = map.getBounds();
    const query = new URLSearchParams({
      west: bounds.getWest().toFixed(6),
      south: bounds.getSouth().toFixed(6),
      east: bounds.getEast().toFixed(6),
      north: bounds.getNorth().toFixed(6),
    });
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void fetch(apiUrl(`/stops?${query.toString()}`), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    }).then(async (response) => {
      const body = await response.json() as { stops?: BusStop[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Não foi possível carregar os pontos.");
      if (!controller.signal.aborted) {
        setStops(Array.isArray(body.stops) ? body.stops : []);
        setError("");
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha ao carregar os pontos.");
    });
  }, [map]);

  useMapEvents({
    moveend: loadStops,
    zoomend: loadStops,
  });

  useEffect(() => {
    const timer = window.setTimeout(loadStops, 100);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [loadStops]);

  return (
    <>
      {stops.map((stop) => (
        <Marker
          key={stop.id}
          position={[stop.latitude, stop.longitude]}
          icon={stopIcon("map-stop")}
          title={stop.name}
          eventHandlers={{ click: () => setSelectedStopId(stop.id) }}
        >
          {selectedStopId === stop.id && <Popup minWidth={260} maxWidth={300} closeButton>
            <StopPopup stop={stop} />
          </Popup>}
        </Marker>
      ))}
      {error && <div className="vai-map-data-warning" role="status">Pontos temporariamente indisponíveis</div>}
    </>
  );
}
