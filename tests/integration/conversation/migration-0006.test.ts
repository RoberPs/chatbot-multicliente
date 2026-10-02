/**
 * Migración 0005 → 0006 con datos (010, data-model.md §1): conserva lo que había, crea la fila
 * única de `usage_settings` en USD con el tope desactivado, y las restricciones de las tablas
 * nuevas rechazan valores imposibles.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { closeDb, createDb, type Db } from '../../../src/db/client.js';
import { withDatabase } from '../../helpers/db.js';

const migrationsFolder = fileURLToPath(new URL('../../../src/db/migrations', import.meta.url));

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

describe('migración 0006_usage con datos', () => {
  const adminUrl = inject('pgAdminUrl');
  const name = `mig_${randomUUID().replaceAll('-', '')}`;
  let db: Db;
  let partial: string;
  const q = (text: string, values: unknown[] = []) => db.$client.query(text, values);

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    db = createDb(withDatabase(adminUrl, name));
    partial = firstMigrations(6);
    await migrate(db, { migrationsFolder: partial });

    // Datos de una instancia en la 0005.
    await q(
      `insert into business (id, name, timezone, currency, status)
       values (1, 'Negocio', 'Europe/Madrid', 'EUR', 'active')`,
    );
    const { rows } = await q(
      `insert into customer (channel, channel_user_id) values ('whatsapp', '+34600111222') returning id`,
    );
    const at = '2026-09-24T08:00:00Z';
    await q(
      `insert into conversation (customer_id, started_at, last_inbound_at, last_message_at)
       values ($1, $2, $2, $2)`,
      [(rows[0] as { id: string }).id, at],
    );
    await q(`insert into web_usage_day (day, replies) values ('2026-09-24', 7)`);

    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await closeDb(db);
    rmSync(partial, { recursive: true, force: true });
  });

  it('conserva los datos anteriores', async () => {
    const one = async (text: string) => (await q(text)).rows[0] as Record<string, unknown>;
    expect(await one('select name, status from business')).toEqual({
      name: 'Negocio',
      status: 'active',
    });
    expect(await one('select count(*)::int as n from conversation')).toEqual({ n: 1 });
    expect(await one('select replies from web_usage_day')).toEqual({ replies: 7 });
  });

  it('crea la fila única de ajustes en USD con el tope desactivado y sin precios', async () => {
    const { rows } = await q(
      'select id, currency, cap_enabled, monthly_cap_cents, cap_notified_month from usage_settings',
    );
    expect(rows).toEqual([
      {
        id: 1,
        currency: 'USD',
        cap_enabled: false,
        monthly_cap_cents: null,
        cap_notified_month: null,
      },
    ]);
    expect((await q('select count(*)::int as n from model_price')).rows[0]).toEqual({ n: 0 });
    expect((await q('select count(*)::int as n from model_usage')).rows[0]).toEqual({ n: 0 });
    await expect(q('insert into usage_settings (id) values (2)')).rejects.toThrow(
      /usage_settings_singleton/,
    );
  });

  describe('restricciones', () => {
    const usage = (overrides: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        at: '2026-10-01T08:00:00Z',
        day: '2026-10-01',
        channel: 'whatsapp',
        purpose: 'reply',
        model: 'modelo-x',
        calls: 1,
        input_tokens: 10,
        output_tokens: 5,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        cost_pico: null,
        currency: null,
        ...overrides,
      };
      const cols = Object.keys(row);
      return q(
        `insert into model_usage (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('acepta un registro sin precio y otro con coste y moneda', async () => {
      await usage();
      await usage({
        cost_pico: '123456789',
        currency: 'USD',
        channel: 'playground',
        purpose: 'handoff_summary',
      });
    });

    it.each([
      ['tokens negativos', { input_tokens: -1 }, /model_usage_tokens/],
      ['salida negativa', { output_tokens: -1 }, /model_usage_tokens/],
      ['caché negativa', { cache_read_tokens: -1 }, /model_usage_tokens/],
      ['calls = 0', { calls: 0 }, /model_usage_calls/],
      ['coste negativo', { cost_pico: '-1', currency: 'USD' }, /model_usage_cost/],
      ['coste sin moneda', { cost_pico: '100' }, /model_usage_cost_currency/],
      ['moneda sin coste', { currency: 'USD' }, /model_usage_cost_currency/],
      ['propósito desconocido', { purpose: 'otro' }, /usage_purpose/],
    ])('model_usage rechaza %s', async (_name, overrides, error) => {
      await expect(usage(overrides)).rejects.toThrow(error);
    });

    it('model_price rechaza precios negativos', async () => {
      await expect(
        q(
          `insert into model_price (model, input_micros_per_mtok, output_micros_per_mtok,
             cache_write_micros_per_mtok, cache_read_micros_per_mtok) values ('m', -1, 0, 0, 0)`,
        ),
      ).rejects.toThrow(/model_price_non_negative/);
    });

    it('usage_settings rechaza un tope activo sin importe o con importe cero', async () => {
      await expect(q('update usage_settings set cap_enabled = true')).rejects.toThrow(
        /usage_settings_cap/,
      );
      await expect(
        q('update usage_settings set cap_enabled = true, monthly_cap_cents = 0'),
      ).rejects.toThrow(/usage_settings_cap/);
      await q('update usage_settings set cap_enabled = true, monthly_cap_cents = 5000');
      // Desactivar conserva el importe.
      await q('update usage_settings set cap_enabled = false');
      expect((await q('select monthly_cap_cents from usage_settings')).rows[0]).toEqual({
        monthly_cap_cents: 5000,
      });
    });
  });
});
