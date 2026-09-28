/**
 * Migración 0003 → 0004 con datos (005, data-model.md): las conversaciones y mensajes
 * existentes se conservan, las columnas nuevas quedan nulas, los destinos de avisos quedan
 * creados y vacíos, y las restricciones de `handoff` funcionan.
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

describe('migración 0004_handoff con datos', () => {
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
    partial = firstMigrations(4);
    await migrate(db, { migrationsFolder: partial });
  });

  afterAll(async () => {
    await closeDb(db);
    rmSync(partial, { recursive: true, force: true });
  });

  it('conserva los datos, crea los destinos vacíos y aplica las restricciones', async () => {
    const q = (text: string, values: unknown[] = []) => db.$client.query(text, values);
    const at = '2026-09-24T08:00:00Z';
    const { rows: customers } = await q(
      `insert into customer (channel, channel_user_id) values ('whatsapp', '+34600111222'),
       ('web', 'abc') returning id`,
    );
    const [u1, u2] = customers.map((r) => (r as { id: string }).id) as [string, string];
    const { rows: convs } = await q(
      `insert into conversation (customer_id, started_at, last_inbound_at, last_message_at, greeted)
       values ($1, $3, $3, $3, true), ($2, $3, $3, $3, false) returning id`,
      [u1, u2, at],
    );
    const [c1, c2] = convs.map((r) => (r as { id: string }).id) as [string, string];
    await q(
      `insert into message (conversation_id, direction, kind, channel_message_id, body, sent_at, received_at, status)
       values ($1, 'inbound', 'text', 'wamid.in.1', 'Hola', $3, $3, 'answered'),
              ($2, 'inbound', 'text', null, 'Otra', $3, $3, 'pending')`,
      [c1, c2, at],
    );

    await migrate(db, { migrationsFolder });

    const count = async (table: string) =>
      Number(((await q(`select count(*) as n from ${table}`)).rows[0] as { n: string }).n);
    expect(await count('customer')).toBe(2);
    expect(await count('conversation')).toBe(2);
    expect(await count('message')).toBe(2);
    expect(await count('handoff')).toBe(0);
    expect(await count('handoff_notice')).toBe(0);

    const { rows: newColumns } = await q(
      'select contact_name, contact_phone, handoff_step from conversation',
    );
    expect(newColumns).toEqual([
      { contact_name: null, contact_phone: null, handoff_step: null },
      { contact_name: null, contact_phone: null, handoff_step: null },
    ]);

    const { rows: alerts } = await q('select id, whatsapp_phone, email from handoff_alerts');
    expect(alerts).toEqual([{ id: 1, whatsapp_phone: null, email: null }]);
    await expect(q('insert into handoff_alerts (id) values (2)')).rejects.toThrow();

    // El estado nuevo de los mensajes se puede usar después de la migración.
    await q(
      `insert into message (conversation_id, direction, kind, body, sent_at, received_at, status)
       values ($1, 'inbound', 'text', 'Reenviado', $2, $2, 'forwarded')`,
      [c1, at],
    );

    const insertHandoff = (conversationId: string, status: 'active' | 'ended') =>
      q(
        `insert into handoff (id, conversation_id, kind, status, summary, summary_source, token_hash,
           started_at, ended_at, end_cause)
         values ($1, $2, 'person', $3, 'Motivo', 'model', $4, $5, $6, $7) returning id`,
        [
          randomUUID(),
          conversationId,
          status,
          Buffer.from(randomUUID()),
          at,
          status === 'ended' ? at : null,
          status === 'ended' ? 'operator' : null,
        ],
      );

    const { rows: handoffs } = await insertHandoff(c1, 'active');
    const handoffId = (handoffs[0] as { id: string }).id;
    // Como mucho una activa por conversación; las terminadas no cuentan.
    await expect(insertHandoff(c1, 'active')).rejects.toThrow(
      /handoff_one_active_per_conversation/,
    );
    await insertHandoff(c1, 'ended');
    // `ended` exige fecha y causa; la confirmación va con su vía.
    await expect(
      q(
        `insert into handoff (id, conversation_id, kind, status, summary, summary_source, token_hash, started_at)
         values ($1, $2, 'person', 'ended', 'M', 'model', $3, $4)`,
        [randomUUID(), c2, Buffer.from('x'), at],
      ),
    ).rejects.toThrow(/handoff_ended/);
    await expect(
      q(`update handoff set confirmed_at = $2 where id = $1`, [handoffId, at]),
    ).rejects.toThrow(/handoff_confirmed/);

    await q(
      `insert into handoff_notice (handoff_id, type, route, status, created_at)
       values ($1, 'alert', 'email', 'sent', $2)`,
      [handoffId, at],
    );

    // Borrar la conversación borra sus derivaciones y avisos (FR-023).
    await q('delete from conversation where id = $1', [c1]);
    expect(await count('handoff')).toBe(0);
    expect(await count('handoff_notice')).toBe(0);
  });
});
