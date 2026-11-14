import { useMemo, type ReactNode } from 'react';
import { ArrowRightLeft, Bus, Footprints, MapPin, Timer } from 'lucide-react';
import type { TransitRouteOption } from '@workspace/api-client-react';
import { clockTime, formatDistance, formatDuration, minutesBetween } from './format';

type StepKind = 'walk' | 'walk-final' | 'wait' | 'transfer' | 'bus' | 'arrival';

type Step = {
  key: string;
  kind: StepKind;
  // Índice da etapa no trajeto (usado para destacar no mapa). Null quando a etapa não tem trajeto próprio.
  legIndex: number | null;
  title: string;
  lines: string[];
  meta: string;
};

const ICONS: Record<StepKind, ReactNode> = {
  walk: <Footprints size={15} />,
  'walk-final': <Footprints size={15} />,
  wait: <Timer size={15} />,
  transfer: <ArrowRightLeft size={15} />,
  bus: <Bus size={15} />,
  arrival: <MapPin size={15} />,
};

// Monta as etapas a partir dos dados da API. Esperas e baldeações são calculadas pelos horários de cada etapa.
function buildSteps(route: TransitRouteOption): Step[] {
  const steps: Step[] = [];
  route.legs.forEach((leg, index) => {
    const previous = route.legs[index - 1];
    const waitMinutes = previous ? minutesBetween(previous.arrivalAt, leg.departureAt) : 0;
    if (previous && leg.mode === 'bus' && waitMinutes > 0) {
      const departure = `Saída programada às ${clockTime(leg.departureAt)}`;
      if (previous.mode === 'bus') {
        steps.push({
          key: `transfer-${index}`,
          kind: 'transfer',
          legIndex: null,
          title: `Baldeação em ${previous.to.label}`,
          lines: [`Pegue a linha ${leg.lineCode ?? ''}`.trim(), departure],
          meta: `${formatDuration(waitMinutes)} de espera`,
        });
      } else {
        steps.push({
          key: `wait-${index}`,
          kind: 'wait',
          legIndex: null,
          title: 'Espere o ônibus',
          lines: [`No ponto ${previous.to.label}`, departure],
          meta: `${waitMinutes} min de espera`,
        });
      }
    }

    if (leg.mode === 'walk') {
      const distance = formatDistance(leg.distanceMeters);
      const meta = [`${leg.durationMinutes} min a pé`, distance].filter(Boolean).join(' · ');
      steps.push(index === 0
        ? { key: `walk-${index}`, kind: 'walk', legIndex: index, title: `Caminhe até ${leg.to.label}`, lines: [`Saindo de ${leg.from.label}`], meta }
        : { key: `walk-${index}`, kind: 'walk-final', legIndex: index, title: 'Caminhe até o destino', lines: [`A partir de ${leg.from.label}`], meta });
    } else {
      steps.push({
        key: `bus-${index}`,
        kind: 'bus',
        legIndex: index,
        title: `Linha ${leg.lineCode ?? ''}`.trim(),
        lines: [leg.headsign ? `Sentido ${leg.headsign}` : '', `${leg.from.label} → ${leg.to.label}`].filter(Boolean),
        meta: `${leg.durationMinutes} min · ${clockTime(leg.departureAt)} → ${clockTime(leg.arrivalAt)}`,
      });
    }
  });
  steps.push({ key: 'arrival', kind: 'arrival', legIndex: null, title: 'Você chega ao destino', lines: [], meta: clockTime(route.arrivalAt) });
  return steps;
}

type JourneyTimelineProps = {
  route: TransitRouteOption;
  selectedLegIndex: number | null;
  onSelectLeg: (index: number | null) => void;
};

export function JourneyTimeline({ route, selectedLegIndex, onSelectLeg }: JourneyTimelineProps) {
  const steps = useMemo(() => buildSteps(route), [route]);
  return (
    <ol className="jt-list" aria-label="Etapas da viagem" data-testid="journey-timeline">
      {steps.map((step) => {
        const content = (
          <>
            <span className="jt-icon" aria-hidden="true">{ICONS[step.kind]}</span>
            <span className="jt-body">
              <span className="jt-title">{step.title}</span>
              {step.lines.map((line, lineIndex) => <span key={lineIndex} className="jt-line">{line}</span>)}
            </span>
            {step.meta && <span className="jt-meta">{step.meta}</span>}
          </>
        );
        const legIndex = step.legIndex;
        const isActive = legIndex !== null && selectedLegIndex === legIndex;
        return (
          <li key={step.key} className={`jt-item jt-${step.kind}`}>
            {legIndex !== null ? (
              <button
                type="button"
                className={`jt-card jt-clickable ${isActive ? 'is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => onSelectLeg(isActive ? null : legIndex)}
                data-testid={`button-leg-${legIndex}`}
              >
                {content}
              </button>
            ) : (
              <div className="jt-card">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
