import { useEffect, useMemo, useState } from 'react';
import { divIcon, latLngBounds, type LatLngExpression, type Map as LeafletMap } from 'leaflet';
import { LocateFixed, MapPin, Minus, Plus } from 'lucide-react';
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import type { Place } from '../types/route';
import type { TransitRouteOption } from '@workspace/api-client-react';

type MapCanvasProps = {
  origin?: Place;
  destination?: Place;
  centerSignal: number;
  selectedRoute?: TransitRouteOption | null;
};

const INITIAL_CENTER: [number, number] = [-23.5113, -46.8765];

function createMarkerIcon(kind: 'origin' | 'destination') {
  const html = kind === 'origin'
    ? '<span class="vai-marker vai-marker-origin">A</span>'
    : '<span class="vai-marker vai-marker-destination">B</span>';
  return divIcon({ className: '', html, iconSize: [34, 42], iconAnchor: [17, 38] });
}

function MapActions({ origin, destination, centerSignal, selectedRoute }: MapCanvasProps) {
  const map = useMap();
  const originLatitude = origin?.coordinates?.latitude;
  const originLongitude = origin?.coordinates?.longitude;
  const destinationLatitude = destination?.coordinates?.latitude;
  const destinationLongitude = destination?.coordinates?.longitude;
  const points = useMemo(() => {
    const routePoints = selectedRoute?.legs.flatMap((leg) => leg.geometry.map((point) => [point.latitude, point.longitude] as [number, number])) ?? [];
    if (routePoints.length > 1) return routePoints;
    const candidates = [
      originLatitude !== undefined && originLongitude !== undefined
        ? [originLatitude, originLongitude] as [number, number]
        : undefined,
      destinationLatitude !== undefined && destinationLongitude !== undefined
        ? [destinationLatitude, destinationLongitude] as [number, number]
        : undefined,
    ];
    return candidates.filter((point): point is [number, number] => point !== undefined);
  }, [destinationLatitude, destinationLongitude, originLatitude, originLongitude, selectedRoute]);

  const focusPoints = () => {
    if (points.length > 1) map.fitBounds(latLngBounds(points), { padding: [54, 54], maxZoom: 15 });
    else if (points.length === 1) map.setView(points[0], 15);
    else map.setView(INITIAL_CENTER, 13);
  };

  useEffect(() => {
    focusPoints();
  }, [map, points]);

  useEffect(() => {
    if (centerSignal > 0) focusPoints();
  }, [centerSignal, map, points]);

  return null;
}

function MapControls({ onCenter }: { onCenter: () => void }) {
  const map: LeafletMap = useMap();
  return (
    <div className="map-controls" aria-label="Controles do mapa">
      <button className="map-control" type="button" aria-label="Aumentar zoom" title="Aumentar zoom" onClick={() => map.zoomIn()} data-testid="button-map-zoom-in"><Plus size={17} /></button>
      <button className="map-control" type="button" aria-label="Diminuir zoom" title="Diminuir zoom" onClick={() => map.zoomOut()} data-testid="button-map-zoom-out"><Minus size={17} /></button>
      <button className="map-control" type="button" aria-label="Centralizar mapa" title="Centralizar mapa" onClick={onCenter} data-testid="button-map-center"><LocateFixed size={16} /></button>
    </div>
  );
}

function busStopIcon() {
  return divIcon({
    className: '',
    html: '<span class="vai-stop-marker" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6m8-6v6M4 12h16M6 18h12M6 18v2m12-2v2M6 4h12a2 2 0 0 1 2 2v10H4V6a2 2 0 0 1 2-2Z"/><path d="M7 15h.01M17 15h.01"/></svg></span>',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export function MapCanvas({ origin, destination, centerSignal, selectedRoute }: MapCanvasProps) {
  const [localCenterSignal, setLocalCenterSignal] = useState(0);
  const signal = centerSignal + localCenterSignal;
  const originPosition = origin?.coordinates ? [origin.coordinates.latitude, origin.coordinates.longitude] as [number, number] : undefined;
  const destinationPosition = destination?.coordinates ? [destination.coordinates.latitude, destination.coordinates.longitude] as [number, number] : undefined;
  return (
    <section className="map-frame" aria-label="Mapa de Barueri" data-testid="map-frame">
      <MapContainer className="leaflet-map" center={INITIAL_CENTER} zoom={13} zoomControl={false} scrollWheelZoom>
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>'
        />
        {selectedRoute?.legs.map((leg, index) => {
          const positions = leg.geometry.map((point) => [point.latitude, point.longitude] as LatLngExpression);
          return positions.length > 1 ? <Polyline key={`${selectedRoute.id}-leg-${index}`} positions={positions} pathOptions={{ color: 'hsl(77, 86%, 55%)', weight: leg.mode === 'bus' ? 6 : 4, opacity: leg.mode === 'bus' ? 0.95 : 0.78, dashArray: leg.mode === 'walk' ? '7 8' : undefined }} /> : null;
        })}
        {selectedRoute?.legs.flatMap((leg, index) => leg.mode === 'bus' ? [
          <Marker key={`${selectedRoute.id}-boarding-${index}`} position={[leg.from.coordinates.latitude, leg.from.coordinates.longitude]} icon={busStopIcon()} title={`Parada de embarque: ${leg.boardingStop?.name ?? leg.from.label}`} />,
          <Marker key={`${selectedRoute.id}-alighting-${index}`} position={[leg.to.coordinates.latitude, leg.to.coordinates.longitude]} icon={busStopIcon()} title={`Parada de desembarque: ${leg.alightingStop?.name ?? leg.to.label}`} />,
        ] : [])}
        {originPosition && <Marker position={originPosition} icon={createMarkerIcon('origin')} title="Origem" />}
        {destinationPosition && <Marker position={destinationPosition} icon={createMarkerIcon('destination')} title="Destino" />}
        <MapActions origin={origin} destination={destination} centerSignal={signal} selectedRoute={selectedRoute} />
        <MapControls onCenter={() => setLocalCenterSignal((value) => value + 1)} />
      </MapContainer>
      <div className="map-badge"><MapPin size={14} /> MAPA DE BARUERI</div>
      <span className="map-attribution" data-testid="text-map-attribution">
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      </span>
    </section>
  );
}
