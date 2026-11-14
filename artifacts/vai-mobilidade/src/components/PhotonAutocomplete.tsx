import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { LoaderCircle, MapPin, Navigation, X } from 'lucide-react';
import type { Place } from '../types/route';

type PhotonFeature = {
  type: 'Feature';
  geometry: { type: string; coordinates: [number, number] };
  properties: Record<string, unknown>;
};

type PhotonAutocompleteProps = {
  id: string;
  label: string;
  placeholder: string;
  value: Place;
  icon: 'origin' | 'destination';
  invalid?: boolean;
  onChange: (place: Place) => void;
};

function propertyText(properties: Record<string, unknown>, key: string): string {
  const value = properties[key];
  return typeof value === 'string' ? value.trim() : '';
}

function photonLabel(properties: Record<string, unknown>): string {
  const street = propertyText(properties, 'street');
  const houseNumber = propertyText(properties, 'housenumber');
  const name = propertyText(properties, 'name');
  // If Photon supplies a street address, show it first instead of the POI
  // name (which may be a station, plaza or other nearby landmark).
  const primary = street
    ? [street, houseNumber].filter(Boolean).join(', ')
    : name || houseNumber;
  const locality = [
    propertyText(properties, 'district'),
    propertyText(properties, 'city') || propertyText(properties, 'locality'),
    propertyText(properties, 'state'),
    propertyText(properties, 'postcode'),
  ];
  return [...new Set([primary, ...locality].filter(Boolean))].join(', ');
}

function photonRelevance(properties: Record<string, unknown>, query: string): number {
  const street = propertyText(properties, 'street');
  const houseNumber = propertyText(properties, 'housenumber');
  const hasNumberAtEnd = /(?:,|\\s)\\d{1,5}\\s*$/.test(query.trim());
  let score = 0;
  if (street) score += 5;
  if (street && houseNumber) score += 5;
  if (hasNumberAtEnd && houseNumber) score += 8;
  if (hasNumberAtEnd && !houseNumber) score -= 8;
  if (!street && propertyText(properties, 'name')) score -= hasNumberAtEnd ? 5 : 0;
  return score;
}

export function PhotonAutocomplete({ id, label, placeholder, value, icon, invalid, onChange }: PhotonAutocompleteProps) {
  const [query, setQuery] = useState(value.label);
  const [results, setResults] = useState<Array<{ label: string; place: Place }>>([]);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setQuery(value.label);
  }, [value.label]);

  useEffect(() => {
    const term = query.trim();
    abortRef.current?.abort();
    setResults([]);
    setRequestError('');
    if (term.length < 3 || (term === value.label && Boolean(value.coordinates))) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q: term, lat: '-23.5113', lon: '-46.8765', zoom: '12', limit: '6', countrycode: 'br',
        });
        const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Não foi possível consultar endereços agora.');
        const collection = await response.json() as { features?: PhotonFeature[] };
        const mapped = (collection.features ?? []).flatMap((feature) => {
          const properties = feature.properties ?? {};
          const resultLabel = photonLabel(properties);
          const coordinates = feature.geometry?.coordinates;
          if (!resultLabel || !Array.isArray(coordinates) || coordinates.length < 2) return [];
          const [longitude, latitude] = coordinates;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
          return [{
            label: resultLabel,
            place: { label: resultLabel, coordinates: { latitude, longitude } },
            relevance: photonRelevance(properties, term),
          }];
        }).sort((left, right) => right.relevance - left.relevance);
        setResults(mapped);
        setOpen(true);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // Mensagem amigável ao usuário; o erro técnico vai para o console.
        console.error('Falha na busca de endereços', error);
        setRequestError(
          error instanceof TypeError
            ? 'Não foi possível buscar endereços. Verifique sua conexão.'
            : 'A busca de endereços está indisponível agora. Tente novamente.',
        );
        setOpen(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, value.label]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setQuery(next);
    setOpen(true);
    onChange({ label: next });
  };

  const selectResult = (place: Place) => {
    setQuery(place.label);
    setOpen(false);
    setResults([]);
    onChange(place);
  };

  const Icon = icon === 'origin' ? MapPin : Navigation;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="autocomplete-wrap">
        <div className="input-wrap">
          <Icon className="field-icon" size={17} />
          <input
            id={id}
            value={query}
            onChange={handleChange}
            onFocus={() => { if (query.trim().length >= 3 && !value.coordinates) setOpen(true); }}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            placeholder={placeholder}
            aria-invalid={Boolean(invalid)}
            aria-autocomplete="list"
            aria-expanded={open && query.trim().length >= 3}
            aria-controls={`${id}-results`}
            data-testid={`input-${icon}`}
          />
          {loading && <LoaderCircle className="field-clear" size={16} aria-label="Buscando endereços" data-testid={`status-${icon}-loading`} />}
          {!loading && query && (
            <button type="button" className="field-clear" aria-label={`Limpar ${icon === 'origin' ? 'origem' : 'destino'}`} onClick={() => { setQuery(''); setOpen(false); onChange({ label: '' }); }} data-testid={`button-clear-${icon}`}>
              <X size={15} />
            </button>
          )}
        </div>
        {open && query.trim().length >= 3 && (
          <div className="autocomplete-results" id={`${id}-results`} role="listbox" data-testid={`${icon}-autocomplete-results`}>
            {loading && <div className="autocomplete-status" role="status" data-testid={`status-${icon}-loading-text`}>Buscando endereços…</div>}
            {!loading && requestError && <div className="autocomplete-status" role="alert" data-testid={`status-${icon}-error`}>{requestError}</div>}
            {!loading && !requestError && results.length === 0 && <div className="autocomplete-status" role="status" data-testid={`status-${icon}-empty`}>Nenhum endereço encontrado. Tente outro termo.</div>}
            {!loading && !requestError && results.map((result, index) => (
              <button type="button" role="option" aria-selected={false} key={`${result.label}-${index}`} className="autocomplete-option" onMouseDown={(event) => event.preventDefault()} onClick={() => selectResult(result.place)} data-testid={`option-${icon}-${index}`}>
                {result.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
