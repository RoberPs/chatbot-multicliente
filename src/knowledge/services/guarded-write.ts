import { lockBusiness, type Db, type Tx } from '../../db/client.js';
import { CriticalWarningError, FieldConflictError } from '../errors.js';
import { loadKnowledgeState } from '../state.js';
import { computeWarnings, criticalWarnings } from '../warnings.js';

/**
 * Toda escritura del panel pasa por aquí (research R6, FR-032):
 * aplicar → recalcular avisos → confirmar, o revertir si el negocio activo queda con un
 * aviso crítico. Las escrituras se serializan con un bloqueo sobre la fila del negocio.
 */
export async function runGuardedWrite<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await lockBusiness(tx);
      const result = await fn(tx);
      const state = await loadKnowledgeState(tx);
      const critical = criticalWarnings(computeWarnings(state));
      if (state.business.status === 'active' && critical.length > 0) {
        throw new CriticalWarningError(critical);
      }
      return result;
    });
  } catch (error) {
    throw translateDbError(error);
  }
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
