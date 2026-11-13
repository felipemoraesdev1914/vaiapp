import { useState, type FormEvent } from 'react';
import { AlertCircle, ArrowDownUp, LocateFixed, Navigation } from 'lucide-react';
import type { Place } from '../types/route';
import { PhotonAutocomplete } from './PhotonAutocomplete';

type JourneyPlannerProps = {
  origin: Place;
  destination: Place;
  onPlaceChange: (field: 'origin' | 'destination', place: Place) => void;
  onSearch: () => void;
  onLocate: (callback: (place: Place) => void) => void;
  isLocating: boolean;
  locationError: string;
  isSearching: boolean;
};

export function JourneyPlanner({ origin, destination, onPlaceChange, onSearch, onLocate, isLocating, locationError, isSearching }: JourneyPlannerProps) {
  const [error, setError] = useState('');
  const [locationMessage, setLocationMessage] = useState('');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!origin.coordinates || !destination.coordinates) {
      setError('Escolha uma origem e um destino na lista de endereços para buscar rotas.');
      return;
    }
    setError('');
    setLocationMessage('');
    onSearch();
  };

  const requestLocation = () => {
    setLocationMessage('');
    onLocate((place) => {
      onPlaceChange('origin', place);
      setError('');
      setLocationMessage('Localização atual adicionada como origem.');
    });
  };

  const swapPlaces = () => {
    onPlaceChange('origin', destination);
    onPlaceChange('destination', origin);
    setError('');
  };

  return (
    <section className="planner-panel" aria-labelledby="planner-title">
      <div className="panel-heading">
        <h2 id="planner-title">Planeje seu caminho</h2>
        <span className="small-label">Barueri · SP</span>
      </div>
      <form onSubmit={handleSubmit} noValidate>
        <div className="fields">
          <PhotonAutocomplete
            id="origin-input"
            label="DE ONDE VOCÊ SAI?"
            placeholder="Digite um endereço"
            value={origin}
            icon="origin"
            invalid={Boolean(error && !origin.coordinates)}
            onChange={(place) => { onPlaceChange('origin', place); setError(''); }}
          />
          <button className="swap-button" type="button" aria-label="Inverter origem e destino" title="Inverter origem e destino" onClick={swapPlaces} data-testid="button-swap-places"><ArrowDownUp size={15} /></button>
          <PhotonAutocomplete
            id="destination-input"
            label="PARA ONDE VOCÊ VAI?"
            placeholder="Digite um destino"
            value={destination}
            icon="destination"
            invalid={Boolean(error && !destination.coordinates)}
            onChange={(place) => { onPlaceChange('destination', place); setError(''); }}
          />
        </div>

        <button className="location-button" type="button" onClick={requestLocation} disabled={isLocating} data-testid="button-use-location">
          <LocateFixed size={16} />
          {isLocating ? 'Buscando localização…' : 'Usar minha localização atual'}
        </button>
        {error && <div className="notice error" role="alert" data-testid="status-validation-error"><AlertCircle size={15} />{error}</div>}
        {locationError && <div className="notice error" role="status" data-testid="status-location-error"><AlertCircle size={15} />{locationError}</div>}
        {locationMessage && <div className="notice" role="status" data-testid="status-location-success">{locationMessage}</div>}

        <button className="primary-action" type="submit" disabled={!origin.coordinates || !destination.coordinates || isSearching} data-testid="button-show-points">
          {isSearching ? 'Buscando rotas…' : 'Encontrar melhor rota'} {!isSearching && <Navigation size={15} />}
        </button>
      </form>

      <p className="data-footnote">Rotas baseadas apenas no GTFS metropolitano ARTESP. A base não representa todas as linhas municipais de Barueri.</p>
    </section>
  );
}
