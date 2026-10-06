/**
 * Volcado lógico de datos (006, research R1, R2, contracts/backup-file-format.md).
 *
 * El volcador lee todo dentro de una transacción REPEATABLE READ de solo lectura: versión del
 * esquema, recuentos, filas (`COPY … TO STDOUT` en texto) y secuencias salen del mismo
 * instante (FR-002) sin bloquear las escrituras del bot. Las tablas se leen del catálogo de
 * PostgreSQL, nunca de una lista escrita a mano (FR-023).
 *
 * El lector recorre el volcado en claro, valida cada registro contra la cabecera y entrega las
 * filas de cada tabla para cargarlas con `COPY … FROM STDIN`.
 */
import { Readable } from 'node:stream';
import type pg from 'pg';
import { to as copyTo } from 'pg-copy-streams';
import { RestoreFailure } from './errors.js';
import type { BackupHeader } from './format.js';
import { databaseSchema, type Queryable, type SchemaVersion } from './schema-version.js';

export const DUMP_SCHEMAS = ['drizzle', 'public'] as const;

/**
 * Parámetros de sesión fijos para volcar y cargar: el texto de `COPY` de fechas, números y
 * binarios depende de ellos.
 */
export const DUMP_SESSION_OPTIONS =
  '-c timezone=UTC -c datestyle=ISO,YMD -c intervalstyle=postgres -c extra_float_digits=3 -c bytea_output=hex -c client_encoding=UTF8';

export interface DumpTable {
  schema: string;
  name: string;
  columns: string[];
  rows: number;
}

export interface SequenceValue {
  schema: string;
  name: string;
  value: string;
  called: boolean;
}

export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const qualified = (schema: string, name: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(name)}`;

/** Tablas de `public` y `drizzle` en orden alfabético (esquema, nombre), con sus columnas. */
export async function listTables(client: Queryable): Promise<Array<Omit<DumpTable, 'rows'>>> {
  const tables = await client.query<{ schema: string; name: string; columns: string[] }>(
    `select n.nspname as schema, c.relname as name,
            array(
              select a.attname::text from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                and a.attgenerated = ''
              order by a.attnum
            ) as columns
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and not c.relispartition
        and n.nspname = any($1::text[])
      order by n.nspname, c.relname`,
    [DUMP_SCHEMAS],
  );
  return tables.rows;
}

export async function listSequences(client: Queryable): Promise<SequenceValue[]> {
  const names = await client.query<{ schema: string; name: string }>(
    `select schemaname as schema, sequencename as name from pg_sequences
      where schemaname = any($1::text[]) order by schemaname, sequencename`,
    [DUMP_SCHEMAS],
  );
  const values: SequenceValue[] = [];
  for (const { schema, name } of names.rows) {
    const row = await client.query<{ last_value: string; is_called: boolean }>(
      `select last_value::text, is_called from ${qualified(schema, name)}`,
    );
    values.push({
      schema,
      name,
      value: row.rows[0]?.last_value ?? '1',
      called: row.rows[0]?.is_called ?? false,
    });
  }
  return values;
}

export async function countRows(client: Queryable, schema: string, name: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    `select count(*)::text as n from ${qualified(schema, name)}`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

export interface OpenedDump {
  schema: SchemaVersion;
  tables: DumpTable[];
  /** Volcado en claro; al terminar cierra la transacción. */
  stream: Readable;
}

export interface DumpHooks {
  /** Se llama al emitir el registro `table` de cada tabla, antes de sus filas (tests). */
  onTable?: (table: DumpTable) => void | Promise<void>;
}

/** Error al leer la BD durante el volcado (se traduce a `db_error`). */
export class DumpReadError extends Error {
  constructor() {
    super('Error al leer la base de datos durante la copia');
    this.name = 'DumpReadError';
  }
}

const line = (record: object): Buffer => Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
const TERMINATOR = Buffer.from('\\.\n', 'utf8');

/**
 * Abre la instantánea y devuelve la versión del esquema y los recuentos antes de emitir filas.
 * `client` debe ser una conexión propia abierta con `DUMP_SESSION_OPTIONS`; la transacción se
 * cierra al terminar o al fallar el flujo.
 */
export async function openDump(client: pg.ClientBase, hooks: DumpHooks = {}): Promise<OpenedDump> {
  await client.query('begin isolation level repeatable read read only');
  try {
    const schema = await databaseSchema(client);
    if (schema === 'empty') throw new Error('La BD no tiene esquema');
    const tables: DumpTable[] = [];
    for (const table of await listTables(client)) {
      tables.push({ ...table, rows: await countRows(client, table.schema, table.name) });
    }
    const sequences = await listSequences(client);

    async function* generate(): AsyncGenerator<Buffer> {
      let committed = false;
      try {
        yield line({ t: 'begin', schema });
        for (const table of tables) {
          yield line({
            t: 'table',
            schema: table.schema,
            name: table.name,
            columns: table.columns,
            rows: table.rows,
          });
          await hooks.onTable?.(table);
          const columns = table.columns.map(quoteIdent).join(', ');
          const copy = client.query(
            copyTo(`copy ${qualified(table.schema, table.name)} (${columns}) to stdout`),
          );
          for await (const chunk of copy) yield chunk as Buffer;
          yield TERMINATOR;
        }
        yield line({ t: 'sequences', values: sequences });
        yield line({ t: 'end', tables: tables.length });
        await client.query('commit');
        committed = true;
      } catch {
        throw new DumpReadError();
      } finally {
        if (!committed) await client.query('rollback').catch(() => undefined);
      }
    }

    return { schema, tables, stream: Readable.from(generate(), { objectMode: false }) };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Lectura del volcado
// ---------------------------------------------------------------------------

const NEWLINE = 0x0a;

/** Lector de líneas sobre un flujo de bytes; las filas se entregan en trozos de varias líneas. */
class LineReader {
  private buffer: Buffer = Buffer.alloc(0);
  private done = false;
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    this.buffer = this.buffer.length === 0 ? next.value : Buffer.concat([this.buffer, next.value]);
    return true;
  }

  /** Siguiente línea sin el salto; `null` al final del flujo. */
  async line(): Promise<string | null> {
    for (;;) {
      const at = this.buffer.indexOf(NEWLINE);
      if (at >= 0) {
        const text = this.buffer.subarray(0, at).toString('utf8');
        this.buffer = this.buffer.subarray(at + 1);
        return text;
      }
      if (!(await this.fill())) {
        if (this.buffer.length > 0) throw new RestoreFailure('corrupted');
        return null;
      }
    }
  }

  /**
   * Filas de una tabla hasta la línea `\.` (excluida), en trozos que acaban en salto de línea.
   * `counter.rows` lleva las filas entregadas.
   */
  async *rows(counter: { rows: number }): AsyncGenerator<Buffer> {
    for (;;) {
      let start = 0;
      let at = this.buffer.indexOf(NEWLINE, start);
      while (at >= 0) {
        const isTerminator =
          at - start === 2 && this.buffer[start] === 0x5c && this.buffer[start + 1] === 0x2e;
        if (isTerminator) {
          if (start > 0) yield this.buffer.subarray(0, start);
          this.buffer = this.buffer.subarray(at + 1);
          return;
        }
        counter.rows += 1;
        start = at + 1;
        at = this.buffer.indexOf(NEWLINE, start);
      }
      if (start > 0) {
        const chunk = this.buffer.subarray(0, start);
        this.buffer = this.buffer.subarray(start);
        yield chunk;
      }
      if (!(await this.fill())) throw new RestoreFailure('corrupted');
    }
  }
}

function parseRecord(text: string | null): Record<string, unknown> {
  if (text === null) throw new RestoreFailure('corrupted');
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RestoreFailure('corrupted');
  }
}

export interface DumpHandlers {
  /** Debe consumir `rows` entero (p. ej. con `COPY … FROM STDIN`). */
  table(table: DumpTable, rows: AsyncIterable<Buffer>): Promise<void>;
  sequences?(values: SequenceValue[]): Promise<void>;
}

const sameSchema = (a: unknown, b: SchemaVersion): boolean => {
  const s = a as Partial<SchemaVersion> | null;
  return s?.index === b.index && s.tag === b.tag && s.hash === b.hash;
};

/**
 * Recorre el volcado validándolo contra la cabecera: esquema del `begin`, tablas en el orden y
 * con los recuentos de la cabecera, terminador de cada tabla, secuencias y `end`. Cualquier
 * desajuste es `RestoreFailure('corrupted')`.
 */
export async function readDump(
  source: AsyncIterable<Buffer>,
  header: BackupHeader,
  handlers: DumpHandlers,
): Promise<void> {
  const reader = new LineReader(source);
  const begin = parseRecord(await reader.line());
  if (begin.t !== 'begin' || !sameSchema(begin.schema, header.schema)) {
    throw new RestoreFailure('corrupted');
  }
  for (const expected of header.tables) {
    const record = parseRecord(await reader.line());
    const columns = record.columns;
    if (
      record.t !== 'table' ||
      record.schema !== expected.schema ||
      record.name !== expected.name ||
      record.rows !== expected.rows ||
      !Array.isArray(columns) ||
      columns.some((c) => typeof c !== 'string')
    ) {
      throw new RestoreFailure('corrupted');
    }
    const counter = { rows: 0 };
    const table: DumpTable = { ...expected, columns: columns as string[] };
    const state = { consumed: false };
    async function* rows() {
      yield* reader.rows(counter);
      state.consumed = true;
    }
    await handlers.table(table, rows());
    if (!state.consumed || counter.rows !== expected.rows) throw new RestoreFailure('corrupted');
  }
  const sequences = parseRecord(await reader.line());
  if (sequences.t !== 'sequences' || !Array.isArray(sequences.values)) {
    throw new RestoreFailure('corrupted');
  }
  const values = sequences.values as SequenceValue[];
  if (
    values.some(
      (v) =>
        typeof v.schema !== 'string' ||
        typeof v.name !== 'string' ||
        typeof v.value !== 'string' ||
        !/^-?\d+$/.test(v.value) ||
        typeof v.called !== 'boolean',
    )
  ) {
    throw new RestoreFailure('corrupted');
  }
  const end = parseRecord(await reader.line());
  if (end.t !== 'end' || end.tables !== header.tables.length) throw new RestoreFailure('corrupted');
  if ((await reader.line()) !== null) throw new RestoreFailure('corrupted');
  await handlers.sequences?.(values);
}

/** Recorre el volcado sin cargar nada (comprobación previa). */
export async function drainDump(
  source: AsyncIterable<Buffer>,
  header: BackupHeader,
): Promise<void> {
  await readDump(source, header, {
    async table(_table, rows) {
      for await (const _chunk of rows) {
        // Solo se valida.
      }
    },
  });
}
