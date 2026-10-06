/**
 * Migración 0007 → 0008 con datos (012, data-model.md §1): crea la fila única de los límites de
 * derivación con sus valores por defecto, rellena las marcas de las derivaciones existentes, deja
 * el tope diario de WhatsApp en 200, las restricciones rechazan valores fuera de rango y los
 * valores de enum nuevos se pueden usar después.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import { withDatabase } from '../helpers/db.js';

const migrationsFolder = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));

/** Carpeta de migraciones con solo las `count` primeras. */
function firstMigrations(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('migración 0008_abuse_protection con datos', () => {
  const adminUrl = inject('pgAdminUrl');
  const name = `mig_${randomUUID().replaceAll('-', '')}`;
  let db: Db;
  let partial: string;
  const q = (text: string, values: unknown[] = []) => db.$client.query(text, values);
  const one = async (text: string, values: unknown[] = []) =>
    (await q(text, values)).rows[0] as Record<string, unknown>;

  const withNotices = randomUUID();
  const withoutNotices = randomUUID();
  const STARTED = '2026-09-24T08:00:00.000Z';
  const LAST_NOTICE = '2026-09-24T09:30:00.000Z';

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    db = createDb(withDatabase(adminUrl, name));
    partial = firstMigrations(8);
    await migrate(db, { migrationsFolder: partial });

    // Una instancia en la 0007 con dos derivaciones: una con avisos y otra sin ellos.
    await q(
      `insert into business (id, name, timezone, currency, status)
       values (1, 'Negocio', 'Europe/Madrid', 'EUR', 'active')`,
    );
    const { rows } = await q(
      `insert into customer (channel, channel_user_id) values ('whatsapp', '+34600111222') returning id`,
    );
    const customerId = (rows[0] as { id: string }).id;
    const conversations: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await q(
        `insert into conversation (customer_id, started_at, last_inbound_at, last_message_at)
         values ($1, $2, $2, $2) returning id`,
        [customerId, STARTED],
      );
      conversations.push((res.rows[0] as { id: string }).id);
    }
    for (const [i, id] of [withNotices, withoutNotices].entries()) {
      await q(
        `insert into handoff (id, conversation_id, kind, status, summary, summary_source,
           token_hash, token_enc, started_at)
         values ($1, $2, 'person', 'active', 'Resumen', 'model', decode($3, 'hex'),
           decode('00', 'hex'), $4)`,
        [id, conversations[i], String(i).repeat(64), STARTED],
      );
    }
    for (const at of ['2026-09-24T08:00:00Z', LAST_NOTICE]) {
      await q(
        `insert into handoff_notice (handoff_id, type, route, status, created_at)
         values ($1, 'alert', 'email', 'sent', $2)`,
        [withNotices, at],
      );
    }

    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await closeDb(db);
    rmSync(partial, { recursive: true, force: true });
  });

  it('crea la fila única de límites de derivación con los valores por defecto', async () => {
    const { rows } = await q(
      'select id, daily_max, forward_interval_minutes, notices_daily_max from handoff_limits',
    );
    expect(rows).toEqual([
      { id: 1, daily_max: 20, forward_interval_minutes: 15, notices_daily_max: 60 },
    ]);
  });

  it('rellena las marcas de las derivaciones existentes', async () => {
    const row = async (id: string) =>
      one(
        `select alerts_sent_at, customer_notified_at, last_notice_at from handoff where id = $1`,
        [id],
      );
    const iso = (v: unknown) => (v as Date).toISOString();
    const a = await row(withNotices);
    expect([iso(a.alerts_sent_at), iso(a.customer_notified_at), iso(a.last_notice_at)]).toEqual([
      STARTED,
      STARTED,
      LAST_NOTICE,
    ]);
    const b = await row(withoutNotices);
    expect([iso(b.alerts_sent_at), iso(b.customer_notified_at), iso(b.last_notice_at)]).toEqual([
      STARTED,
      STARTED,
      STARTED,
    ]);
  });

  it('el tope diario de WhatsApp queda en 200 y las conversaciones sin espera', async () => {
    expect(
      await one('select whatsapp_daily_cap, whatsapp_cap_notified_day from usage_settings'),
    ).toEqual({ whatsapp_daily_cap: 200, whatsapp_cap_notified_day: null });
    expect(
      await one('select min(batch_attempts) as a, count(process_after)::int as p from conversation'),
    ).toEqual({ a: 0, p: 0 });
  });

  it.each([
    ['handoff_limits con id = 2', 'insert into handoff_limits (id) values (2)', /handoff_limits/],
    ['daily_max = 0', 'update handoff_limits set daily_max = 0', /handoff_limits_daily_max/],
    ['daily_max = 201', 'update handoff_limits set daily_max = 201', /handoff_limits_daily_max/],
    [
      'intervalo de 4 minutos',
      'update handoff_limits set forward_interval_minutes = 4',
      /handoff_limits_interval/,
    ],
    [
      'intervalo de 241 minutos',
      'update handoff_limits set forward_interval_minutes = 241',
      /handoff_limits_interval/,
    ],
    ['9 avisos al día', 'update handoff_limits set notices_daily_max = 9', /handoff_limits_notices/],
    [
      '501 avisos al día',
      'update handoff_limits set notices_daily_max = 501',
      /handoff_limits_notices/,
    ],
    [
      'tope de WhatsApp 0',
      'update usage_settings set whatsapp_daily_cap = 0',
      /usage_settings_whatsapp_cap/,
    ],
    [
      'tope de WhatsApp 10001',
      'update usage_settings set whatsapp_daily_cap = 10001',
      /usage_settings_whatsapp_cap/,
    ],
    [
      'precio de transcripción negativo',
      `insert into transcription_price (model, micros_per_minute) values ('m', -1)`,
      /transcription_price_non_negative/,
    ],
    [
      'respuestas de WhatsApp negativas',
      `insert into whatsapp_usage_day (day, replies) values ('2026-10-01', -1)`,
      /whatsapp_usage_day_replies/,
    ],
    [
      'contador de derivaciones negativo',
      `insert into handoff_day (day, notices_held) values ('2026-10-01', -1)`,
      /handoff_day_counters/,
    ],
    [
      'seis intentos de lote',
      'update conversation set batch_attempts = 6',
      /conversation_batch_attempts/,
    ],
  ])('rechaza %s', async (_name, statement, error) => {
    await expect(q(statement)).rejects.toThrow(error);
  });

  it('los valores de enum nuevos se pueden usar', async () => {
    await q(
      `insert into model_usage (at, day, channel, purpose, model, calls, input_tokens,
         output_tokens, cache_write_tokens, cache_read_tokens, audio_ms)
       values (now(), '2026-10-01', 'whatsapp', 'transcription', 'whisper-1', 1, 0, 0, 0, 0, 3000)`,
    );
    await expect(
      q(
        `insert into model_usage (at, day, channel, purpose, model, calls, input_tokens,
           output_tokens, cache_write_tokens, cache_read_tokens, audio_ms)
         values (now(), '2026-10-01', 'whatsapp', 'transcription', 'w', 1, 0, 0, 0, 0, -1)`,
      ),
    ).rejects.toThrow(/model_usage_audio_ms/);
    await q(
      `update handoff set status = 'ended', ended_at = now(), end_cause = 'interrupted'
       where id = $1`,
      [withoutNotices],
    );
    const conversation = await one(`select id from conversation limit 1`);
    await q(
      `insert into message (conversation_id, direction, kind, body, sent_at, received_at, status)
       values ($1, 'inbound', 'text', 'hola', now(), now(), 'held')`,
      [conversation.id],
    );
    expect(await one(`select count(*)::int as n from message where status = 'held'`)).toEqual({
      n: 1,
    });
  });
});
