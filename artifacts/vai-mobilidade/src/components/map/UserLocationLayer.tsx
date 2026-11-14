import { useMemo } from 'react';
import { Circle, Marker } from 'react-leaflet';
import { headingIcon, userDotIcon } from './markers';

export type UserLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  // null quando o navegador não informa o rumo; nesse caso nenhuma seta é desenhada.
  heading: number | null;
};

// Localização do usuário: área de precisão, ponto central com pulso discreto e,
// se o navegador informar, a direção.
export function UserLocationLayer({ location }: { location: UserLocation | null }) {
  const heading = location?.heading ?? null;
  const directionIcon = useMemo(() => (heading === null ? null : headingIcon(heading)), [heading]);
  if (!location) return null;

  const center: [number, number] = [location.latitude, location.longitude];
  return (
    <>
      <Circle
        center={center}
        radius={Math.max(location.accuracy, 5)}
        pathOptions={{ color: '#66802c', weight: 1, fillColor: '#d9ef68', fillOpacity: 0.18, interactive: false }}
      />
      {directionIcon && <Marker position={center} icon={directionIcon} interactive={false} />}
      <Marker position={center} icon={userDotIcon()} interactive={false} title="Minha localização atual" />
    </>
  );
}
