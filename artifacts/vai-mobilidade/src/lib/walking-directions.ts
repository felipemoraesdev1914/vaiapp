export type WalkCoordinate = { latitude: number; longitude: number };

export type WalkingDirections = {
  geometry: WalkCoordinate[];
  instructions: string[];
  distanceMeters: number;
  durationSeconds: number;
};

type OsrmStep = {
  name?: string;
  distance?: number;
  maneuver?: { type?: string; modifier?: string };
};

type OsrmRouteResponse = {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: { coordinates?: [number, number][] };
    legs?: Array<{ steps?: OsrmStep[] }>;
  }>;
};

const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
const cache = new Map<string, Promise<WalkingDirections | undefined>>();
let queue: Promise<void> = Promise.resolve();
let nextRequestAt = 0;

function keyFor(from: WalkCoordinate, to: WalkCoordinate) {
  return [from.latitude, from.longitude, to.latitude, to.longitude].map((value) => value.toFixed(5)).join(',');
}

function instructionFor(step: OsrmStep, first: boolean): string | undefined {
  const street = step.name?.trim();
  if (!street || (step.distance ?? 0) < 8) return undefined;
  const modifier = step.maneuver?.modifier;
  if (first || step.maneuver?.type === 'depart') return `Siga pela ${street}`;
  if (step.maneuver?.type === 'arrive') return undefined;
  if (step.maneuver?.type === 'roundabout' || step.maneuver?.type === 'rotary') return `Na rotatória, siga pela ${street}`;
  if (modifier === 'left' || modifier === 'sharp left') return `Vire à esquerda na ${street}`;
  if (modifier === 'right' || modifier === 'sharp right') return `Vire à direita na ${street}`;
  if (modifier === 'slight left') return `Mantenha-se à esquerda pela ${street}`;
  if (modifier === 'slight right') return `Mantenha-se à direita pela ${street}`;
  return `Continue pela ${street}`;
}

async function loadDirections(from: WalkCoordinate, to: WalkCoordinate): Promise<WalkingDirections | undefined> {
  const task = queue.then(async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextRequestAt = Date.now() + 1_100;
    const coordinates = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const response = await fetch(`${ROUTER}/${coordinates}?overview=full&geometries=geojson&steps=true`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const data = await response.json() as OsrmRouteResponse;
    const route = data.routes?.[0];
    if (!route) return undefined;
    const rawSteps = route.legs?.[0]?.steps ?? [];
    const instructions: string[] = [];
    for (const step of rawSteps) {
      const instruction = instructionFor(step, instructions.length === 0);
      if (!instruction) continue;
      if (instructions.at(-1)?.toLowerCase() === instruction.toLowerCase()) continue;
      instructions.push(instruction);
      if (instructions.length >= 4) break;
    }
    const coordinatesList = route.geometry?.coordinates ?? [];
    return {
      geometry: coordinatesList.map(([longitude, latitude]) => ({ latitude, longitude })),
      instructions,
      distanceMeters: Math.round(route.distance ?? 0),
      durationSeconds: Math.round(route.duration ?? 0),
    };
  });
  queue = task.then(() => undefined, () => undefined);
  try { return await task; } catch { return undefined; }
}

export function getWalkingDirections(from: WalkCoordinate, to: WalkCoordinate): Promise<WalkingDirections | undefined> {
  const key = keyFor(from, to);
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = loadDirections(from, to);
  cache.set(key, pending);
  void pending.then((result) => { if (!result) cache.delete(key); });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return pending;
}
