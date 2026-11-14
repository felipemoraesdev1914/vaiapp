import { Crosshair, Minus, Plus, Route } from 'lucide-react';
import { useMap } from 'react-leaflet';
import type { UserLocation } from './UserLocationLayer';

type MapControlsProps = {
  onFrameRoute: () => void;
  userLocation: UserLocation | null;
};

export function MapControls({ onFrameRoute, userLocation }: MapControlsProps) {
  const map = useMap();
  return (
    <div className="map-controls" aria-label="Controles do mapa">
      <button className="map-control" type="button" aria-label="Aumentar zoom" title="Aumentar zoom" onClick={() => map.zoomIn()} data-testid="button-map-zoom-in"><Plus size={17} /></button>
      <button className="map-control" type="button" aria-label="Diminuir zoom" title="Diminuir zoom" onClick={() => map.zoomOut()} data-testid="button-map-zoom-out"><Minus size={17} /></button>
      <button className="map-control" type="button" aria-label="Enquadrar a rota" title="Enquadrar a rota" onClick={onFrameRoute} data-testid="button-map-center"><Route size={16} /></button>
      {userLocation && (
        <button
          className="map-control"
          type="button"
          aria-label="Centralizar na minha localização"
          title="Centralizar na minha localização"
          onClick={() => map.setView([userLocation.latitude, userLocation.longitude], Math.max(map.getZoom(), 16))}
          data-testid="button-map-locate"
        >
          <Crosshair size={16} />
        </button>
      )}
    </div>
  );
}
