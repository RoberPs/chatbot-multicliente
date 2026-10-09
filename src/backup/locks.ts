/**
 * Bloqueos consultivos de sesión en la BD de la instancia (006, research R7). Los ve cualquier
 * proceso conectado a la misma BD y se liberan solos si el proceso muere.
 */
import pg from 'pg';

/** Instancia en marcha: servidor (toda su vida) y `db:restore` (mientras restaura). */
export const INSTANCE_RUNNING = 6_006_001n;
/** Copia en curso: cualquier copia (manual, previa o diaria). */
export const BACKUP_IN_PROGRESS = 6_006_002n;

export interface AdvisoryLock {
  release(): Promise<void>;
}

/**
 * Intenta tomar el bloqueo en una conexión propia. Devuelve `null` si otro lo tiene; lanza si no
 * se puede conectar.
 */
export async function tryAdvisoryLock(url: string, key: bigint): Promise<AdvisoryLock | null> {
  const client = new pg.Client({ connectionString: url, application_name: 'chatbot-lock' });
  /**
   * 016 (FR-005): el oyente va **aquí**, antes de conectar y de consultar el cerrojo. Antes
   * estaba después de tomarlo, así que entre la construcción y esa línea quedaba una ventana en
   * la que una conexión caída emitía `error` sin oyentes y terminaba el proceso.
   *
   * Una conexión caída libera el bloqueo en el servidor; aquí solo se evita que tumbe el
   * proceso.
   */
  client.on('error', () => undefined);
  await client.connect();
  let taken = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1::bigint) as locked',
      [key.toString()],
    );
    taken = result.rows[0]?.locked === true;
  } finally {
    if (!taken) await client.end().catch(() => undefined);
  }
  if (!taken) return null;
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query('select pg_advisory_unlock($1::bigint)', [key.toString()]);
      } catch {
        // Al cerrar la conexión se libera igualmente.
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}
