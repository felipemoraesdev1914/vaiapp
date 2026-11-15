import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSearchText,
  photonLabel,
  rankPhotonFeatures,
  TimedLruCache,
} from '../src/lib/geocoding.ts';

function photonFeature({
  city,
  state = 'São Paulo',
  street = 'Rua das Flores',
  housenumber = '42',
  coordinates = [-46.8765, -23.5113],
  countrycode = 'br',
} = {}) {
  return {
    geometry: { coordinates },
    properties: { city, state, street, housenumber, countrycode },
  };
}

test('formats the street address with municipality and state', () => {
  assert.equal(
    photonLabel({
      street: 'Rua das Flores',
      housenumber: '42',
      city: 'Barueri',
      state: 'São Paulo',
      postcode: '06400-000',
    }),
    'Rua das Flores, 42, Barueri, São Paulo, 06400-000',
  );
});

test('normalizes accents and case for the cache key', () => {
  assert.equal(normalizeSearchText('  Avenida São João  '), 'avenida sao joao');
});

test('prioritizes Barueri for ambiguous searches', () => {
  const ranked = rankPhotonFeatures(
    [photonFeature({ city: 'Osasco' }), photonFeature({ city: 'Barueri' })],
    'Rua das Flores, 42',
  );

  assert.equal(ranked[0]?.label.includes('Barueri'), true);
});

test('honors another municipality named in the search', () => {
  const ranked = rankPhotonFeatures(
    [photonFeature({ city: 'Barueri' }), photonFeature({ city: 'Osasco' })],
    'Rua das Flores, 42, Osasco',
  );

  assert.equal(ranked[0]?.label.includes('Osasco'), true);
});

test('preserves GeoJSON longitude-latitude order as latitude-longitude fields', () => {
  const [result] = rankPhotonFeatures(
    [photonFeature({ city: 'Barueri', coordinates: [-46.8765, -23.5113] })],
    'Terminal Barueri',
  );

  assert.deepEqual(result?.coordinates, { latitude: -23.5113, longitude: -46.8765 });
});

test('rejects invalid or out-of-range Photon coordinates', () => {
  const results = rankPhotonFeatures(
    [
      photonFeature({ city: 'Barueri', coordinates: [200, -23.5] }),
      photonFeature({ city: 'Barueri', coordinates: [-46.8, 91] }),
      photonFeature({ city: 'Barueri', coordinates: [-46.8] }),
    ],
    'Terminal Barueri',
  );

  assert.deepEqual(results, []);
});

test('expires and evicts the least recently used cached search', () => {
  const cache = new TimedLruCache(100, 2);
  cache.set('first', ['first'], 0);
  cache.set('second', ['second'], 0);
  assert.deepEqual(cache.get('first', 50), ['first']);
  cache.set('third', ['third'], 50);

  assert.equal(cache.get('second', 60), undefined);
  assert.deepEqual(cache.get('first', 60), ['first']);
  assert.equal(cache.get('first', 100), undefined);
});
