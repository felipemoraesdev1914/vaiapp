import { Fragment, useMemo } from 'react';
import type { LatLngExpression } from 'leaflet';
import { Marker, Polyline } from 'react-leaflet';
import type { TransitRouteOption } from '@workspace/api-client-react';
import { stopIcon } from './markers';

// Cores já existentes na identidade do VAI: verde-limão e verde escuro. Caminhada usa cinza neutro.
const BUS_LINE_COLORS = ['#a6cf3e', '#66802c'];
const WALK_COLOR = '#6b7c8a';
const CASING_COLOR = '#ffffff';
const DIMMED_OPACITY = 0.28;

type RouteLayersProps = {
  route: TransitRouteOption;
  selectedLegIndex: number | null;
};

// Desenha os trajetos de cada etapa. Quando uma etapa está selecionada, as demais ficam mais discretas.
export function RouteLayers({ route, selectedLegIndex }: RouteLayersProps) {
  const legs = useMemo(() => {
    let busCount = 0;
    return route.legs.map((leg, index) => {
      const isBus = leg.mode === 'bus';
      const color = isBus ? BUS_LINE_COLORS[busCount++ % BUS_LINE_COLORS.length] : WALK_COLOR;
      return {
        index,
        isBus,
        color,
        positions: leg.geometry.map((point) => [point.latitude, point.longitude] as LatLngExpression),
      };
    });
  }, [route]);

  return (
    <>
      {legs.map((leg) => {
        if (leg.positions.length < 2) return null;
        const active = selectedLegIndex === null || selectedLegIndex === leg.index;
        const opacity = active ? 1 : DIMMED_OPACITY;
        return (
          <Fragment key={`${route.id}-leg-${leg.index}`}>
            {leg.isBus && (
              <Polyline
                positions={leg.positions}
                pathOptions={{ color: CASING_COLOR, weight: active ? 10 : 8, opacity: active ? 0.95 : 0.4, lineCap: 'round', lineJoin: 'round', interactive: false }}
              />
            )}
            <Polyline
              positions={leg.positions}
              pathOptions={{
                color: leg.color,
                weight: leg.isBus ? (active ? 6 : 5) : (active ? 4 : 3),
                opacity,
                dashArray: leg.isBus ? undefined : '6 8',
                lineCap: 'round',
                lineJoin: 'round',
                interactive: false,
              }}
            />
          </Fragment>
        );
      })}
    </>
  );
}

// Marcadores de embarque, desembarque e baldeação. Quando duas linhas se encontram, mostra só o ponto de baldeação.
export function RouteStops({ route, selectedLegIndex }: RouteLayersProps) {
  return (
    <>
      {route.legs.flatMap((leg, index) => {
        if (leg.mode !== 'bus') return [];
        const active = selectedLegIndex === null || selectedLegIndex === index;
        const opacity = active ? 1 : DIMMED_OPACITY + 0.2;
        const nextLeg = route.legs[index + 1];
        const isTransfer = nextLeg?.mode === 'bus';
        const boarding = (
          <Marker
            key={`${route.id}-boarding-${index}`}
            position={[leg.from.coordinates.latitude, leg.from.coordinates.longitude]}
            icon={stopIcon('stop')}
            opacity={opacity}
            title={`Parada de embarque: ${leg.boardingStop?.name ?? leg.from.label}`}
          />
        );
        const alightingOrTransfer = isTransfer ? (
          <Marker
            key={`${route.id}-transfer-${index}`}
            position={[leg.to.coordinates.latitude, leg.to.coordinates.longitude]}
            icon={stopIcon('transfer')}
            opacity={opacity}
            title={`Ponto de baldeação: ${leg.alightingStop?.name ?? leg.to.label}`}
          />
        ) : (
          <Marker
            key={`${route.id}-alighting-${index}`}
            position={[leg.to.coordinates.latitude, leg.to.coordinates.longitude]}
            icon={stopIcon('stop')}
            opacity={opacity}
            title={`Parada de desembarque: ${leg.alightingStop?.name ?? leg.to.label}`}
          />
        );
        return [boarding, alightingOrTransfer];
      })}
    </>
  );
}
