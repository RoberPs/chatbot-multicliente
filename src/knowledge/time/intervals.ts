/**
 * Reglas temporales puras (research R8). Horas locales de pared `HH:MM`, días ISO (1 = lunes).
 * No se convierte nada a UTC: la zona horaria del negocio se aplica al interpretar.
 */
import type { DateRangeBlock, ISODate, LocalTime, WeeklySlot, Weekday } from '../types.js';

export interface Interval {
  start: LocalTime;
  end: LocalTime;
}

const toMinutes = (t: LocalTime): number => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

const fromMinutes = (total: number): LocalTime =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** Día ISO (1 = lunes … 7 = domingo) de una fecha `AAAA-MM-DD`. */
export function isoWeekday(date: ISODate): Weekday {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

/** Une intervalos solapados o contiguos y los ordena. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .map((i) => ({ s: toMinutes(i.start), e: toMinutes(i.end) }))
    .filter((i) => i.e > i.s)
    .sort((a, b) => a.s - b.s);
  const merged: Array<{ s: number; e: number }> = [];
  for (const current of sorted) {
    const last = merged.at(-1);
    if (last && current.s <= last.e) {
      last.e = Math.max(last.e, current.e);
    } else {
      merged.push({ ...current });
    }
  }
  return merged.map((i) => ({ start: fromMinutes(i.s), end: fromMinutes(i.e) }));
}

/** `base` menos la unión de `remove`. */
export function subtractIntervals(base: Interval[], remove: Interval[]): Interval[] {
  const holes = mergeIntervals(remove).map((i) => ({ s: toMinutes(i.start), e: toMinutes(i.end) }));
  const result: Interval[] = [];
  for (const interval of mergeIntervals(base)) {
    let pieces = [{ s: toMinutes(interval.start), e: toMinutes(interval.end) }];
    for (const hole of holes) {
      pieces = pieces.flatMap((p) => {
        if (hole.e <= p.s || hole.s >= p.e) return [p];
        const out: Array<{ s: number; e: number }> = [];
        if (hole.s > p.s) out.push({ s: p.s, e: hole.s });
        if (hole.e < p.e) out.push({ s: hole.e, e: p.e });
        return out;
      });
    }
    result.push(...pieces.map((p) => ({ start: fromMinutes(p.s), end: fromMinutes(p.e) })));
  }
  return result;
}

/** Franjas semanales de un día de la semana. */
export function slotsForWeekday(slots: WeeklySlot[], weekday: Weekday): Interval[] {
  return mergeIntervals(
    slots.filter((s) => s.weekday === weekday).map((s) => ({ start: s.start, end: s.end })),
  );
}

type Block = Pick<DateRangeBlock, 'startDate' | 'endDate' | 'startTime' | 'endTime'>;

/**
 * Intervalos de apertura efectivos de una fecha: franjas de su día de la semana menos la
 * unión de los cierres/ausencias que cubren la fecha (FR-005, FR-012).
 */
export function effectiveIntervals(
  slots: WeeklySlot[],
  blocks: Block[],
  date: ISODate,
): Interval[] {
  const covering = blocks.filter((b) => b.startDate <= date && date <= b.endDate);
  if (covering.some((b) => b.startTime === null || b.endTime === null)) return [];
  const partial = covering.map((b) => ({
    start: b.startTime ?? '00:00',
    end: b.endTime ?? '00:00',
  }));
  return subtractIntervals(slotsForWeekday(slots, isoWeekday(date)), partial);
}

/** ¿Está abierto en esa fecha y hora local? El fin de cada franja es exclusivo. */
export function isOpenAt(
  slots: WeeklySlot[],
  blocks: Block[],
  date: ISODate,
  time: LocalTime,
): boolean {
  const t = toMinutes(time);
  return effectiveIntervals(slots, blocks, date).some(
    (i) => toMinutes(i.start) <= t && t < toMinutes(i.end),
  );
}
