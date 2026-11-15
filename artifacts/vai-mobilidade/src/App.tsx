import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { searchTransitRoutes, type TransitRouteOption, type TransitRouteSearchResponse } from '@workspace/api-client-react';
import { BrandHeader } from './components/BrandHeader';
import { JourneyPlanner } from './components/JourneyPlanner';
import { MapCanvas } from './components/MapCanvas';
import { RouteResults } from './components/RouteResults';
import type { UserLocation } from './components/map/UserLocationLayer';
import type { Place } from './types/route';

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; response: TransitRouteSearchResponse }
  | { status: 'error'; error: unknown };

function App() {
  const [origin, setOrigin] = useState<Place>({ label: '' });
  const [destination, setDestination] = useState<Place>({ label: '' });
  const [centerSignal, setCenterSignal] = useState(0);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>({ status: 'idle' });
  const searchAbortRef = useRef<AbortController | null>(null);
  const apiWarmupRef = useRef<Promise<void>>(Promise.resolve());
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  // Índice da etapa escolhida na linha do tempo; null mostra a viagem inteira.
  const [selectedLegIndex, setSelectedLegIndex] = useState<number | null>(null);
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const response = searchState.status === 'success' ? searchState.response : undefined;
  const isSearching = searchState.status === 'loading';
  const searchError = searchState.status === 'error' ? searchState.error : null;
  const selectedRoute = response?.routes.find((route) => route.id === selectedRouteId) ?? null;

  useEffect(() => {
    const controller = new AbortController();
    const apiBaseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
    const warmApi = () => {
      apiWarmupRef.current = fetch(`${apiBaseUrl}/api/healthz`, {
        cache: 'no-store',
        signal: controller.signal,
      }).then(() => undefined).catch(() => undefined);
    };
    // Wake the free API before the user searches and keep it warm while the
    // app stays open; returning to the foreground also refreshes the ping.
    warmApi();
    const interval = window.setInterval(warmApi, 10 * 60 * 1_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') warmApi();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      controller.abort();
      searchAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    let active = true;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!active) return;
        const heading = position.coords.heading;
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          heading: typeof heading === "number" && Number.isFinite(heading) ? heading : null,
        });
      },
      () => {
        // Sem permissão de localização, o mapa continua disponível e pode ser movido manualmente.
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setSelectedRouteId(response?.routes.find((route) => route.recommended)?.id ?? response?.routes[0]?.id ?? null);
    setSelectedLegIndex(null);
  }, [response]);

  const selectRoute = (route: TransitRouteOption | null) => {
    setSelectedRouteId(route?.id ?? null);
    setSelectedLegIndex(null);
  };

  const cancelSearch = () => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setSearchState({ status: 'idle' });
  };

  const runSearch = async () => {
    if (!origin.coordinates || !destination.coordinates) return;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    let searchTimedOut = false;
    let timeout: number | undefined;
    setSearchState({ status: 'loading' });
    setSelectedRouteId(null);
    setCenterSignal((value) => value + 1);
    try {
      // Wait for the page-load health ping to finish waking the free API
      // before starting the route calculation deadline.
      await apiWarmupRef.current;
      if (controller.signal.aborted) return;
      timeout = window.setTimeout(() => {
        searchTimedOut = true;
        controller.abort(new DOMException('A busca excedeu o limite de 25 segundos.', 'TimeoutError'));
      }, 25_000);
      const searchResponse = await searchTransitRoutes({
        origin: { label: origin.label, coordinates: origin.coordinates },
        destination: { label: destination.label, coordinates: destination.coordinates },
      }, { signal: controller.signal });
      if (!controller.signal.aborted) setSearchState({ status: 'success', response: searchResponse });
    } catch (error) {
      if (searchTimedOut) {
        setSearchState({
          status: 'error',
          error: new DOMException('O serviço de rotas não respondeu dentro do limite de 25 segundos.', 'TimeoutError'),
        });
      } else if (!controller.signal.aborted) {
        setSearchState({ status: 'error', error });
      }
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (searchAbortRef.current === controller) searchAbortRef.current = null;
    }
  };

  const updatePlace = (field: 'origin' | 'destination', place: Place) => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setSearchState({ status: 'idle' });
    setSelectedRouteId(null);
    if (field === 'origin') setOrigin(place);
    else setDestination(place);
  };

  const locateMapOnly = () => {
    setLocationError('');
    if (!('geolocation' in navigator)) {
      setLocationError('Este navegador não disponibiliza localização.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const heading = position.coords.heading;
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          heading: typeof heading === 'number' && Number.isFinite(heading) ? heading : null,
        });
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) setLocationError('Permita o acesso à localização para encontrar pontos próximos.');
        else setLocationError('Não foi possível localizar você agora. Tente novamente.');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  const requestCurrentLocation = (onSuccess: (place: Place) => void) => {
    setLocationError('');
    if (!('geolocation' in navigator)) {
      setLocationError('Este navegador não disponibiliza localização. Digite sua origem manualmente.');
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        setLocationError('');
        // O rumo só é usado quando o navegador informa um valor numérico válido.
        const heading = position.coords.heading;
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          heading: typeof heading === 'number' && Number.isFinite(heading) ? heading : null,
        });
        onSuccess({
          label: 'Minha localização atual',
          coordinates: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          },
        });
      },
      (error) => {
        setIsLocating(false);
        if (error.code === error.PERMISSION_DENIED) {
          setLocationError('Acesso à localização negado. Permita o acesso no navegador ou informe a origem manualmente.');
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          setLocationError('Localização indisponível no momento. Tente novamente ou informe a origem manualmente.');
        } else if (error.code === error.TIMEOUT) {
          setLocationError('A busca da localização demorou demais. Tente novamente ou digite sua origem.');
        } else {
          setLocationError('Não foi possível obter sua localização. Digite a origem manualmente.');
        }
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };

  return (
    <div className="app-shell">
      <BrandHeader onAbout={() => setAboutOpen(true)} />
      <main className="page">
        <div className="intro">
          <div>
            <div className="eyebrow">Mobilidade que acompanha você</div>
            <h1>Como você vai hoje?</h1>
            <p>Encontre endereços e localize seus pontos em Barueri.</p>
          </div>
          <div className="demo-pill"><span className="status-dot" /> MAPA OPENSTREETMAP</div>
        </div>

        <div className="workspace">
          <JourneyPlanner
            origin={origin}
            destination={destination}
            onPlaceChange={updatePlace}
            onSearch={runSearch}
            onLocate={requestCurrentLocation}
            isLocating={isLocating}
            locationError={locationError}
            isSearching={isSearching}
          />
          <div className="map-column">
            <MapCanvas
              origin={origin}
              destination={destination}
              centerSignal={centerSignal}
              selectedRoute={selectedRoute}
              selectedLegIndex={selectedLegIndex}
              userLocation={userLocation}
              onLocate={locateMapOnly}
            />
            <RouteResults
              response={response}
              selectedRouteId={selectedRoute?.id ?? null}
              onSelectRoute={selectRoute}
              selectedLegIndex={selectedLegIndex}
              onSelectLeg={setSelectedLegIndex}
              isLoading={isSearching}
              error={searchError}
              onRetry={runSearch}
              onCancel={cancelSearch}
            />
          </div>
        </div>
      </main>

      {aboutOpen && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setAboutOpen(false)}>
          <section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="dialog-close" aria-label="Fechar informações" onClick={() => setAboutOpen(false)} data-testid="button-close-about"><X size={18} /></button>
            <div className="eyebrow">VAI · Barueri</div>
            <h2 id="about-title">Mobilidade, com transparência.</h2>
            <p>O mapa usa dados do OpenStreetMap e a busca de endereços usa o serviço público Photon. As rotas vêm do GTFS metropolitano publicado pela ARTESP.</p>
            <div className="about-list">
              <span><strong>Mapa</strong> — tiles OpenStreetMap e atribuição visível aos contribuidores.</span>
              <span><strong>Transporte</strong> — horários programados do GTFS metropolitano ARTESP; não representa todas as linhas municipais nem inclui previsão em tempo real.</span>
              <span><strong>Caminhada</strong> — o serviço público FOSSGIS calcula percursos a pé com dados OSM e recebe as coordenadas necessárias ao trajeto.</span>
              <span><strong>Localização</strong> — depende da permissão do navegador e da disponibilidade do dispositivo.</span>
            </div>
            <button type="button" className="primary-action" onClick={() => setAboutOpen(false)} data-testid="button-understand-demo">Entendi</button>
          </section>
        </div>
      )}
      <style>{`
        .dialog-backdrop { position:fixed; inset:0; z-index:20; padding:20px; background:#142b43a6; display:grid; place-items:center; }
        .about-dialog { position:relative; width:min(470px,100%); padding:30px; border-radius:19px; background:hsl(var(--card)); box-shadow:0 18px 70px #102a4638; }
        .about-dialog h2 { margin:12px 36px 10px 0; color:#193451; font:800 24px/1.2 var(--font-display); letter-spacing:-.8px; }
        .about-dialog p { color:#667789; font-size:13px; line-height:1.65; }
        .about-list { display:grid; gap:10px; padding:14px; margin:18px 0; border-radius:12px; background:#f4f7f1; color:#5e6d77; font-size:11px; line-height:1.5; }
        .about-list strong { color:#314b32; }
        .dialog-close { position:absolute; top:17px; right:17px; width:34px; height:34px; border:0; border-radius:50%; background:#f1f4f5; color:#516575; display:grid; place-items:center; }
        .about-dialog .primary-action { width:100%; margin-top:10px; }
      `}</style>
    </div>
  );
}

export default App;
