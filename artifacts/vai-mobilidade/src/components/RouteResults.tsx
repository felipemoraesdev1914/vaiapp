import { ArrowRight, ArrowUpDown, Bus, Footprints, RefreshCw, Route as RouteIcon, ChevronDown, ChevronUp } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { TransitRouteOption, TransitRouteSearchResponse } from '@workspace/api-client-react';
import { TripStatus } from './TripStatus';
import { JourneyTimeline } from './JourneyTimeline';
import { clockTime, formatDuration, tripStart } from './format';

// Quantidade de alternativas exibidas antes de o usuário expandir a lista.
const INITIAL_ROUTE_COUNT = 3;

type SortKey = 'fastest' | 'walking' | 'transfers';
type DurationLimit = 'any' | '30' | '60';
type WalkingLimit = 'any' | '10' | '20';
type TransferLimit = 'any' | '0' | '1';

type RouteResultsProps = {
  response?: TransitRouteSearchResponse;
  selectedRouteId: string | null;
  onSelectRoute: (route: TransitRouteOption | null) => void;
  selectedLegIndex: number | null;
  onSelectLeg: (index: number | null) => void;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
};

// Mensagens ao usuário em português. Detalhes técnicos ficam no console e nos logs do servidor.
function errorMessage(error: unknown) {
  // Erro HTTP da API: usa a mensagem amigável enviada pelo backend, se houver.
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    const data = 'data' in error ? (error as { data?: unknown }).data : undefined;
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error;
    if (error.status === 400) return 'Confira a origem e o destino e tente novamente.';
    return 'O serviço de rotas está indisponível agora. Tente novamente em instantes.';
  }
  // Falha de rede (sem resposta do servidor).
  if (error instanceof TypeError) return 'Não foi possível conectar ao VAI. Verifique sua conexão e tente novamente.';
  console.error('Falha inesperada na busca de rotas', error);
  return 'Não foi possível consultar as rotas agora. Tente novamente.';
}

export function RouteResults({ response, selectedRouteId, onSelectRoute, selectedLegIndex, onSelectLeg, isLoading, error, onRetry }: RouteResultsProps) {
  const [sort, setSort] = useState<SortKey>('fastest');
  const [durationLimit, setDurationLimit] = useState<DurationLimit>('any');
  const [walkingLimit, setWalkingLimit] = useState<WalkingLimit>('any');
  const [transferLimit, setTransferLimit] = useState<TransferLimit>('any');
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
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
  const visibleRoutes = showAllRoutes ? routes : routes.slice(0, INITIAL_ROUTE_COUNT);
  const hiddenRouteCount = routes.length - visibleRoutes.length;

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
          <TripStatus route={selectedRoute} />
          {detailsOpen && (
            <>
              <JourneyTimeline route={selectedRoute} selectedLegIndex={selectedLegIndex} onSelectLeg={onSelectLeg} />
              {selectedLegIndex !== null && (
                <button type="button" className="journey-reset" onClick={() => onSelectLeg(null)} data-testid="button-show-full-trip">Mostrar a viagem inteira no mapa</button>
              )}
            </>
          )}
        </section>
      )}

      {!isLoading && !error && routes.length > 0 && (
        <>
          <div className="route-list" data-testid="list-routes">
            {visibleRoutes.map((route) => {
              const isSelected = route.id === selectedRouteId;
              const transferText = route.transferCount === 0
                ? 'Sem baldeação'
                : `${route.transferCount} ${route.transferCount === 1 ? 'baldeação' : 'baldeações'}`;
              return (
                <button
                  type="button"
                  key={route.id}
                  className={`rc-card ${isSelected ? 'is-selected' : ''} ${route.recommended ? 'is-recommended' : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelectRoute(route)}
                  data-testid={`card-route-${route.id}`}
                >
                  <span className="rc-top">
                    <span className="rc-times">
                      <strong>{clockTime(tripStart(route))}</strong>
                      <ArrowRight size={13} aria-hidden="true" />
                      <strong>{clockTime(route.arrivalAt)}</strong>
                    </span>
                    <span className="rc-duration">{formatDuration(route.totalMinutes)}</span>
                  </span>
                  <span className="rc-lines" data-testid={`text-route-legs-${route.id}`}>
                    {route.lineCodes.map((code, index) => (
                      <Fragment key={`${route.id}-line-${index}`}>
                        {index > 0 && <ArrowRight size={12} aria-hidden="true" className="rc-arrow" />}
                        <span className="rc-line">{code}</span>
                      </Fragment>
                    ))}
                  </span>
                  <span className="rc-boarding">
                    Embarque às {clockTime(route.departureAt)} em {route.boardingStop.name}
                  </span>
                  <span className="rc-meta">
                    <span><Footprints size={12} aria-hidden="true" /> {route.walkingMinutes} min a pé</span>
                    <span>{transferText}</span>
                    {route.recommended && <span className="rc-recommended">Recomendada</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {routes.length > INITIAL_ROUTE_COUNT && (
            <button
              type="button"
              className="rc-more"
              aria-expanded={showAllRoutes}
              onClick={() => setShowAllRoutes((open) => !open)}
              data-testid="button-toggle-routes"
            >
              {showAllRoutes
                ? 'Mostrar menos opções'
                : `Ver mais ${hiddenRouteCount} ${hiddenRouteCount === 1 ? 'opção' : 'opções'}`}
            </button>
          )}
        </>
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
