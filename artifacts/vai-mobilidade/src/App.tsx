import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useSearchTransitRoutes, type TransitRouteOption } from '@workspace/api-client-react';
import { BrandHeader } from './components/BrandHeader';
import { JourneyPlanner } from './components/JourneyPlanner';
import { MapCanvas } from './components/MapCanvas';
import { RouteResults } from './components/RouteResults';
import type { Place } from './types/route';

function App() {
  const [origin, setOrigin] = useState<Place>({ label: '' });
  const [destination, setDestination] = useState<Place>({ label: '' });
  const [centerSignal, setCenterSignal] = useState(0);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);
  const searchRoutes = useSearchTransitRoutes();
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const response = searchRoutes.data;
  const selectedRoute = response?.routes.find((route) => route.id === selectedRouteId) ?? null;

  useEffect(() => {
    setSelectedRouteId(response?.routes.find((route) => route.recommended)?.id ?? response?.routes[0]?.id ?? null);
  }, [response]);

  const runSearch = () => {
    if (!origin.coordinates || !destination.coordinates) return;
    searchRoutes.reset();
    setSelectedRouteId(null);
    searchRoutes.mutate({
      data: {
        origin: { label: origin.label, coordinates: origin.coordinates },
        destination: { label: destination.label, coordinates: destination.coordinates },
      },
    });
    setCenterSignal((value) => value + 1);
  };

  const updatePlace = (field: 'origin' | 'destination', place: Place) => {
    searchRoutes.reset();
    setSelectedRouteId(null);
    if (field === 'origin') setOrigin(place);
    else setDestination(place);
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
            isSearching={searchRoutes.isPending}
          />
          <div className="map-column">
            <MapCanvas origin={origin} destination={destination} centerSignal={centerSignal} selectedRoute={selectedRoute} />
            <RouteResults
              response={response}
              selectedRouteId={selectedRoute?.id ?? null}
              onSelectRoute={(route: TransitRouteOption | null) => setSelectedRouteId(route?.id ?? null)}
              isLoading={searchRoutes.isPending}
              error={searchRoutes.error}
              onRetry={runSearch}
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
