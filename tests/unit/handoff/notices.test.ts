/** Composición de los avisos al negocio (005, contracts/business-alerts.md). */
import { describe, expect, it } from 'vitest';
import {
  alertEmail,
  alertNotice,
  alertTemplateVars,
  describeChannel,
  describeKind,
  describeSince,
  sanitizeTemplateVar,
} from '../../../src/handoff/notices.js';

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
