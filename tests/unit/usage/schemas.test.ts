/**
 * Validación de los formularios de consumo (010, data-model.md §4; FR-013): precio por modelo,
 * moneda de coste y tope mensual, con errores por campo.
 */
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CAP_AMOUNT_MESSAGE,
  CAP_REQUIRED_MESSAGE,
  CURRENCY_MESSAGE,
  MODEL_MESSAGE,
  PER_MINUTE_MESSAGE,
  PRICE_IN_USE_MESSAGE,
  PRICE_MESSAGE,
  priceSchema,
  transcriptionPriceSchema,
  usageSettingsSchema,
  WHATSAPP_CAP_MESSAGE,
  whatsappCapSchema,
} from '../../../src/usage/schemas.js';

/** Errores por campo de un `safeParse` fallido. */
function fieldErrors(result: { success: boolean; error?: ZodError }): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    errors[issue.path.join('.')] ??= issue.message;
  }
  return errors;
}

const validPrice = {
  model: 'modelo-x',
  input: '3',
  output: '15',
  cacheWrite: '3,75',
  cacheRead: '0.30',
};

describe('priceSchema', () => {
  it('convierte los cuatro precios a millonésimas y recorta el modelo', () => {
    expect(priceSchema.parse({ ...validPrice, model: '  modelo-x  ' })).toEqual({
      model: 'modelo-x',
      inputMicros: 3_000_000n,
      outputMicros: 15_000_000n,
      cacheWriteMicros: 3_750_000n,
      cacheReadMicros: 300_000n,
    });
  });

  it('admite 0, hasta 6 decimales y 1 000 000 por MTok', () => {
    expect(
      priceSchema.parse({
        ...validPrice,
        input: '0',
        output: '0,000001',
        cacheRead: '1000000',
      }),
    ).toMatchObject({ inputMicros: 0n, outputMicros: 1n, cacheReadMicros: 1_000_000_000_000n });
  });

  it.each([
    ['model', ''],
    ['model', '   '],
    ['model', 'x'.repeat(201)],
  ])('rechaza %s = %j', (field, value) => {
    const errors = fieldErrors(priceSchema.safeParse({ ...validPrice, [field]: value }));
    expect(errors).toEqual({ model: MODEL_MESSAGE });
  });

  it('admite un modelo de 200 caracteres', () => {
    expect(priceSchema.parse({ ...validPrice, model: 'x'.repeat(200) }).model).toHaveLength(200);
  });

  it.each(['-1', '1,0000001', '1000000,000001', 'abc', '', '1e3'])(
    'rechaza el precio %j con error en su campo',
    (value) => {
      const errors = fieldErrors(
        priceSchema.safeParse({ ...validPrice, output: value, cacheRead: value }),
      );
      expect(errors).toEqual({ output: PRICE_MESSAGE, cacheRead: PRICE_MESSAGE });
    },
  );
});

describe('usageSettingsSchema: moneda', () => {
  it('acepta 3 letras ISO 4217 y las pasa a mayúsculas', () => {
    expect(usageSettingsSchema.parse({ currency: 'EUR' }).currency).toBe('EUR');
    expect(usageSettingsSchema.parse({ currency: ' usd ' }).currency).toBe('USD');
  });

  it.each(['', 'EU', 'EURO', 'E1R', '€'])('rechaza la moneda %j', (currency) => {
    expect(fieldErrors(usageSettingsSchema.safeParse({ currency }))).toEqual({
      currency: CURRENCY_MESSAGE,
    });
  });
});

describe('usageSettingsSchema: tope mensual', () => {
  it('sin casilla el tope está desactivado y sin importe no cambia el guardado', () => {
    expect(usageSettingsSchema.parse({ currency: 'USD' })).toEqual({
      currency: 'USD',
      capEnabled: false,
      monthlyCapCents: null,
    });
  });

  it('activar exige un importe > 0 con hasta 2 decimales → céntimos', () => {
    expect(
      usageSettingsSchema.parse({ currency: 'USD', capEnabled: 'on', monthlyCap: '25,50' }),
    ).toEqual({ currency: 'USD', capEnabled: true, monthlyCapCents: 2550 });
    expect(
      usageSettingsSchema.parse({ currency: 'USD', capEnabled: 'on', monthlyCap: '10000000' }),
    ).toMatchObject({ monthlyCapCents: 1_000_000_000 });
  });

  it.each(['', '0', '0,00', '-5', '1,001', '10000000,01', 'diez'])(
    'activar con el importe %j da error en monthlyCap',
    (monthlyCap) => {
      expect(
        fieldErrors(
          usageSettingsSchema.safeParse({ currency: 'USD', capEnabled: 'on', monthlyCap }),
        ),
      ).toEqual({ monthlyCap: CAP_AMOUNT_MESSAGE });
    },
  );

  it('desactivar conserva el importe escrito', () => {
    expect(usageSettingsSchema.parse({ currency: 'USD', monthlyCap: '30' })).toEqual({
      currency: 'USD',
      capEnabled: false,
      monthlyCapCents: 3000,
    });
  });

  it('desactivado, un importe no válido también es error', () => {
    expect(
      fieldErrors(usageSettingsSchema.safeParse({ currency: 'USD', monthlyCap: '0' })),
    ).toEqual({ monthlyCap: CAP_AMOUNT_MESSAGE });
  });
});

describe('whatsappCapSchema (012, R5)', () => {
  it.each([
    ['1', 1],
    ['200', 200],
    [' 10000 ', 10_000],
    [350, 350],
  ])('acepta %j', (value, n) => {
    expect(whatsappCapSchema.parse({ whatsappDailyCap: value })).toBe(n);
  });

  it.each(['0', '10001', '1,5', '1.5', '-3', '', 'cien', undefined])(
    'rechaza %j con el rango en el mensaje',
    (value) => {
      expect(fieldErrors(whatsappCapSchema.safeParse({ whatsappDailyCap: value }))).toEqual({
        whatsappDailyCap: WHATSAPP_CAP_MESSAGE,
      });
    },
  );

  it('el mensaje nombra el rango', () => {
    expect(WHATSAPP_CAP_MESSAGE).toContain('entre 1 y 10.000');
  });
});

describe('transcriptionPriceSchema (012, R6)', () => {
  it('convierte el precio por minuto a millonésimas y recorta el modelo', () => {
    expect(transcriptionPriceSchema.parse({ model: ' whisper-1 ', perMinute: '0,006' })).toEqual({
      model: 'whisper-1',
      perMinute: 6_000n,
    });
    expect(transcriptionPriceSchema.parse({ model: 'm', perMinute: '1000000' }).perMinute).toBe(
      1_000_000_000_000n,
    );
    expect(transcriptionPriceSchema.parse({ model: 'm', perMinute: '0' }).perMinute).toBe(0n);
  });

  it.each(['-1', '0,0000001', '1000000,01', 'abc', ''])('rechaza el precio %j', (perMinute) => {
    expect(fieldErrors(transcriptionPriceSchema.safeParse({ model: 'm', perMinute }))).toEqual({
      perMinute: PER_MINUTE_MESSAGE,
    });
  });

  it.each(['', '   ', 'x'.repeat(201)])('rechaza el modelo %j', (model) => {
    expect(fieldErrors(transcriptionPriceSchema.safeParse({ model, perMinute: '1' }))).toEqual({
      model: MODEL_MESSAGE,
    });
  });
});

describe('mensajes de los rechazos en producción (012, FR-003)', () => {
  it('nombran la regla sin datos', () => {
    expect(CAP_REQUIRED_MESSAGE).toBe(
      'En producción el tope de gasto es obligatorio mientras el negocio está activo.',
    );
    expect(PRICE_IN_USE_MESSAGE).toBe(
      'En producción no se puede borrar el precio del modelo en uso mientras el negocio está activo.',
    );
  });
});
