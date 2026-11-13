import { ArrowDown, ArrowUpDown, Bus, Clock3, Footprints, RefreshCw, Route as RouteIcon, Navigation, MapPin, Timer, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { TransitRouteOption, TransitRouteSearchResponse } from '@workspace/api-client-react';

type SortKey = 'fastest' | 'walking' | 'transfers';
type DurationLimit = 'any' | '30' | '60';
type WalkingLimit = 'any' | '10' | '20';
type TransferLimit = 'any' | '0' | '1';

type RouteResultsProps = {
  response?: TransitRouteSearchResponse;
  selectedRouteId: string | null;
  onSelectRoute: (route: TransitRouteOption | null) => void;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
};

function clockTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Não foi possível consultar as rotas neste momento.';
}

export function RouteResults({ response, selectedRouteId, onSelectRoute, isLoading, error, onRetry }: RouteResultsProps) {
  const [sort, setSort] = useState<SortKey>('fastest');
  const [durationLimit, setDurationLimit] = useState<DurationLimit>('any');
  const [walkingLimit, setWalkingLimit] = useState<WalkingLimit>('any');
  const [transferLimit, setTransferLimit] = useState<TransferLimit>('any');
  const [detailsOpen, setDetailsOpen] = useState(true);
  const routes = useMemo(() => {
    const list = (response?.routes ?? []).filter((route) => (
      (durationLimit === 'any' || route.totalMinutes <= Number(durationLimit))
      && (walkingLimit === 'any' || route.walkingMinutes <= Number(walkingLimit))
      && (transferLimit === 'any' || route.transferCount <= Number(transferLimit))
    ));
    if (sort === 'walking') return list.sort((a, b) => a.walkingMinutes - b.walkingMinutes || a.totalMinutes - b.totalMinutes);
    if (sort === 'transfers') return list.sort((a, b) => a.transferCount - b.transferCount || a.totalMinutes - b.totalMinutes);
    return list.sort((a, b) => a.totalMinutes - b.totalMinutes);
  }, [durationLimit, response, sort, transferLimit, walkingLimit]);
  const hasFilters = durationLimit !== 'any' || walkingLimit !== 'any' || transferLimit !== 'any';
  const totalOptions = response?.routes.length ?? 0;
  const sortLabels: Record<SortKey, string> = { fastest: 'Mais rápida', walking: 'Menos caminhada', transfers: 'Menos baldeações' };
  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? null;

  useEffect(() => {
    if (routes.length === 0) {
      if (selectedRouteId !== null) onSelectRoute(null);
    } else if (!routes.some((route) => route.id === selectedRouteId)) {
      onSelectRoute(routes[0]);
    }
  }, [onSelectRoute, routes, selectedRouteId]);

  return (
    <section className="result-section" aria-labelledby="transit-title" data-testid="transit-status">
      <div className="results-header">
        <div>
          <div className="results-title" id="transit-title">Rotas de transporte público</div>
          {totalOptions > 0 && <span className="results-caption" data-testid="text-route-count">{routes.length}{routes.length !== totalOptions ? ` de ${totalOptions}` : ''} {routes.length === 1 ? 'alternativa' : 'alternativas'} encontradas</span>}
        </div>
        {routes.length > 1 && (
          <label className="sort-control">
            <ArrowUpDown size={14} />
            <span className="sr-only">Ordenar rotas</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} data-testid="select-route-sort" aria-label="Ordenar rotas">
              <option value="fastest">Mais rápida</option>
              <option value="walking">Menos caminhada</option>
              <option value="transfers">Menos baldeações</option>
            </select>
          </label>
        )}
      </div>

      {totalOptions > 0 && (
        <div className="route-filters" aria-label="Filtros de rotas">
          <label className="route-filter">
            <span className="sr-only">Tempo total máximo</span>
            <select value={durationLimit} onChange={(event) => setDurationLimit(event.target.value as DurationLimit)} aria-label="Filtrar por tempo total" data-testid="select-filter-duration">
              <option value="any">Qualquer tempo</option>
              <option value="30">Até 30 min</option>
              <option value="60">Até 60 min</option>
            </select>
          </label>
          <label className="route-filter">
            <span className="sr-only">Caminhada máxima</span>
            <select value={walkingLimit} onChange={(event) => setWalkingLimit(event.target.value as WalkingLimit)} aria-label="Filtrar por caminhada" data-testid="select-filter-walking">
              <option value="any">Qualquer caminhada</option>
              <option value="10">Até 10 min a pé</option>
              <option value="20">Até 20 min a pé</option>
            </select>
          </label>
          <label className="route-filter">
            <span className="sr-only">Número máximo de baldeações</span>
            <select value={transferLimit} onChange={(event) => setTransferLimit(event.target.value as TransferLimit)} aria-label="Filtrar por baldeações" data-testid="select-filter-transfers">
              <option value="any">Qualquer baldeação</option>
              <option value="0">Sem baldeação</option>
              <option value="1">Até 1 baldeação</option>
            </select>
          </label>
          {hasFilters && <button type="button" className="clear-route-filters" onClick={() => { setDurationLimit('any'); setWalkingLimit('any'); setTransferLimit('any'); }} data-testid="button-clear-filters">Limpar filtros</button>}
        </div>
      )}

      {isLoading && (
        <div className="route-loading" role="status" data-testid="status-routes-loading">
          <div className="loading-skeleton" /><div className="loading-skeleton" />
          <span>Consultando horários e conexões disponíveis…</span>
          <span>A primeira busca pode levar cerca de meio minuto enquanto o GTFS oficial é carregado e preparado.</span>
        </div>
      )}
      {!isLoading && Boolean(error) && (
        <div className="route-message route-error" role="alert" data-testid="status-routes-error">
          <strong>A busca de rotas falhou.</strong>
          <span>{errorMessage(error)}</span>
          <button type="button" className="retry-button" onClick={onRetry} data-testid="button-retry-routes"><RefreshCw size={14} /> Tentar novamente</button>
        </div>
      )}
      {!isLoading && !error && !response && (
        <div className="route-message route-welcome" role="status" data-testid="status-routes-idle">
          <span className="route-welcome-icon"><RouteIcon size={18} /></span>
          <strong>Seu próximo trajeto começa aqui.</strong>
          <span>Escolha os endereços e consulte as opções disponíveis na base metropolitana ARTESP GTFS.</span>
        </div>
      )}
      {!isLoading && !error && response?.status === 'no_routes' && (
        <div className="route-message" role="status" data-testid="status-routes-empty">
          <strong>Nenhuma rota encontrada para este trajeto.</strong>
          <span>{response.message || 'Tente ajustar os endereços ou faça uma nova busca.'}</span>
        </div>
      )}
      {!isLoading && !error && totalOptions > 0 && routes.length === 0 && (
        <div className="route-message" role="status" data-testid="status-routes-filtered-empty">
          <strong>Nenhuma opção atende a estes filtros.</strong>
          <span>Amplie os limites ou limpe os filtros para ver todas as rotas encontradas.</span>
        </div>
      )}
      {!isLoading && !error && routes.length > 0 && (
        <div className="route-list" data-testid="list-routes">
          {routes.map((route, index) => (
            <button
              type="button"
              key={route.id}
              className={`route-option route-card ${route.id === selectedRouteId ? 'selected' : ''}`}
              aria-pressed={route.id === selectedRouteId}
              onClick={() => onSelectRoute(route)}
              data-testid={`card-route-${route.id}`}
            >
              <span className="route-glyph"><Bus size={18} /></span>
              <span className="route-card-main">
                <span className="route-card-topline">
                  <span className="route-name">{route.lineCodes.length ? route.lineCodes.join(' · ') : route.label}</span>
                  {route.recommended && <span className="recommended-tag">Recomendada</span>}
                  {index === 0 && !route.recommended && <span className="recommended-tag">Mais rápida</span>}
                </span>
                <span className="route-times">
                  <strong>{clockTime(route.departureAt)}</strong><ArrowDown size={12} /><strong>{clockTime(route.arrivalAt)}</strong>
                  <span>{route.totalMinutes} min</span>
                </span>
                <span className="route-places"><span><b>Embarque</b>{route.boardingStop.name}</span><span><b>Desembarque</b>{route.alightingStop.name}</span></span>
                {route.transferCount > 0 && (
                  <span className="route-transfer-list" data-testid={`text-route-legs-${route.id}`}>
                    {route.legs.filter((leg) => leg.mode === 'bus').map((leg, legIndex) => (
                      <span key={`${route.id}-leg-${legIndex}`}>
                        <b>Linha {leg.lineCode}</b> {leg.boardingStop?.name} → {leg.alightingStop?.name}
                      </span>
                    ))}
                  </span>
                )}
                <span className="route-stats">
                  <span><Footprints size={13} /> {route.walkingMinutes} min a pé</span>
                  <span><Bus size={13} /> {route.transitMinutes} min no ônibus</span>
                  <span><Clock3 size={13} /> {route.transferCount === 0 ? 'Sem baldeações' : `${route.transferCount} ${route.transferCount === 1 ? 'baldeação' : 'baldeações'}`}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {!isLoading && !error && selectedRoute && (
        <section className="journey-detail" aria-label="Detalhes da viagem selecionada" data-testid="journey-detail">
          <div className="journey-detail-heading">
            <div>
              <span className="journey-kicker">SUA VIAGEM, ETAPA POR ETAPA</span>
              <h3>Como chegar ao destino</h3>
            </div>
            <button type="button" className="journey-toggle" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen} aria-label={detailsOpen ? 'Recolher etapas' : 'Expandir etapas'}>
              {detailsOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
            </button>
          </div>
          <div className="next-instruction">
            <span className="next-instruction-icon"><Navigation size={19} /></span>
            <div className="next-instruction-copy">
              <span>PRIMEIRA ORIENTAÇÃO</span>
              {selectedRoute.legs[0]?.mode === 'walk' ? (
                <>
                  <strong>Caminhe até {selectedRoute.legs[0].to.label}</strong>
                  <small>{selectedRoute.legs[0].durationMinutes} min a pé{selectedRoute.legs[0].distanceMeters > 0 ? ` · ${selectedRoute.legs[0].distanceMeters >= 1000 ? `${(selectedRoute.legs[0].distanceMeters / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(selectedRoute.legs[0].distanceMeters)} m`}` : ''}</small>
                </>
              ) : (
                <><strong>Dirija-se ao ponto {selectedRoute.boardingStop.name}</strong><small>Confira o horário programado antes de embarcar.</small></>
              )}
            </div>
          </div>
          {detailsOpen && (
            <>
              <div className="journey-timeline">
                {selectedRoute.legs.map((leg, index) => {
                  const previousLeg = selectedRoute.legs[index - 1];
                  const previousArrival = previousLeg?.arrivalAt ? new Date(String(previousLeg.arrivalAt)).getTime() : null;
                  const legDeparture = leg.departureAt ? new Date(String(leg.departureAt)).getTime() : null;
                  const waitMinutes = previousArrival !== null && legDeparture !== null ? Math.max(0, Math.round((legDeparture - previousArrival) / 60000)) : 0;
                  const isWalk = leg.mode === 'walk';
                  return (
                    <div className="journey-timeline-group" key={`${selectedRoute.id}-step-${index}`}>
                      {waitMinutes > 0 && (
                        <div className="journey-step journey-wait-step">
                          <span className="journey-step-icon"><Timer size={15} /></span>
                          <div className="journey-step-content">
                            <strong>{index > 0 && previousLeg?.mode === 'bus' ? 'Aguarde a conexão' : 'Aguarde o ônibus'}</strong>
                            <span>{waitMinutes} min de espera programada · {previousLeg?.to.label ?? selectedRoute.boardingStop.name}</span>
                            {leg.departureAt && <small>Saída prevista: {clockTime(leg.departureAt)}</small>}
                          </div>
                        </div>
                      )}
                      <div className={`journey-step ${isWalk ? 'journey-walk-step' : 'journey-bus-step'}`}>
                        <span className="journey-step-icon">{isWalk ? <Footprints size={16} /> : <Bus size={16} />}</span>
                        <div className="journey-step-content">
                          <strong>{isWalk ? (index === selectedRoute.legs.length - 1 ? 'Caminhe até o destino' : 'Caminhe até o ponto') : `Pegue o ônibus ${leg.lineCode ?? ''}`}</strong>
                          {!isWalk && leg.headsign && <span className="journey-headsign">Sentido {leg.headsign}</span>}
                          <span>{leg.from.label} → {leg.to.label}</span>
                          <small>{leg.durationMinutes} min · {isWalk ? (leg.distanceMeters >= 1000 ? `${(leg.distanceMeters / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(leg.distanceMeters)} m`) : 'no transporte público'}</small>
                          {!isWalk && <small>Embarque: {clockTime(leg.departureAt)} · Desembarque: {clockTime(leg.arrivalAt)}</small>}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="journey-destination"><MapPin size={16} /><span>Você chega ao destino</span><strong>{clockTime(selectedRoute.arrivalAt)}</strong></div>
              </div>
              <div className="journey-totals">
                <div><strong>{selectedRoute.totalMinutes} min</strong><span>tempo total</span></div>
                <div><strong>{selectedRoute.walkingMinutes} min</strong><span>caminhando</span></div>
                <div><strong>{selectedRoute.transferCount}</strong><span>{selectedRoute.transferCount === 1 ? 'baldeação' : 'baldeações'}</span></div>
              </div>
              <p className="journey-schedule-note">Os horários e esperas são calculados a partir da tabela GTFS disponível. O VAI ainda não acompanha a posição do ônibus em tempo real.</p>
            </>
          )}
        </section>
      )}

      {response && (
        <div className="route-source" data-testid="text-route-source">
          <strong>Fonte: <a href={response.source.url} target="_blank" rel="noreferrer" data-testid="link-transit-source">ARTESP · GTFS metropolitano</a></strong>
          <span>{response.source.name} · versão {response.source.version} · licença {response.source.license}</span>
          {response.source.updatedAt && <span>Atualizado em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(String(response.source.updatedAt)))}</span>}
          <span>{response.source.coverage}</span>
          <span>Horários programados da base estática; não são previsões em tempo real.</span>
          {response.source.limitations.map((limitation, index) => <span key={`${index}-${limitation}`} className="source-limitation">{limitation}</span>)}
          <span className="coverage-warning">Esta base metropolitana não representa todas as linhas municipais de Barueri.</span>
        </div>
      )}
    </section>
  );
}
