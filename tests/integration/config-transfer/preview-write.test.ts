/** Ensayo de una escritura con reversión (008, research R6, FR-014). */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { faq, handoffChannel, handoffContact } from '../../../src/db/schema.js';
import { touch } from '../../../src/db/timestamps.js';
import {
  previewWrite,
  runGuardedWrite,
} from '../../../src/knowledge/services/guarded-write.js';
import { configTablesFingerprint, seedFullBusiness } from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

describe('previewWrite', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await seedFullBusiness(t.deps);
  });

  const maxUpdatedAt = async () =>
    (await t.db.execute<{ m: string }>(sql`select max(updated_at)::text as m from faq`)).rows[0]?.m;

  it('ejecuta fn, devuelve antes, después y avisos, y nunca confirma', async () => {
    const fingerprint = await configTablesFingerprint(t.db);
    const max = await maxUpdatedAt();
    const preview = await previewWrite(t.db, async (tx) => {
      await tx.insert(faq).values({ question: '¿Nueva?', answer: 'Sí.', sortOrder: 9, ...touch() });
      return 'hecho';
    });
    expect(preview.result).toBe('hecho');
    expect(preview.before.faqs).toHaveLength(2);
    expect(preview.after.faqs).toHaveLength(3);
    expect(preview.blocked).toBe(false);
    expect(Array.isArray(preview.warnings)).toBe(true);
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
    expect(await maxUpdatedAt()).toBe(max);
  });

  it('dice si la escritura protegida lo rechazaría (activo con crítico) sin cambiar nada', async () => {
    const fingerprint = await configTablesFingerprint(t.db);
    const preview = await previewWrite(t.db, async (tx) => {
      await tx.delete(handoffChannel);
      await tx.delete(handoffContact);
      await tx.execute(sql`update business set phone = null`);
    });
    expect(preview.blocked).toBe(true);
    expect(preview.warnings.map((w) => w.code)).toContain('HANDOFF_UNREACHABLE');
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
  });

  it('si fn lanza, el error sale y no queda nada', async () => {
    const fingerprint = await configTablesFingerprint(t.db);
    await expect(
      previewWrite(t.db, async (tx) => {
        await tx.insert(faq).values({ question: '¿Otra?', answer: 'No.', sortOrder: 9, ...touch() });
        throw new Error('fallo a mitad');
      }),
    ).rejects.toThrow('fallo a mitad');
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
  });

  it('toma el bloqueo del negocio: una escritura simultánea espera a que termine', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const order: string[] = [];

    const preview = previewWrite(t.db, async () => {
      entered();
      await gate;
      order.push('ensayo');
    });
    await inside;
    const write = runGuardedWrite(t.db, async (tx) => {
      order.push('escritura');
      await tx.insert(faq).values({ question: '¿Tras el ensayo?', answer: 'Sí.', sortOrder: 9, ...touch() });
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual([]);
    release();
    await Promise.all([preview, write]);
    expect(order).toEqual(['ensayo', 'escritura']);
  });
});
