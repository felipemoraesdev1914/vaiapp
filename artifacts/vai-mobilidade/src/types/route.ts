export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type Place = {
  label: string;
  coordinates?: Coordinates;
};

export type RouteSearchRequest = {
  origin: Place;
  destination: Place;
};

export type { TransitRouteOption, TransitRouteSearchResponse } from '@workspace/api-client-react';
