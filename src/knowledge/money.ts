/** Importes en céntimos (research R9). */

export type AmountParse = { ok: true; cents: number } | { ok: false; message: string };

/** Convierte un importe escrito ("20", "20,50", "20.5") a céntimos. Máximo dos decimales. */
export function parseAmountToCents(input: string): AmountParse {
  const value = input.trim().replace(/\s/g, '');
  if (value.startsWith('-')) return { ok: false, message: 'El importe no puede ser negativo' };
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value);
  if (!match) return { ok: false, message: 'Importe no válido (máximo dos decimales)' };
  const [, units = '0', decimals = ''] = match;
  const cents = Number(units) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 2_147_483_647) {
    return { ok: false, message: 'Importe demasiado grande' };
  }
  return { ok: true, cents };
}

/** Importe para mostrar en listas: "20,50 €". */
export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

/** Importe para precargar un formulario: "20,50" (o "20" si no hay decimales). */
export function centsToInput(cents: number | null): string {
  if (cents === null) return '';
  const units = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(units) : `${units},${String(rest).padStart(2, '0')}`;
}
