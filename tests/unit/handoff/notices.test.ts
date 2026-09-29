/** Composición de los avisos al negocio (005, contracts/business-alerts.md). */
import { describe, expect, it } from 'vitest';
import {
  alertEmail,
  alertNotice,
  alertTemplateVars,
  describeChannel,
  describeKind,
  describeSince,
  forwardEmail,
  forwardNotice,
  forwardTemplateVars,
  reminderEmail,
  reminderNotice,
  reminderTemplateVars,
  sanitizeTemplateVar,
} from '../../../src/handoff/notices.js';
import type { BusinessNotice, ForwardItem } from '../../../src/handoff/types.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const startedAt = new Date('2026-10-01T19:40:00Z'); // jueves 21:40 en Madrid

const notice = (overrides: Partial<Parameters<typeof alertNotice>[0]> = {}) =>
  alertNotice({
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    kind: 'person',
    customerName: 'Lucía',
    customerPhone: '+34611222333',
    channel: 'web',
    summary: 'Pregunta por el precio del tinte y quiere hablar con alguien.',
    startedAt,
    timezone: 'Europe/Madrid',
    token: TOKEN,
    ...overrides,
  });

describe('textos comunes', () => {
  it('canal y tipo en palabras', () => {
    expect(describeChannel('whatsapp')).toBe('WhatsApp');
    expect(describeChannel('web')).toBe('chat de la web');
    expect(describeChannel('playground')).toBe('prueba del panel');
    expect(describeKind('person')).toBe('quiere hablar con una persona');
    expect(describeKind('unresolved')).toBe('consulta sin resolver');
    expect(describeKind('complaint')).toBe('queja o reclamación');
  });

  it('"desde" en hora local del negocio', () => {
    const tz = 'Europe/Madrid';
    expect(describeSince(startedAt, new Date('2026-10-01T20:00:00Z'), tz)).toBe('hoy a las 21:40');
    expect(describeSince(startedAt, new Date('2026-10-02T08:00:00Z'), tz)).toBe('ayer a las 21:40');
    expect(describeSince(startedAt, new Date('2026-10-05T08:00:00Z'), tz)).toBe(
      'el 1 de octubre a las 21:40',
    );
  });
});

describe('aviso de derivación', () => {
  it('compone el aviso sin hilo de email', () => {
    const n = notice();
    expect(n.type).toBe('alert');
    expect(n.handoff).toMatchObject({ customerName: 'Lucía', token: TOKEN, threadRef: null });
  });

  it('variables de la plantilla derivacion_aviso en orden', () => {
    expect(alertTemplateVars(notice())).toEqual([
      'Lucía',
      '+34 611 22 23 33',
      'chat de la web',
      'quiere hablar con una persona',
      'Pregunta por el precio del tinte y quiere hablar con alguien.',
    ]);
  });

  it('variables saneadas: sin saltos, tabuladores, 5 espacios seguidos ni vacías', () => {
    const vars = alertTemplateVars(
      notice({ customerName: 'Ana\n\tMaría', summary: 'uno\n\ndos     tres\t' }),
    );
    for (const v of vars) {
      expect(v).not.toMatch(/[\n\t]| {5}/);
      expect(v.length).toBeGreaterThan(0);
    }
    expect(vars[0]).toBe('Ana María');
    expect(vars[4]).toBe('uno dos tres');
    expect(sanitizeTemplateVar('   ')).toBe('—');
  });

  it('email: asunto y cuerpo del contrato con los dos enlaces', () => {
    const now = new Date('2026-10-01T19:41:00Z');
    const email = alertEmail(notice(), now, 'https://chat.ejemplo.com');
    expect(email.subject).toBe('Derivación: Lucía (quiere hablar con una persona)');
    expect(email.text).toContain('El asistente ha pasado una conversación a tu negocio.');
    expect(email.text).toContain('Cliente: Lucía');
    expect(email.text).toContain('Teléfono: +34 611 22 23 33');
    expect(email.text).toContain('Canal: chat de la web');
    expect(email.text).toContain('Tipo: quiere hablar con una persona');
    expect(email.text).toContain('Desde: hoy a las 21:40');
    expect(email.text).toContain(
      'Motivo: Pregunta por el precio del tinte y quiere hablar con alguien.',
    );
    expect(email.text).toContain(`Le atiendo: https://chat.ejemplo.com/handoff/${TOKEN}/attend`);
    expect(email.text).toContain(`Terminado:  https://chat.ejemplo.com/handoff/${TOKEN}/end`);
    expect(email.text).toContain('Si no confirmas en 2 horas de tu horario de atención');
  });

  it('sin URL pública (playground) el texto no inventa enlaces', () => {
    const email = alertEmail(notice({ channel: 'playground' }), startedAt, null);
    expect(email.text).not.toContain('/handoff/');
    expect(email.text).toContain('Canal: prueba del panel');
  });
});

describe('reenvío durante la derivación (US3, FR-014)', () => {
  const item = (text: string | null, extra: Partial<ForwardItem> = {}): ForwardItem => ({
    text,
    kind: 'text',
    otherType: null,
    sentAt: new Date('2026-10-01T19:45:00Z'),
    ...extra,
  });
  const forward = (items: ForwardItem[], emailAvailable = true) =>
    forwardNotice(
      { ...notice().handoff, threadRef: '<aviso@smtp>' },
      items,
      emailAvailable,
    ) as Extract<BusinessNotice, { type: 'forward' }>;

  it('ítems en orden; archivo sin texto → [tipo]; audio transcrito → su texto', () => {
    const n = forward([
      item('Llego tarde'),
      item(null, { kind: 'other', otherType: 'image' }),
      item('Te lo digo por audio', { kind: 'audio' }),
      item(null, { kind: 'audio' }),
    ]);
    expect(forwardTemplateVars(n)).toEqual([
      'Lucía',
      '+34 611 22 23 33',
      'Llego tarde / [image] / Te lo digo por audio / [audio]',
    ]);
  });

  it('{{3}} recortado a 700 con la coletilla según haya email o no', () => {
    const long = [item('a'.repeat(400)), item('b'.repeat(400))];
    const withEmail = forwardTemplateVars(forward(long, true))[2] ?? '';
    expect(withEmail).toHaveLength(700);
    expect(withEmail.endsWith('… (mensaje recortado; el texto completo está en el email)')).toBe(
      true,
    );
    const withoutEmail = forwardTemplateVars(forward(long, false))[2] ?? '';
    expect(withoutEmail).toHaveLength(700);
    expect(withoutEmail.endsWith('… (mensaje recortado)')).toBe(true);
    // Sin saltos de línea ni variables vacías.
    expect(forwardTemplateVars(forward([item('uno\ndos\t tres')]))[2]).toBe('uno dos tres');
  });

  it('email del reenvío: texto completo, en orden, con hora local y los dos enlaces', () => {
    const n = forward([
      item('Primero ' + 'x'.repeat(800)),
      item('Segundo', { sentAt: new Date('2026-10-01T19:47:00Z') }),
    ]);
    const email = forwardEmail(n, 'https://bot.ejemplo.com');
    expect(email.subject).toBe('Mensaje de Lucía durante la derivación');
    expect(email.text).toContain('Lucía (+34 611 22 23 33) ha escrito durante la derivación:');
    expect(email.text).toContain(`[21:45] Primero ${'x'.repeat(800)}`);
    expect(email.text.indexOf('[21:45]')).toBeLessThan(email.text.indexOf('[21:47] Segundo'));
    expect(email.text).toContain(`Le atiendo: https://bot.ejemplo.com/handoff/${TOKEN}/attend`);
    expect(email.text).toContain(`Terminado:  https://bot.ejemplo.com/handoff/${TOKEN}/end`);
  });
});

describe('recordatorio (US5, FR-019)', () => {
  const reminder = (trigger: 'schedule' | 'inactivity') =>
    reminderNotice({ ...notice().handoff, threadRef: '<aviso@smtp>' }, trigger) as Extract<
      BusinessNotice,
      { type: 'reminder' }
    >;
  const later = new Date('2026-10-02T09:30:00Z'); // viernes 11:30 en Madrid

  it('espera desde el inicio de la derivación', () => {
    expect(reminder('schedule')).toMatchObject({ waitingSince: startedAt, trigger: 'schedule' });
  });

  it('variables de derivacion_recordatorio: nombre, teléfono, desde en hora local y motivo', () => {
    expect(reminderTemplateVars(reminder('schedule'), later)).toEqual([
      'Lucía',
      '+34 611 22 23 33',
      'ayer a las 21:40',
      'Pregunta por el precio del tinte y quiere hablar con alguien.',
    ]);
  });

  it('email: asunto, datos del aviso y los dos enlaces en los dos momentos', () => {
    for (const trigger of ['schedule', 'inactivity'] as const) {
      const email = reminderEmail(reminder(trigger), later, 'https://bot.ejemplo.com');
      expect(email.subject).toBe('Recordatorio: Lucía sigue esperando');
      expect(email.text).toContain('Cliente: Lucía');
      expect(email.text).toContain('Teléfono: +34 611 22 23 33');
      expect(email.text).toContain('Desde: ayer a las 21:40');
      expect(email.text).toContain(`Le atiendo: https://bot.ejemplo.com/handoff/${TOKEN}/attend`);
      expect(email.text).toContain(`Terminado:  https://bot.ejemplo.com/handoff/${TOKEN}/end`);
    }
  });

  it('email: la frase final según el momento del recordatorio', () => {
    const schedule = reminderEmail(reminder('schedule'), later, null).text;
    const inactivity = reminderEmail(reminder('inactivity'), later, null).text;
    expect(schedule).toContain('Le hemos dado tu contacto directo por si prefiere llamarte.');
    expect(schedule).not.toContain('24 horas');
    expect(inactivity).toContain(
      'Como el cliente no ha escrito en 24 horas, la conversación ha vuelto al asistente, pero ' +
        'sigue esperando que le contactes.',
    );
    expect(inactivity).not.toContain('contacto directo');
  });
});
