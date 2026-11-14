import type { Place, RouteSearchRequest } from '../types/route';

/**
 * These boundaries are intentionally data-only. Real OSM/GTFS/API adapters can
 * be added here once official sources and service contracts are available.
 */
export type OsmPlaceRecord = {
  display_name: string;
  lat: string;
  lon: string;
};

export type GtfsTripRecord = {
  route_id: string;
  trip_id: string;
  stop_ids: string[];
};

export type NodeRouteRequest = {
  origin: { label: string; latitude?: number; longitude?: number };
  destination: { label: string; latitude?: number; longitude?: number };
};

export function placeFromOsm(record: OsmPlaceRecord): Place {
  return {
    label: record.display_name,
    coordinates: {
      latitude: Number(record.lat),
      longitude: Number(record.lon),
    },
  };
}

export function toNodeRouteRequest(request: RouteSearchRequest): NodeRouteRequest {
  const mapPlace = (place: Place) => ({
    label: place.label,
    latitude: place.coordinates?.latitude,
    longitude: place.coordinates?.longitude,
  });
  return {
    origin: mapPlace(request.origin),
    destination: mapPlace(request.destination),
  };
}
