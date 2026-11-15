export type GeoCoordinates = {
  latitude: number;
  longitude: number;
};

export type PhotonFeature = {
  geometry?: {
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
};

export type PhotonSearchResult = {
  label: string;
  coordinates: GeoCoordinates;
};

function propertyText(properties: Record<string, unknown>, key: string): string {
  const value = properties[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

export function photonLabel(properties: Record<string, unknown>): string {
  const street = propertyText(properties, 'street');
  const houseNumber = propertyText(properties, 'housenumber');
  const name = propertyText(properties, 'name');
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
  const normalizedQuery = normalizeSearchText(query);
  const city = normalizeSearchText(
    propertyText(properties, 'city') || propertyText(properties, 'locality'),
  );
  const state = normalizeSearchText(propertyText(properties, 'state'));
  const hasNumberAtEnd = /(?:,|\s)\d{1,5}\s*$/.test(query.trim());

  let score = 0;
  if (street) score += 5;
  if (street && houseNumber) score += 5;
  if (hasNumberAtEnd && houseNumber) score += 8;
  if (hasNumberAtEnd && !houseNumber) score -= 8;
  if (!street && propertyText(properties, 'name') && hasNumberAtEnd) score -= 5;

  // Use Barueri as the default locality bias while honoring an explicitly
  // named municipality in the user's query, including nearby cities.
  if (city === 'barueri') {
    score += normalizedQuery.includes('barueri') ? 60 : 24;
  } else if (city && normalizedQuery.includes(city)) {
    score += 60;
  }
  if (state === 'sao paulo' || state === 'sp') score += 12;

  const countryCode = propertyText(properties, 'countrycode').toLocaleLowerCase('en-US');
  if (countryCode === 'br') score += 4;
  else if (countryCode) score -= 24;

  return score;
}

export function rankPhotonFeatures(
  features: PhotonFeature[],
  query: string,
): PhotonSearchResult[] {
  return features
    .flatMap((feature, index) => {
      const properties = feature.properties ?? {};
      const label = photonLabel(properties);
      const rawCoordinates = feature.geometry?.coordinates;
      if (
        !label ||
        !Array.isArray(rawCoordinates) ||
        rawCoordinates.length < 2
      ) {
        return [];
      }

      const [longitude, latitude] = rawCoordinates;
      if (
        typeof latitude !== 'number' ||
        typeof longitude !== 'number' ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return [];
      }

      return [{
        result: { label, coordinates: { latitude, longitude } },
        score: photonRelevance(properties, query),
        index,
      }];
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ result }) => result);
}

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export class TimedLruCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries: number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError('ttlMs must be a positive finite number');
    }
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
