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

function photonLabel(properties: Record<string, unknown>): string {
  const parts = [
    properties.name,
    properties.street,
    properties.housenumber,
    properties.city,
    properties.district,
    properties.state,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return [...new Set(parts)].join(', ');
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
          const resultLabel = photonLabel(feature.properties ?? {});
          const coordinates = feature.geometry?.coordinates;
          if (!resultLabel || !Array.isArray(coordinates) || coordinates.length < 2) return [];
          const [longitude, latitude] = coordinates;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
          return [{ label: resultLabel, place: { label: resultLabel, coordinates: { latitude, longitude } } }];
        });
        setResults(mapped);
        setOpen(true);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRequestError(error instanceof Error ? error.message : 'Falha ao buscar endereços.');
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
