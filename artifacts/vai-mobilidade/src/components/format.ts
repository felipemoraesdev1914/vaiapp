import type { TransitRouteOption } from '@workspace/api-client-react';

type TimeValue = string | Date | null | undefined;

export function toDate(value: TimeValue): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function clockTime(value: TimeValue): string {
  const date = toDate(value);
  return date ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date) : '—';
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  const rounded = Math.ceil(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder === 0
    ? `${hours} h`
    : `${hours} h ${String(remainder).padStart(2, '0')} min`;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(meters)} m`;
}

// Minutos entre dois horários, arredondados para cima como a API faz. Retorna 0 se algum horário faltar.
export function minutesBetween(start: TimeValue, end: TimeValue): number {
  const from = toDate(start);
  const to = toDate(end);
  if (!from || !to) return 0;
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 60000));
}

// Início real da viagem: a API calcula o tempo total a partir deste instante (primeira caminhada),
// e não a partir do embarque no ônibus.
export function tripStart(route: TransitRouteOption): TimeValue {
  return route.legs[0]?.departureAt ?? route.departureAt;
}
