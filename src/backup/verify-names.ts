/**
 * Nombres de las bases temporales de `db:verify` y selección de las huérfanas (013, research R5,
 * data-model §3). Puro: sin `pg` ni reloj propio.
 *
 * La marca va en UTC aunque el proyecto use la hora local: no es un horario del negocio sino un
 * instante técnico, comparado con el reloj del proceso.
 */

/** Plazo máximo de una verificación: después, una base sin conexiones es huérfana. */
export const VERIFY_MAX_AGE_HOURS = 6;

const CURRENT = /^verify_(\d{14})_([0-9a-f]{16})$/;
/** Formato del núcleo anterior a la 013: sin marca. */
const LEGACY = /^verify_[0-9a-f]{16}$/;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `verify_<yyyymmddhhmmss UTC>_<16 hex>`; `random` son 8 bytes aleatorios. */
export function verifyDatabaseName(now: Date, random: Buffer): string {
  const stamp =
    pad(now.getUTCFullYear(), 4) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  return `verify_${stamp}_${random.subarray(0, 8).toString('hex')}`;
}

export type VerifyName = { format: 'current'; createdAt: Date } | { format: 'legacy' };

/** Marca de `yyyymmddhhmmss` si es una fecha y hora reales; si no, `null`. */
function parseStamp(stamp: string): Date | null {
  const [y, mo, d, h, mi, s] = [0, 4, 6, 8, 10, 12].map((start, i) =>
    Number(stamp.slice(start, i === 0 ? 4 : start + 2)),
  ) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // `Date.UTC` desborda (mes 13, 30 de febrero): solo vale si los campos no cambian.
  const same =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s;
  return same ? date : null;
}

/** Formato de un nombre de base temporal, o `null` si no cumple exactamente ninguno (FR-011). */
export function parseVerifyName(name: string): VerifyName | null {
  if (LEGACY.test(name)) return { format: 'legacy' };
  const match = CURRENT.exec(name);
  if (!match) return null;
  const createdAt = parseStamp(match[1] ?? '');
  return createdAt ? { format: 'current', createdAt } : null;
}

/**
 * Huérfanas que se pueden borrar: patrón exacto, sin conexiones y, en el formato nuevo, con una
 * marca de hace más de `VERIFY_MAX_AGE_HOURS` (una marca en el futuro no cuenta).
 */
export function selectOrphans(
  rows: Array<{ name: string; connections: number }>,
  now: Date,
): string[] {
  const limit = now.getTime() - VERIFY_MAX_AGE_HOURS * 60 * 60 * 1000;
  return rows
    .filter((row) => {
      if (row.connections !== 0) return false;
      const parsed = parseVerifyName(row.name);
      if (parsed === null) return false;
      return parsed.format === 'legacy' || parsed.createdAt.getTime() < limit;
    })
    .map((row) => row.name);
}
