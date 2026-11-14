import { useEffect, useMemo, useState } from 'react';
import { latLngBounds, type LatLngExpression, type Map as LeafletMap } from 'leaflet';
import { MapPin } from 'lucide-react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import type { Place } from '../types/route';
import type { TransitRouteOption } from '@workspace/api-client-react';
import { placeIcon } from './map/markers';
import { RouteLayers, RouteStops } from './map/RouteLayers';
import { MapControls } from './map/MapControls';
import { UserLocationLayer, type UserLocation } from './map/UserLocationLayer';

type MapCanvasProps = {
  origin?: Place;
  destination?: Place;
  centerSignal: number;
  selectedRoute?: TransitRouteOption | null;
  selectedLegIndex?: number | null;
  userLocation?: UserLocation | null;
};

const INITIAL_CENTER: [number, number] = [-23.5113, -46.8765];
const FIT_PADDING: [number, number] = [54, 54];

function legPoints(leg: TransitRouteOption['legs'][number]): LatLngExpression[] {
  return leg.geometry.map((point) => [point.latitude, point.longitude] as LatLngExpression);
}

function MapActions({ origin, destination, centerSignal, selectedRoute, selectedLegIndex }: MapCanvasProps) {
  const map = useMap();
  const originLatitude = origin?.coordinates?.latitude;
  const originLongitude = origin?.coordinates?.longitude;
  const destinationLatitude = destination?.coordinates?.latitude;
  const destinationLongitude = destination?.coordinates?.longitude;
  const points = useMemo(() => {
    const routePoints = selectedRoute?.legs.flatMap((leg) => legPoints(leg)) ?? [];
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
    if (points.length > 1) map.fitBounds(latLngBounds(points), { padding: FIT_PADDING, maxZoom: 15 });
    else if (points.length === 1) map.setView(points[0], 15);
    else map.setView(INITIAL_CENTER, 13);
  };

  useEffect(() => {
    focusPoints();
  }, [map, points]);

  useEffect(() => {
    if (centerSignal > 0) focusPoints();
  }, [centerSignal, map, points]);

  // Ao selecionar uma etapa na linha do tempo, a câmera acompanha o trecho correspondente.
  useEffect(() => {
    if (selectedRoute == null || selectedLegIndex == null) return;
    const leg = selectedRoute.legs[selectedLegIndex];
    if (!leg) return;
    const pts = legPoints(leg);
    if (pts.length > 1) map.fitBounds(latLngBounds(pts), { padding: FIT_PADDING, maxZoom: 16 });
  }, [map, selectedLegIndex, selectedRoute]);

  return null;
}

export function MapCanvas({ origin, destination, centerSignal, selectedRoute, selectedLegIndex = null, userLocation = null }: MapCanvasProps) {
  const [localCenterSignal, setLocalCenterSignal] = useState(0);
  const signal = centerSignal + localCenterSignal;
  const originPosition = origin?.coordinates ? [origin.coordinates.latitude, origin.coordinates.longitude] as [number, number] : undefined;
  const destinationPosition = destination?.coordinates ? [destination.coordinates.latitude, destination.coordinates.longitude] as [number, number] : undefined;
  return (
    <section className="map-frame" aria-label="Mapa de Barueri" data-testid="map-frame">
      <MapContainer className="leaflet-map vai-map" center={INITIAL_CENTER} zoom={13} zoomControl={false} attributionControl={false} scrollWheelZoom>
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>'
        />
        {selectedRoute && <RouteLayers route={selectedRoute} selectedLegIndex={selectedLegIndex} />}
        {selectedRoute && <RouteStops route={selectedRoute} selectedLegIndex={selectedLegIndex} />}
        {originPosition && <Marker position={originPosition} icon={placeIcon('origin')} title="Origem" />}
        {destinationPosition && <Marker position={destinationPosition} icon={placeIcon('destination')} title="Destino" />}
        <UserLocationLayer location={userLocation} />
        <MapActions origin={origin} destination={destination} centerSignal={signal} selectedRoute={selectedRoute} selectedLegIndex={selectedLegIndex} />
        <MapControls onFrameRoute={() => setLocalCenterSignal((value) => value + 1)} userLocation={userLocation} />
      </MapContainer>
      <div className="map-badge"><MapPin size={14} /> MAPA DE BARUERI</div>
      <span className="map-attribution" data-testid="text-map-attribution">
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      </span>
    </section>
  );
}
