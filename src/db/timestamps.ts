import { sql } from 'drizzle-orm';
import { business } from './schema.js';
import type { Tx } from './client.js';

/** Valor para `updated_at` en cualquier escritura: `{ ...valores, ...touch() }`. */
export function touch() {
  return { updatedAt: sql`clock_timestamp()` } as const;
}

/**
 * Marca un cambio que no deja ninguna fila modificada (p. ej. un borrado), para que
 * `snapshot.updatedAt` avance igualmente.
 */
export async function touchBusiness(tx: Tx): Promise<void> {
  await tx.update(business).set(touch());
}

/** Convierte un `timestamptz` en texto de Postgres (UTC) a ISO 8601 con microsegundos. */
export function toIsoTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:\+00(?::?00)?|Z)$/.exec(
    value,
  );
  if (!match) return new Date(value).toISOString();
  const [, day, clock, fraction = ''] = match;
  return `${day}T${clock}.${fraction.padEnd(6, '0').slice(0, 6)}Z`;
}
