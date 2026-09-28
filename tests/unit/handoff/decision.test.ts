/**
 * Tabla de decisión de la derivación (005, contracts/handoff-flow.md): filas 3, 4 y 5,
 * § Datos y la garantía de SC-001 / Principio V.
 */
import { describe, expect, it } from 'vitest';
import { decide, type TurnInput } from '../../../src/handoff/decision.js';
import type { HandoffStep } from '../../../src/handoff/types.js';
import { reply } from '../../helpers/fakes.js';

const NOW = new Date('2026-10-01T10:00:00Z');

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    step: null,
    reply: reply('De acuerdo.'),
    detector: false,
    hasRoutes: true,
    contactFromChannel: false,
    known: { name: null, phone: null },
    texts: [],
    region: 'ES',
    now: NOW,
    ...overrides,
  };
}

const collecting = (
  missing: Array<'name' | 'phone'>,
  extra: Partial<Extract<HandoffStep, { step: 'collecting' }>> = {},
): HandoffStep => ({
  step: 'collecting',
  kind: 'person',
  missing,
  phoneRetried: false,
  at: '2026-10-01T09:59:00.000Z',
  ...extra,
});

describe('fila 3: petición de persona con vías', () => {
  it('web sin datos → pide nombre y teléfono en una pregunta', () => {
    const d = decide(input({ reply: reply('Vale.', { handoffRequested: true }) }));
    expect(d).toEqual({
      type: 'ask',
      kind: 'person',
      missing: ['name', 'phone'],
      retry: false,
      save: {},
      step: {
        step: 'collecting',
        kind: 'person',
        missing: ['name', 'phone'],
        phoneRetried: false,
        at: NOW.toISOString(),
      },
    });
  });

  it('el detector basta aunque el modelo no marque la bandera', () => {
    expect(decide(input({ detector: true })).type).toBe('ask');
  });

  it('WhatsApp con perfil → inicia sin pedir nada', () => {
    const d = decide(
      input({
        detector: true,
        contactFromChannel: true,
        known: { name: 'Lucía', phone: '+34611222333' },
      }),
    );
    expect(d).toEqual({ type: 'start', kind: 'person', step: null, save: {} });
  });

  it('WhatsApp sin perfil → pide solo el nombre', () => {
    const d = decide(
      input({
        detector: true,
        contactFromChannel: true,
        known: { name: null, phone: '+34611222333' },
      }),
    );
    expect(d).toMatchObject({ type: 'ask', missing: ['name'] });
  });

  it('web con los datos ya dados antes → inicia', () => {
    const d = decide(input({ detector: true, known: { name: 'Lucía', phone: '+34611222333' } }));
    expect(d.type).toBe('start');
  });

  it('nueva petición mientras se piden los datos → sigue pidiendo lo que falta, tipo persona', () => {
    const d = decide(
      input({
        step: collecting(['name', 'phone'], { kind: 'unresolved' }),
        detector: true,
        reply: reply('Vale.', { contactName: 'Lucía' }),
      }),
    );
    expect(d).toMatchObject({
      type: 'ask',
      kind: 'person',
      missing: ['phone'],
      save: { name: 'Lucía' },
    });
  });
});

describe('fila 4: petición sin vías', () => {
  it('respuesta normal de la 002 (el CONTACTO lo pone la composición)', () => {
    expect(decide(input({ hasRoutes: false, detector: true }))).toEqual({
      type: 'normal',
      step: null,
    });
  });
});

describe('fila 5 y § Datos', () => {
  it('llegan todos los datos y el teléfono es válido → inicia y los guarda', () => {
    const d = decide(
      input({
        step: collecting(['name', 'phone']),
        reply: reply('Gracias.', { contactName: ' Lucía ', contactPhone: '611 22 23 33' }),
      }),
    );
    expect(d).toEqual({
      type: 'start',
      kind: 'person',
      step: null,
      save: { name: 'Lucía', phone: '+34611222333' },
    });
  });

  it('el teléfono se busca en el texto si el modelo no lo copió', () => {
    const d = decide(
      input({
        step: collecting(['phone']),
        known: { name: 'Lucía', phone: null },
        texts: ['mi número es 611 22 23 33'],
      }),
    );
    expect(d).toMatchObject({ type: 'start', save: { phone: '+34611222333' } });
  });

  it('se niega → CONTACTO sin derivar (US1-4)', () => {
    const d = decide(
      input({
        step: collecting(['name', 'phone']),
        reply: reply('Vale.', { refusesContact: true }),
      }),
    );
    expect(d).toEqual({ type: 'refused', kind: 'person', step: null, save: {} });
  });

  it('teléfono no válido una vez → R-HANDOFF-PHONE y se guarda el nombre', () => {
    const d = decide(
      input({
        step: collecting(['name', 'phone']),
        reply: reply('Vale.', { contactName: 'Lucía', contactPhone: '12345' }),
      }),
    );
    expect(d).toMatchObject({
      type: 'ask',
      retry: true,
      missing: ['phone'],
      save: { name: 'Lucía' },
      step: { step: 'collecting', missing: ['phone'], phoneRetried: true },
    });
  });

  it('teléfono no válido dos veces → CONTACTO', () => {
    const d = decide(
      input({
        step: collecting(['phone'], { phoneRetried: true }),
        known: { name: 'Lucía', phone: null },
        reply: reply('Vale.', { contactPhone: '12345' }),
      }),
    );
    expect(d).toMatchObject({ type: 'refused', step: null });
  });

  it('falta uno de los datos → CONTACTO, pero el dado se guarda', () => {
    const d = decide(
      input({
        step: collecting(['name', 'phone']),
        reply: reply('Vale.', { contactName: 'Lucía' }),
      }),
    );
    expect(d).toEqual({ type: 'refused', kind: 'person', step: null, save: { name: 'Lucía' } });
  });

  it('conserva el tipo de la recogida', () => {
    const d = decide(
      input({
        step: collecting(['name'], { kind: 'unresolved' }),
        known: { name: null, phone: '+34611222333' },
        reply: reply('Vale.', { contactName: 'Lucía' }),
      }),
    );
    expect(d).toMatchObject({ type: 'start', kind: 'unresolved' });
  });
});

describe('fila 8', () => {
  it('sin petición ni paso → respuesta normal', () => {
    expect(decide(input())).toEqual({ type: 'normal', step: null });
  });

  it('un paso offered caduca', () => {
    const d = decide(
      input({ step: { step: 'offered', kind: 'unresolved', at: '2026-10-01T09:00:00.000Z' } }),
    );
    expect(d).toEqual({ type: 'normal', step: null });
  });
});

describe('SC-001 / Principio V: toda petición acaba en iniciar, pedir datos o CONTACTO', () => {
  const bools = [false, true];
  const knowns = [
    { name: null, phone: null },
    { name: 'Lucía', phone: null },
    { name: null, phone: '+34611222333' },
    { name: 'Lucía', phone: '+34611222333' },
  ];
  const steps: Array<HandoffStep | null> = [
    null,
    { step: 'offered', kind: 'unresolved', at: NOW.toISOString() },
    collecting(['name', 'phone']),
    collecting(['phone'], { phoneRetried: true }),
  ];

  it('todas las combinaciones', () => {
    let checked = 0;
    for (const flag of bools)
      for (const detector of bools) {
        if (!flag && !detector) continue;
        for (const hasRoutes of bools)
          for (const contactFromChannel of bools)
            for (const known of knowns)
              for (const step of steps)
                for (const refusesContact of bools) {
                  const d = decide(
                    input({
                      reply: reply('Vale.', { handoffRequested: flag, refusesContact }),
                      detector,
                      hasRoutes,
                      contactFromChannel,
                      known,
                      step,
                    }),
                  );
                  checked += 1;
                  // Sin vías: respuesta normal, que en la 002 siempre lleva CONTACTO.
                  if (!hasRoutes) expect(d.type).toBe('normal');
                  else expect(['start', 'ask', 'refused']).toContain(d.type);
                }
      }
    expect(checked).toBeGreaterThan(300);
  });
});
