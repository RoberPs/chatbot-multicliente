import { lockBusiness, type Db, type Tx } from '../../db/client.js';
import { CriticalWarningError, FieldConflictError } from '../errors.js';
import { loadKnowledgeState, type LoadStateOptions } from '../state.js';
import type { KnowledgeState, Warning } from '../types.js';
import { computeWarnings, criticalWarnings } from '../warnings.js';

/**
 * Aplica `fn` dentro de la transacción protegida y devuelve también el estado resultante, que
 * ya se carga para recalcular los avisos (research R6, FR-032). `opts` lleva las vías de aviso
 * de la instancia, para que el estado devuelto dé los mismos avisos que el panel (008).
 */
async function guardedTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  opts: LoadStateOptions = {},
): Promise<{ result: T; after: KnowledgeState }> {
  try {
    return await db.transaction(async (tx) => {
      await lockBusiness(tx);
      const result = await fn(tx);
      const after = await loadKnowledgeState(tx, opts);
      const critical = criticalWarnings(computeWarnings(after));
      if (after.business.status === 'active' && critical.length > 0) {
        throw new CriticalWarningError(critical);
      }
      return { result, after };
    });
  } catch (error) {
    throw translateDbError(error);
  }
}

/**
 * Toda escritura del panel pasa por aquí (research R6, FR-032):
 * aplicar → recalcular avisos → confirmar, o revertir si el negocio activo queda con un
 * aviso crítico. Las escrituras se serializan con un bloqueo sobre la fila del negocio.
 */
export async function runGuardedWrite<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await guardedTransaction(db, fn)).result;
}

/**
 * Como `runGuardedWrite`, pero devuelve además el estado justo antes y justo después del
 * guardado, leídos en la misma transacción serializada (003, research R4).
 */
export async function runTrackedWrite<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  opts: LoadStateOptions = {},
): Promise<{ result: T; before: KnowledgeState; after: KnowledgeState }> {
  let before: KnowledgeState | undefined;
  const { result, after } = await guardedTransaction(
    db,
    async (tx) => {
      before = await loadKnowledgeState(tx, opts);
      return fn(tx);
    },
    opts,
  );
  if (!before) throw new Error('runTrackedWrite: falta el estado anterior');
  return { result, before, after };
}

export interface PreviewResult<T> {
  result: T;
  before: KnowledgeState;
  after: KnowledgeState;
  /** Avisos del estado resultante, con las vías de aviso recibidas. */
  warnings: Warning[];
  /** La escritura protegida lo rechazaría: negocio activo con algún aviso crítico (FR-032). */
  blocked: boolean;
}

/** Lleva el resultado del ensayo fuera de la transacción, que así se revierte siempre. */
class PreviewRollback<T> extends Error {
  constructor(readonly preview: PreviewResult<T>) {
    super('Ensayo revertido');
    this.name = 'PreviewRollback';
  }
}

/**
 * Ensayo de una escritura (008, research R6): la misma secuencia que la escritura protegida
 * —bloqueo del negocio, estado antes, `fn`, estado después y avisos— dentro de una transacción
 * que **siempre** se revierte. Predice lo que haría la escritura sin cambiar nada (FR-014).
 */
export async function previewWrite<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  opts: LoadStateOptions = {},
): Promise<PreviewResult<T>> {
  try {
    await db.transaction(async (tx) => {
      await lockBusiness(tx);
      const before = await loadKnowledgeState(tx, opts);
      const result = await fn(tx);
      const after = await loadKnowledgeState(tx, opts);
      const warnings = computeWarnings(after);
      const blocked =
        after.business.status === 'active' && criticalWarnings(warnings).length > 0;
      throw new PreviewRollback({ result, before, after, warnings, blocked });
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.preview as PreviewResult<T>;
    throw translateDbError(error);
  }
  throw new Error('previewWrite: la transacción del ensayo no se revirtió');
}

interface PgError {
  code: string;
  constraint?: string;
}

function findPgError(error: unknown): PgError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      if (/^[0-9A-Z]{5}$/.test(current.code)) return current as PgError;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

const UNIQUE_FIELDS: Record<string, { field: string; message: string }> = {
  service_name_lower_idx: { field: 'name', message: 'Ya existe un servicio con ese nombre' },
  resource_name_lower_idx: { field: 'name', message: 'Ya existe un recurso con ese nombre' },
  handoff_channel_type_value_unique: {
    field: 'channels',
    message: 'Ese medio de contacto está repetido',
  },
};

/** Traduce violaciones de restricciones de Postgres a errores de campo. */
export function translateDbError(error: unknown): unknown {
  const pg = findPgError(error);
  if (!pg) return error;
  const unique = pg.code === '23505' && pg.constraint ? UNIQUE_FIELDS[pg.constraint] : undefined;
  if (unique) return new FieldConflictError(unique.field, unique.message);
  if (pg.code === '23503' && pg.constraint?.includes('service_id')) {
    return new FieldConflictError('service_ids', 'Alguno de los servicios no existe');
  }
  return error;
}
