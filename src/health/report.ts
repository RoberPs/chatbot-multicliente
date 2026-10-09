/**
 * Informe de salud de la instancia (009, research R3, data-model §2–§3): estado, versión del
 * núcleo y versión del esquema aplicada y esperada. Solo lectura: el sondeo usa un pool propio de
 * una conexión, una transacción `READ ONLY` y un tope de 2 s, así que no compite con el bot
 * (FR-006). Ningún mensaje de error de la BD llega al informe ni a los registros (FR-002).
 *
 * Desde la 010, la vista completa lleva también el nivel del tope de gasto, leído en el mismo
 * sondeo y solo con el esquema esperado; no cambia el estado (FR-023a).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  databaseSchema,
  defaultMigrationsFolder,
  installedSchema,
  UnknownMigrationError,
  type SchemaVersion,
} from '../backup/schema-version.js';
import type { Db } from '../db/client.js';
import * as dbSchema from '../db/schema.js';
import {
  defaultProtectionConfig,
  protectionState,
  type ProtectionConfig,
} from '../usage/protection.js';
import type { ContactOnlyReason, SpendCapLevel } from '../usage/types.js';
import { createLifecycle, type Lifecycle } from './lifecycle.js';

/**
 * `db_unavailable` (016, FR-003): la base de datos no contesta, pero **el proceso vive y sirve**.
 * Viaja con HTTP 200 a propósito, para que ninguna política de reinicio lo tome por un motivo
 * para reiniciar la instancia: reiniciar durante un corte es el bucle que la 016 elimina.
 * `degraded` queda para lo que de verdad necesita al operador —la base contesta pero su esquema
 * está vacío, es desconocido o no es el esperado— y sigue siendo 503.
 */
export type HealthStatus = 'ok' | 'db_unavailable' | 'degraded' | 'not_ready';

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
  /**
   * Nivel del tope de gasto (010) o `blocked` si la instancia responde solo con el contacto (012);
   * `null` si no se pudo leer o el esquema no es el esperado.
   */
  spendCap: SpendCapReport | null;
}

/** Lo que el sondeo lee de la BD. */
export type ProbeResult =
  | { kind: 'empty' }
  /** `spendCap`: solo con el esquema esperado; `null` si no se pudo leer (010). */
  | { kind: 'known'; schema: SchemaVersion; spendCap?: SpendCapReport | null }
  /** La última migración aplicada no está en el journal de este núcleo. */
  | { kind: 'unknown'; index: number };

export interface SchemaProbe {
  read(): Promise<ProbeResult>;
  close(): Promise<void>;
}

/** Mismo esquema en índice, etiqueta y hash. */
const sameSchema = (a: SchemaVersion, b: SchemaVersion): boolean =>
  a.index === b.index && a.tag === b.tag && a.hash === b.hash;

/** Valor de `spendCap` en el informe: el nivel de la 010 o `blocked` (012, R17). */
export type SpendCapReport = SpendCapLevel | 'blocked';

/** Motivos por los que la instancia responde solo con el contacto (012, R17). */
const BLOCKING: ReadonlySet<ContactOnlyReason> = new Set([
  'cap_disabled',
  'model_unpriced',
  'stt_unpriced',
  'spend_unreadable',
]);

/**
 * Tope de gasto dentro de la transacción del sondeo, en un punto de guardado (010): el nivel, o
 * `blocked` si la instancia responde solo con el contacto (012) o no puede leer el gasto. Si falla
 * algo más, `null` y el informe sigue. La zona es la del negocio; sin negocio, UTC.
 */
async function readSpendCap(
  client: pg.PoolClient,
  protection: ProtectionConfig,
): Promise<SpendCapReport | null> {
  await client.query('SAVEPOINT spend_cap');
  try {
    const zone = await client.query<{ timezone: string }>(
      'select timezone from business where id = 1',
    );
    const db = drizzle(client, { schema: dbSchema }) as unknown as Db;
    const state = await protectionState(db, {
      ...protection,
      now: new Date(),
      timezone: zone.rows[0]?.timezone ?? 'UTC',
    });
    if (state.readFailure !== null) {
      await client.query('ROLLBACK TO SAVEPOINT spend_cap');
      return 'blocked';
    }
    await client.query('RELEASE SAVEPOINT spend_cap');
    if (state.contactOnly.some((r) => BLOCKING.has(r))) return 'blocked';
    return state.spendCap?.level ?? null;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT spend_cap');
    return null;
  }
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
  /** Producción y modelos (012): deciden si el tope sale como `blocked`. */
  protection: ProtectionConfig = defaultProtectionConfig(''),
  /** 016: recibe el error de una conexión ociosa caída (el vigilante del corte). */
  onPoolError?: (error: unknown) => void,
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
  // Una conexión inactiva que se cae (BD parada) no debe tumbar el proceso. Desde la 016 el
  // error se entrega además al vigilante del corte, que es quien lo registra una sola vez.
  pool.on('error', (error) => {
    onPoolError?.(error);
  });
  let expected: SchemaVersion | null = null;

  return {
    async read() {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN READ ONLY');
        let result: ProbeResult;
        try {
          const schema = await databaseSchema(client, folder);
          if (schema === 'empty') {
            result = { kind: 'empty' };
          } else {
            expected ??= installedSchema(folder);
            // 010: el tope solo se lee si las tablas son las que este núcleo conoce.
            result = {
              kind: 'known',
              schema,
              spendCap: sameSchema(schema, expected)
                ? await readSpendCap(client, protection)
                : null,
            };
          }
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
 * Reglas en orden (R3; reordenadas en la 016, data-model §3):
 *
 * 1. la instancia no está lista → `not_ready` (sin consultar la BD);
 * 2. el sondeo **falla o se pasa de plazo** → `db_unavailable` (la BD no contesta);
 * 3. el sondeo contesta `empty`, `unknown` o con otro esquema → `degraded`;
 * 4. en otro caso → `ok`.
 *
 * El criterio es «contesta o no contesta», no la causa: por eso cualquier fallo del sondeo es
 * `db_unavailable` y no hace falta clasificar el error (ni, por tanto, tocarlo).
 */
export async function buildHealthReport(deps: HealthReportDeps): Promise<HealthReport> {
  const expected = deps.expected ?? installedSchema();
  const base = {
    coreVersion: deps.coreVersion,
    expected: { index: expected.index, tag: expected.tag },
  };
  const report = (
    status: HealthStatus,
    applied: SchemaRef | null,
    spendCap: SpendCapReport | null = null,
  ): HealthReport => ({
    status,
    coreVersion: base.coreVersion,
    schema: { applied, expected: base.expected },
    spendCap,
  });

  if (deps.lifecycle.state !== 'ready') return report('not_ready', null);

  let result: ProbeResult;
  try {
    result = await withTimeout(deps.probe.read(), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  } catch {
    // Sin la causa: ni en el informe ni en los registros. El vigilante se entera del corte por
    // el oyente del pool del sondeo, no por aquí, para no depender del momento de la petición.
    return report('db_unavailable', null);
  }
  switch (result.kind) {
    case 'empty':
      return report('degraded', null);
    case 'unknown':
      return report('degraded', { index: result.index, tag: null });
    case 'known': {
      const { schema } = result;
      const applied = { index: schema.index, tag: schema.tag };
      // El tope no cambia el estado (FR-023a); con otro esquema no se informa.
      return sameSchema(schema, expected)
        ? report('ok', applied, result.spendCap ?? null)
        : report('degraded', applied);
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
  /** Producción y modelos de la instancia (012); sin ella, como fuera de producción. */
  protection?: ProtectionConfig;
  /** 016: el vigilante del corte, avisado por el oyente del pool del sondeo. */
  onPoolError?: (error: unknown) => void;
}): InstanceHealth {
  const lifecycle = options.lifecycle ?? createLifecycle();
  const folder = options.folder ?? defaultMigrationsFolder;
  const probe = createSchemaProbe(
    options.databaseUrl,
    folder,
    options.protection,
    options.onPoolError,
  );
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
    // 010: solo el nivel; sin importes, precios, moneda ni porcentajes.
    spendCap: report.spendCap,
  };
}
