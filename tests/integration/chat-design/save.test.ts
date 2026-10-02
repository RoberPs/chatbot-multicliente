/**
 * Guardado del diseño en la BD (011, R1, FR-014, FR-017).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { business, webChatSettings } from '../../../src/db/schema.js';
import { ORIGINAL_DESIGN } from '../../../src/webchat/design/defaults.js';
import { readChatDesign, saveChatDesign } from '../../../src/webchat/design/store.js';
import { GREEN_PALETTE } from '../../helpers/chat-design.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

describe('saveChatDesign', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });

  it('guardar y releer devuelve lo guardado', async () => {
    const options = {
      ...ORIGINAL_DESIGN,
      ...GREEN_PALETTE,
      shape: 'soft' as const,
      position: 'left' as const,
      size: 'large' as const,
      chatName: 'Recepción',
      welcomeText: 'Hola\nQué tal',
      placeholder: 'Pregunta',
      sendLabel: 'Ir',
    };
    await saveChatDesign(t.db, options);
    const read = await readChatDesign(t.db);
    expect(read.saved).toBe(true);
    expect(read.options).toEqual(options);
    expect(read.unsupported).toEqual([]);
  });

  it('dos guardados seguidos: gana el último (FR-017)', async () => {
    await saveChatDesign(t.db, { ...ORIGINAL_DESIGN, chatName: 'Primero', shape: 'square' });
    await saveChatDesign(t.db, { ...ORIGINAL_DESIGN, chatName: 'Segundo' });
    const read = await readChatDesign(t.db);
    expect(read.options.chatName).toBe('Segundo');
    // Reemplaza la fila entera: la forma del primero no se queda.
    expect(read.options.shape).toBe('round');
  });

  it('guardar con el chat desactivado no cambia web_chat_settings ni el negocio (FR-014)', async () => {
    const [settingsBefore] = await t.db.select().from(webChatSettings);
    const [businessBefore] = await t.db.select().from(business);
    await saveChatDesign(t.db, { ...ORIGINAL_DESIGN, ...GREEN_PALETTE });
    expect((await t.db.select().from(webChatSettings))[0]).toEqual(settingsBefore);
    expect((await t.db.select().from(business))[0]).toEqual(businessBefore);
    expect((await readChatDesign(t.db)).saved).toBe(true);
  });
});
