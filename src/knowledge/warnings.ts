/**
 * Avisos de datos incompletos o incoherentes (contracts/warnings.md).
 * Se calculan siempre a partir del estado actual y nunca se guardan (research R5).
 */
import { effectiveHandoff } from './handoff.js';
import { slotsForWeekday, subtractIntervals } from './time/intervals.js';
import type { KnowledgeState, Warning, WeeklySlot, Weekday } from './types.js';

export const WEEKDAY_SHORT = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'] as const;

const weekdayShort = (weekday: Weekday): string => WEEKDAY_SHORT[weekday - 1] ?? String(weekday);

const HANDOFF_LABEL = 'Contacto de derivación';

export function computeWarnings(state: KnowledgeState): Warning[] {
  const warnings: Warning[] = [
    ...handoffWarnings(state),
    ...businessWarnings(state),
    ...serviceWarnings(state),
    ...resourceWarnings(state),
  ];
  return sortWarnings(warnings);
}

/** Críticos primero; después por tipo de elemento y nombre. */
export function sortWarnings(warnings: Warning[]): Warning[] {
  return [...warnings].sort(
    (a, b) =>
      Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
      a.target.kind.localeCompare(b.target.kind) ||
      a.target.label.localeCompare(b.target.label, 'es'),
  );
}

export const criticalWarnings = (warnings: Warning[]): Warning[] =>
  warnings.filter((w) => w.severity === 'critical');

function handoffWarnings(state: KnowledgeState): Warning[] {
  const handoff = effectiveHandoff(state);
  if (handoff.source === 'business_phone') {
    return [
      {
        code: 'HANDOFF_CONTACT_MISSING',
        severity: 'normal',
        target: { kind: 'handoff', label: HANDOFF_LABEL },
        field: 'channels',
        message:
          'No hay contacto de derivación configurado; se usará el teléfono del negocio para pasar la conversación a una persona.',
      },
    ];
  }
  if (handoff.source === 'none') {
    return [
      {
        code: 'HANDOFF_UNREACHABLE',
        severity: 'critical',
        target: { kind: 'handoff', label: HANDOFF_LABEL },
        field: 'channels',
        message:
          'No hay contacto de derivación ni teléfono del negocio: el bot no tendría a quién pasar la conversación.',
      },
    ];
  }
  return [];
}

function businessWarnings(state: KnowledgeState): Warning[] {
  if (state.businessHours.length > 0) return [];
  return [
    {
      code: 'BUSINESS_HOURS_MISSING',
      severity: 'normal',
      target: { kind: 'business', label: state.business.name || 'Negocio' },
      field: 'hours',
      message: 'No hay horario de apertura registrado.',
    },
  ];
}

function serviceWarnings(state: KnowledgeState): Warning[] {
  const warnings: Warning[] = [];
  const hasResources = state.resources.length > 0;
  const activeResources = state.resources.filter((r) => r.active);

  for (const s of state.services.filter((x) => x.active)) {
    const target = { kind: 'service' as const, id: s.id, label: s.name };
    if (s.bookable && s.durationMinutes === null) {
      warnings.push({
        code: 'SERVICE_DURATION_MISSING',
        severity: 'normal',
        target,
        field: 'duration',
        message: `El servicio «${s.name}» es reservable pero no tiene duración; no se podrá reservar.`,
      });
    }
    if ((s.priceType === 'fixed' || s.priceType === 'from') && s.priceCents === null) {
      warnings.push({
        code: 'SERVICE_PRICE_MISSING',
        severity: 'normal',
        target,
        field: 'price',
        message: `El servicio «${s.name}» no tiene importe registrado; el bot no dará ninguna cifra.`,
      });
    }
    if (hasResources && s.bookable && !activeResources.some((r) => r.serviceIds.includes(s.id))) {
      warnings.push({
        code: 'SERVICE_WITHOUT_RESOURCE',
        severity: 'normal',
        target,
        field: 'resources',
        message: `Ningún recurso activo presta el servicio reservable «${s.name}».`,
      });
    }
  }
  return warnings;
}

function resourceWarnings(state: KnowledgeState): Warning[] {
  // Sin horario del negocio ya se emite BUSINESS_HOURS_MISSING: no se evalúa (evita cascada).
  if (state.businessHours.length === 0) return [];
  const warnings: Warning[] = [];
  for (const r of state.resources.filter((x) => x.active)) {
    const outside: WeeklySlot[] = [];
    for (const slot of r.hours) {
      const open = slotsForWeekday(state.businessHours, slot.weekday);
      for (const part of subtractIntervals([slot], open)) {
        outside.push({ weekday: slot.weekday, start: part.start, end: part.end });
      }
    }
    if (outside.length > 0) {
      const list = outside.map((s) => `${weekdayShort(s.weekday)} ${s.start}–${s.end}`).join(', ');
      warnings.push({
        code: 'RESOURCE_HOURS_OUTSIDE_BUSINESS',
        severity: 'normal',
        target: { kind: 'resource', id: r.id, label: r.name },
        field: 'hours',
        message: `«${r.name}» tiene horario fuera del horario del negocio: ${list}.`,
        details: { slots: outside },
      });
    }
  }
  return warnings;
}
