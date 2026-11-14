import { useEffect, useState } from 'react';
import { Bus, Footprints, Timer } from 'lucide-react';
import type { TransitRouteOption } from '@workspace/api-client-react';
import { formatDuration } from './format';

const REFRESH_MS = 30_000;

function toMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(String(value)).getTime();
  return Number.isNaN(time) ? null : time;
}

function clock(ms: number): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

// Mostra a situação da viagem com base apenas nos horários programados. Não há acompanhamento em tempo real.
export function TripStatus({ route }: { route: TransitRouteOption }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const steps = route.legs.map((leg) => ({ leg, start: toMs(leg.departureAt), end: toMs(leg.arrivalAt) }));
  const lastEnd = steps.at(-1)?.end ?? null;
  const current = steps.find((step) => step.start !== null && step.end !== null && now >= step.start && now <= step.end) ?? null;
  const nextBoarding = steps.find((step) => step.leg.mode === 'bus' && step.start !== null && step.start > now) ?? null;
  const nextTransfer = steps.find((step, index) => {
    const following = steps[index + 1]?.leg;
    return step.leg.mode === 'bus' && following?.mode === 'bus' && step.end !== null && step.end > now;
  }) ?? null;

  let icon = <Timer size={17} />;
  let title = 'Acompanhe sua viagem';
  let detail = 'Não há horário programado para a próxima etapa.';

  if (lastEnd !== null && now > lastEnd) {
    title = 'Viagem programada concluída';
    detail = `Chegada programada às ${clock(lastEnd)}.`;
  } else if (current?.leg.mode === 'bus' && current.end !== null) {
    icon = <Bus size={17} />;
    title = `No ônibus ${current.leg.lineCode ?? ''}`.trim();
    detail = `Desembarque em ${current.leg.to.label}, horário programado ${clock(current.end)}.`;
  } else if (current && current.end !== null) {
    icon = <Footprints size={17} />;
    title = `Caminhando até ${current.leg.to.label}`;
    detail = `Chegada programada às ${clock(current.end)}.`;
  } else if (nextBoarding?.start != null) {
    icon = <Bus size={17} />;
    const minutes = Math.max(0, Math.round((nextBoarding.start - now) / 60000));
    title = `Próximo embarque: linha ${nextBoarding.leg.lineCode ?? ''}`.trim();
    detail = `${nextBoarding.leg.from.label}, horário programado ${clock(nextBoarding.start)}${minutes > 0 ? ` (em ${formatDuration(minutes)})` : ' (agora)'}.`;
  }

  return (
    <section className="trip-status" aria-label="Situação da viagem" data-testid="trip-status">
      <div className="trip-status-main">
        <span className="trip-status-icon">{icon}</span>
        <div className="trip-status-copy">
          <span className="trip-status-kicker">AGORA</span>
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
      </div>
      {nextTransfer?.end != null && (
        <dl className="trip-status-facts">
          <div>
            <dt>Próxima baldeação</dt>
            <dd>{nextTransfer.leg.to.label} · {clock(nextTransfer.end)}</dd>
          </div>
        </dl>
      )}
      <p className="trip-status-note">Horários programados pelo GTFS · sem previsão em tempo real</p>
    </section>
  );
}
