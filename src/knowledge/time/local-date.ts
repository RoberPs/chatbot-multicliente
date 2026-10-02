/**
 * Día y mes locales de un instante en una zona IANA (004 R9, 010 R6). Nada se pasa a UTC: el
 * corte de día y de mes es el del negocio. Lo comparten el chat web y el consumo del modelo.
 */

/** Fecha local `AAAA-MM-DD` de `now` en la zona IANA. */
export function localDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Primer y último día (incluidos) del mes local en curso. */
export function localMonthRange(now: Date, timezone: string): { first: string; last: string } {
  const today = localDay(now, timezone);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  // Día 0 del mes siguiente = último día de este (aritmética de calendario, sin horas).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = today.slice(0, 8);
  return { first: `${prefix}01`, last: `${prefix}${String(lastDay).padStart(2, '0')}` };
}
