import { describe, expect, it } from 'vitest';
import { handoffAlertsSchema } from '../../../src/handoff/schemas.js';
import { handoffStepSchema } from '../../../src/handoff/types.js';

describe('handoffStepSchema', () => {
  const at = '2026-10-03T21:40:00.000Z';

  it('acepta los dos pasos', () => {
    expect(handoffStepSchema.parse({ step: 'offered', kind: 'unresolved', at })).toEqual({
      step: 'offered',
      kind: 'unresolved',
      at,
    });
    const collecting = {
      step: 'collecting',
      kind: 'complaint',
      missing: ['name', 'phone'],
      phoneRetried: false,
      at,
    };
    expect(handoffStepSchema.parse(collecting)).toEqual(collecting);
  });

  it('rechaza collecting sin nada que pedir', () => {
    expect(
      handoffStepSchema.safeParse({
        step: 'collecting',
        kind: 'person',
        missing: [],
        phoneRetried: false,
        at,
      }).success,
    ).toBe(false);
  });

  it('rechaza pasos, tipos o fechas desconocidos', () => {
    expect(handoffStepSchema.safeParse({ step: 'waiting', kind: 'person', at }).success).toBe(
      false,
    );
    expect(handoffStepSchema.safeParse({ step: 'offered', kind: 'person', at }).success).toBe(
      false,
    );
    expect(
      handoffStepSchema.safeParse({ step: 'offered', kind: 'unresolved', at: 'ayer' }).success,
    ).toBe(false);
  });
});

describe('handoffAlertsSchema', () => {
  const schema = handoffAlertsSchema('ES');

  it('vacíos → null', () => {
    expect(schema.parse({ whatsapp: '', email: '  ' })).toEqual({ whatsapp: null, email: null });
    expect(schema.parse({})).toEqual({ whatsapp: null, email: null });
  });

  it('teléfono nacional → E.164', () => {
    expect(schema.parse({ whatsapp: '611 22 23 33' }).whatsapp).toBe('+34611222333');
  });

  it('teléfono internacional', () => {
    expect(schema.parse({ whatsapp: '+52 55 1234 5678' }).whatsapp).toBe('+525512345678');
  });

  it('teléfono no válido → error con el mensaje del contrato', () => {
    const result = schema.safeParse({ whatsapp: '123' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['whatsapp'],
      message: 'Indica un teléfono válido, con prefijo si no es de España',
    });
  });

  it('email recortado y en minúsculas', () => {
    expect(schema.parse({ email: '  Avisos@Ejemplo.COM ' }).email).toBe('avisos@ejemplo.com');
  });

  it('email no válido → error con el mensaje del contrato', () => {
    const result = schema.safeParse({ email: 'avisos@' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['email'],
      message: 'Indica un email válido',
    });
  });
});
