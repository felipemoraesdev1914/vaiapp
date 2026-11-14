import { divIcon } from 'leaflet';

// Ícones são criados uma única vez e reutilizados, para não recriar marcadores a cada render.
const iconCache = new Map<string, ReturnType<typeof divIcon>>();

function cachedIcon(key: string, factory: () => ReturnType<typeof divIcon>) {
  const cached = iconCache.get(key);
  if (cached) return cached;
  const icon = factory();
  iconCache.set(key, icon);
  return icon;
}

const BUS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6m8-6v6M4 12h16M6 18h12M6 18v2m12-2v2M6 4h12a2 2 0 0 1 2 2v10H4V6a2 2 0 0 1 2-2Z"/><path d="M7 15h.01M17 15h.01"/></svg>';

const TRANSFER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8h11l-3-3M17 16H6l3 3"/></svg>';

export function placeIcon(kind: 'origin' | 'destination') {
  return cachedIcon(`place-${kind}`, () => divIcon({
    className: '',
    html: kind === 'origin'
      ? '<span class="vai-marker vai-marker-origin" aria-hidden="true"><span>A</span></span>'
      : '<span class="vai-marker vai-marker-destination" aria-hidden="true"><span>B</span></span>',
    iconSize: [34, 42],
    iconAnchor: [17, 38],
  }));
}

export function stopIcon(kind: 'stop' | 'transfer') {
  return cachedIcon(`stop-${kind}`, () => divIcon({
    className: '',
    html: kind === 'transfer'
      ? `<span class="vai-stop-marker vai-stop-transfer" aria-hidden="true">${TRANSFER_SVG}</span>`
      : `<span class="vai-stop-marker" aria-hidden="true">${BUS_SVG}</span>`,
    iconSize: kind === 'transfer' ? [30, 30] : [26, 26],
    iconAnchor: kind === 'transfer' ? [15, 15] : [13, 13],
  }));
}

// Ponto da localização do usuário, com pulso discreto em HTML (controlado por CSS).
export function userDotIcon() {
  return cachedIcon('user-dot', () => divIcon({
    className: '',
    html: '<span class="vai-user-dot-wrap" aria-hidden="true"><span class="vai-user-pulse"></span><span class="vai-user-dot"></span></span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  }));
}

// Seta de direção só é criada quando o navegador informa um rumo confiável.
export function headingIcon(heading: number) {
  const rotation = Math.round(heading);
  return cachedIcon(`heading-${rotation}`, () => divIcon({
    className: '',
    html: `<span class="vai-user-heading" style="transform:rotate(${rotation}deg)" aria-hidden="true"></span>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  }));
}
