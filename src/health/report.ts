/**
 * Informe de salud de la instancia (009, research R3, data-model §2–§3): estado, versión del
 * núcleo y versión del esquema aplicada y esperada. Solo lectura: el sondeo usa un pool propio de
 * una conexión, una transacción `READ ONLY` y un tope de 2 s, así que no compite con el bot
 * (FR-006). Ningún mensaje de error de la BD llega al informe ni a los registros (FR-002).
 */
import pg from 'pg';
import {
  databaseSchema,
  defaultMigrationsFolder,
  installedSchema,
  UnknownMigrationError,
  type SchemaVersion,
} from '../backup/schema-version.js';
import { createLifecycle, type Lifecycle } from './lifecycle.js';

export type HealthStatus = 'ok' | 'degraded' | 'not_ready';

/** Migración por índice y etiqueta; `tag: null` si este núcleo no la conoce (esquema más nuevo). */
export interface SchemaRef {
  index: number;
  tag: string | null;
}

export interface HealthReport {
  status: HealthStatus;
  coreVersion: string;
  schema: {
    /** `null` si la BD no responde, está vacía o la instancia no está lista (no se consulta). */
    applied: SchemaRef | null;
    expected: { index: number; tag: string };
  };
}

/** Lo que el sondeo lee de la BD. */
export type ProbeResult =
  | { kind: 'empty' }
  | { kind: 'known'; schema: SchemaVersion }
  /** La última migración aplicada no está en el journal de este núcleo. */
  | { kind: 'unknown'; index: number };

export interface SchemaProbe {
  read(): Promise<ProbeResult>;
  close(): Promise<void>;
}

/** Tope de cada consulta y del informe completo antes de declarar `degraded`. */
export const PROBE_TIMEOUT_MS = 2000;

/**
 * Sondeo del esquema con un pool propio de una conexión (R8). Lee la versión con la misma regla
 * que el migrador (`databaseSchema`); si la BD tiene una migración que este núcleo no conoce,
 * cuenta las filas de la tabla de migraciones para indicar hasta dónde llega.
 */
export function createSchemaProbe(
  databaseUrl: string,
  folder = defaultMigrationsFolder,
): SchemaProbe {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    statement_timeout: PROBE_TIMEOUT_MS,
    query_timeout: PROBE_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });
  // Una conexión inactiva que se cae (BD parada) no debe tumbar el proceso.
  pool.on('error', () => undefined);

  return {
    async read() {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN READ ONLY');
        let result: ProbeResult;
        try {
          const schema = await databaseSchema(client, folder);
          result = schema === 'empty' ? { kind: 'empty' } : { kind: 'known', schema };
        } catch (error) {
          if (!(error instanceof UnknownMigrationError)) throw error;
          const count = await client.query<{ n: number }>(
            'select count(*)::int as n from drizzle.__drizzle_migrations',
          );
          result = { kind: 'unknown', index: (count.rows[0]?.n ?? 0) - 1 };
        }
        await client.query('ROLLBACK');
        return result;
      } catch (error) {
        broken = true;
        throw error;
      } finally {
        // Una conexión que ha fallado no vuelve al pool.
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

export interface HealthReportDeps {
  lifecycle: Pick<Lifecycle, 'state'>;
  probe: Pick<SchemaProbe, 'read'>;
  coreVersion: string;
  /** Última migración del núcleo instalado; por defecto, `installedSchema()`. */
  expected?: SchemaVersion;
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Reglas en orden (R3): `not_ready` si la instancia no está lista (sin consultar la BD);
 * `degraded` si la BD no responde en el tope, está vacía o su esquema no es el esperado (índice,
 * etiqueta o hash, o una migración desconocida); si no, `ok`.
 */
export async function buildHealthReport(deps: HealthReportDeps): Promise<HealthReport> {
  const expected = deps.expected ?? installedSchema();
  const base = {
    coreVersion: deps.coreVersion,
    expected: { index: expected.index, tag: expected.tag },
  };
  const report = (status: HealthStatus, applied: SchemaRef | null): HealthReport => ({
    status,
    coreVersion: base.coreVersion,
    schema: { applied, expected: base.expected },
  });

  if (deps.lifecycle.state !== 'ready') return report('not_ready', null);

  let result: ProbeResult;
  try {
    result = await withTimeout(deps.probe.read(), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  } catch {
    // Sin la causa: ni en el informe ni en los registros.
    return report('degraded', null);
  }
  switch (result.kind) {
    case 'empty':
      return report('degraded', null);
    case 'unknown':
      return report('degraded', { index: result.index, tag: null });
    case 'known': {
      const { schema } = result;
      const matches =
        schema.index === expected.index &&
        schema.tag === expected.tag &&
        schema.hash === expected.hash;
      return report(matches ? 'ok' : 'degraded', { index: schema.index, tag: schema.tag });
    }
  }
}

/** Salud de una instancia en marcha: ciclo de vida, informe en cada petición y cierre del sondeo. */
export interface InstanceHealth {
  lifecycle: Lifecycle;
  report(): Promise<HealthReport>;
  /** Cierra el pool propio del sondeo (al cerrar la app). */
  close?(): Promise<void>;
}

/**
 * Salud con el sondeo real contra `databaseUrl`. La última migración esperada se calcula una vez:
 * el journal del núcleo instalado no cambia mientras corre.
 */
export function createInstanceHealth(options: {
  databaseUrl: string;
  coreVersion: string;
  lifecycle?: Lifecycle;
  folder?: string;
}): InstanceHealth {
  const lifecycle = options.lifecycle ?? createLifecycle();
  const folder = options.folder ?? defaultMigrationsFolder;
  const probe = createSchemaProbe(options.databaseUrl, folder);
  const expected = installedSchema(folder);
  return {
    lifecycle,
    report: () =>
      buildHealthReport({ lifecycle, probe, coreVersion: options.coreVersion, expected }),
    close: () => probe.close(),
  };
}

/** Nivel sin credencial: solo el estado. */
export function publicView(report: HealthReport): { status: HealthStatus } {
  return { status: report.status };
}

/** Nivel completo (contracts/health-endpoint.md): solo los campos del contrato. */
export function fullView(report: HealthReport, instanceId: string | null) {
  return {
    status: report.status,
    instanceId,
    coreVersion: report.coreVersion,
    schema: {
      applied:
        report.schema.applied === null
          ? null
          : { index: report.schema.applied.index, tag: report.schema.applied.tag },
      expected: { index: report.schema.expected.index, tag: report.schema.expected.tag },
    },
  };
}
