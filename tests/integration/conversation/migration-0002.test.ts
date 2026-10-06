/**
 * Migración 0001 → 0002 con datos (FR-005, contracts/conversation-channels.md garantía 3):
 * los clientes, conversaciones y mensajes de WhatsApp se conservan con sus ids, estados y
 * relaciones, y el chat web queda creado y desactivado.
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

describe('migración 0002_channels con datos', () => {
  const adminUrl = inject('pgAdminUrl');
  const name = `mig_${randomUUID().replaceAll('-', '')}`;
  let db: Db;
  let partial: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    db = createDb(withDatabase(adminUrl, name));
    partial = firstMigrations(2);
    await migrate(db, { migrationsFolder: partial });
  });

  afterAll(async () => {
    await closeDb(db);
    rmSync(partial, { recursive: true, force: true });
  });

  it('conserva clientes, conversaciones y mensajes como canal whatsapp', async () => {
    const q = (text: string, values: unknown[] = []) => db.$client.query(text, values);
    const customers = ['+34600111222', '+34600333444'];
    const ids: string[] = [];
    for (const phone of customers) {
      const { rows } = await q('insert into customer (phone) values ($1) returning id', [phone]);
      ids.push((rows[0] as { id: string }).id);
    }
    const at = '2026-09-24T08:00:00Z';
    const { rows: convs } = await q(
      `insert into conversation (customer_id, started_at, last_inbound_at, last_message_at, greeted)
       values ($1, $3, $3, $3, true), ($2, $3, $3, $3, false) returning id`,
      [ids[0], ids[1], at],
    );
    const [c1, c2] = convs.map((r) => (r as { id: string }).id);
    const { rows: out } = await q(
      `insert into message (conversation_id, direction, kind, wa_message_id, body, sent_at, received_at, status)
       values ($1, 'outbound', 'text', 'wamid.out.1', 'Respuesta', $2, $2, 'sent') returning id`,
      [c1, at],
    );
    const replyId = (out[0] as { id: string }).id;
    await q(
      `insert into message (conversation_id, direction, kind, wa_message_id, body, sent_at, received_at, status, reply_id)
       values ($1, 'inbound', 'text', 'wamid.in.1', 'Hola', $3, $3, 'answered', $4),
              ($2, 'inbound', 'text', 'wamid.in.2', 'Otra', $3, $3, 'pending', null),
              ($2, 'inbound', 'other', 'wamid.in.3', null, $3, $3, 'rate_limited', null)`,
      [c1, c2, at, replyId],
    );

    await migrate(db, { migrationsFolder });

    const count = async (table: string) =>
      Number(((await q(`select count(*) as n from ${table}`)).rows[0] as { n: string }).n);
    expect(await count('customer')).toBe(2);
    expect(await count('conversation')).toBe(2);
    expect(await count('message')).toBe(4);

    const { rows: migrated } = await q(
      'select id, channel, channel_user_id from customer order by channel_user_id',
    );
    expect(migrated).toEqual([
      { id: ids[0], channel: 'whatsapp', channel_user_id: customers[0] },
      { id: ids[1], channel: 'whatsapp', channel_user_id: customers[1] },
    ]);

    const { rows: msgs } = await q(
      `select conversation_id, channel_message_id, status, reply_id, reply_trace
       from message order by channel_message_id`,
    );
    expect(msgs).toEqual([
      { conversation_id: c1, channel_message_id: 'wamid.in.1', status: 'answered', reply_id: replyId, reply_trace: null },
      { conversation_id: c2, channel_message_id: 'wamid.in.2', status: 'pending', reply_id: null, reply_trace: null },
      { conversation_id: c2, channel_message_id: 'wamid.in.3', status: 'rate_limited', reply_id: null, reply_trace: null },
      { conversation_id: c1, channel_message_id: 'wamid.out.1', status: 'sent', reply_id: null, reply_trace: null },
    ]);

    const { rows: greetedRows } = await q('select id, greeted from conversation order by greeted');
    expect(greetedRows).toEqual([
      { id: c2, greeted: false },
      { id: c1, greeted: true },
    ]);

    // Deduplicación y unicidad por (canal, id) siguen activas tras renombrar.
    await expect(
      q(
        `insert into message (conversation_id, direction, kind, channel_message_id, sent_at, received_at, status)
         values ($1, 'inbound', 'text', 'wamid.in.1', $2, $2, 'pending')`,
        [c1, at],
      ),
    ).rejects.toThrow(/message_channel_message_id_unique/);
    await expect(
      q(`insert into customer (channel, channel_user_id) values ('whatsapp', $1)`, [customers[0]]),
    ).rejects.toThrow(/customer_channel_user_unique/);
    await q(`insert into customer (channel, channel_user_id) values ('playground', $1)`, [
      customers[0],
    ]);
    // Sin valor por defecto: todo cliente nuevo declara su canal.
    await expect(q(`insert into customer (channel_user_id) values ('x')`)).rejects.toThrow(
      /channel/,
    );

    const { rows: settings } = await q(
      'select id, enabled, allowed_origins, privacy_url, daily_cap, monthly_cap from web_chat_settings',
    );
    expect(settings).toEqual([
      { id: 1, enabled: false, allowed_origins: [], privacy_url: null, daily_cap: 200, monthly_cap: 3000 },
    ]);
    await expect(q('insert into web_chat_settings (id) values (2)')).rejects.toThrow();
  });
});
