/**
 * Los tres estados por concepto de caché y el consumo no medido en el agregado (017, FR-024,
 * FR-025, SC-012; contracts/usage-unmeasured.md §1 y §4).
 *
 * Se prueba el **núcleo puro** de la agregación, sin base de datos: lo que se vigila aquí es la
 * deducción, y la deducción es aritmética, no SQL. Lo que la consulta devuelve ya lo fija
 * `tests/integration/usage/summary.test.ts`.
 *
 * La regla que da sentido a todo el fichero: el estado **se deduce de lo registrado, nunca del
 * nombre del proveedor** (R15, FR-006). La capa de presentación no sabe quién hay detrás del
 * modelo, y aun así puede decir «sin dato» sin equivocarse.
 */
import { describe, expect, it } from 'vitest';
import { aggregateGroups, type Group } from '../../../src/usage/summary.js';
import type { UsagePurpose } from '../../../src/usage/types.js';

const PERIOD = { first: '2026-10-01', last: '2026-10-31' };

/** Grupo de la consulta con los valores que no interesan ya puestos. */
function group(over: Partial<Group> = {}): Group {
  return {
    channel: 'whatsapp',
    purpose: 'reply',
    model: 'modelo-x',
    currency: 'USD',
    records: 1,
    calls: 1,
    unmeasuredCalls: 0,
    input: 1000,
    output: 100,
    cacheWrite: 0,
    cacheRead: 0,
    cacheWriteRows: 1,
    cacheReadRows: 1,
    cost: '0',
    ...over,
  };
}

const run = (...groups: Group[]) => aggregateGroups(groups, PERIOD);

describe('estado de cada concepto de caché', () => {
  it('todas las filas lo informan → informado, con su suma', () => {
    const { instance } = run(
      group({ records: 2, cacheWrite: 300, cacheWriteRows: 2, cacheReadRows: 2 }),
    );
    expect(instance.cache).toEqual({ write: 'reported', read: 'reported' });
    expect(instance.tokens.cacheWrite).toBe(300);
  });

  // El caso de Gemini: el proveedor no informa del concepto jamás, así que ninguna fila lo trae.
  it('ninguna fila lo informa → no informado', () => {
    const { instance } = run(
      group({ records: 3, cacheWrite: 0, cacheWriteRows: 0, cacheRead: 120, cacheReadRows: 3 }),
    );
    expect(instance.cache.write).toBe('unreported');
    expect(instance.cache.read).toBe('reported');
  });

  /**
   * El caso límite que la spec previó: un proveedor que deja de informar a mitad de periodo, o un
   * cambio de proveedor dentro del mes. La suma **no** subestima lo que sí se midió, y el periodo
   * queda marcado como parcial en lugar de presentarse como exacto.
   */
  it('unas filas sí y otras no → parcialmente informado, sin perder lo medido', () => {
    const { instance } = run(
      group({ records: 2, cacheWrite: 500, cacheWriteRows: 2 }),
      group({ channel: 'web', records: 3, cacheWrite: 0, cacheWriteRows: 0 }),
    );
    expect(instance.cache.write).toBe('partial');
    expect(instance.tokens.cacheWrite).toBe(500);
    // Y cada canal conserva su propio estado: el que informa no hereda el hueco del otro.
    const split = run(
      group({ records: 2, cacheWrite: 500, cacheWriteRows: 2 }),
      group({ channel: 'web', records: 3, cacheWrite: 0, cacheWriteRows: 0 }),
    );
    expect(split.byChannel.whatsapp.cache.write).toBe('reported');
    expect(split.byChannel.web.cache.write).toBe('unreported');
  });

  // SC-012: lo no informado no se suma como cero. Un cero medido sí se suma, y son distintos.
  it('un cero medido es informado, y no se confunde con «sin dato»', () => {
    const medido = run(group({ cacheWrite: 0, cacheWriteRows: 1 })).instance;
    const sinDato = run(group({ cacheWrite: 0, cacheWriteRows: 0 })).instance;
    expect(medido.cache.write).toBe('reported');
    expect(medido.tokens.cacheWrite).toBe(0);
    expect(sinDato.cache.write).toBe('unreported');
  });

  it('un periodo sin consumo no afirma «sin dato» de nada', () => {
    const { instance, byChannel } = run();
    expect(instance.cache).toEqual({ write: 'reported', read: 'reported' });
    expect(byChannel.web.cache).toEqual({ write: 'reported', read: 'reported' });
  });

  /**
   * Las transcripciones guardan `0` en los conceptos de caché porque no tienen caché, no porque el
   * proveedor del modelo informe de ella. Si contaran, una instancia cuyo proveedor **nunca**
   * informa de la escritura de caché pasaría de «sin dato» a «parcial» en cuanto transcribiese un
   * audio, y el panel diría que a veces sí se mide algo que nunca se mide.
   */
  it('las transcripciones no cuentan para el estado del concepto', () => {
    const { instance } = run(
      group({ records: 2, cacheWrite: 0, cacheWriteRows: 0, cacheRead: 0, cacheReadRows: 0 }),
      group({ purpose: 'transcription', records: 5, cacheWriteRows: 5, cacheReadRows: 5 }),
    );
    expect(instance.cache).toEqual({ write: 'unreported', read: 'unreported' });
  });

  it('«Probar el bot» queda fuera de clientes finales pero dentro de la instancia', () => {
    const { customers, instance } = run(
      group({ channel: 'playground', records: 2, cacheWriteRows: 0, cacheWrite: 0 }),
    );
    expect(customers.cache.write).toBe('reported');
    expect(customers.replies).toBe(0);
    expect(instance.cache.write).toBe('unreported');
  });
});

describe('consumo no medido en el agregado', () => {
  it('se suma por canal, en clientes finales y en la instancia', () => {
    const { byChannel, customers, instance } = run(
      group({ calls: 3, unmeasuredCalls: 2 }),
      group({ channel: 'web', calls: 1, unmeasuredCalls: 1 }),
      group({ channel: 'playground', calls: 5, unmeasuredCalls: 5 }),
    );
    expect(byChannel.whatsapp.unmeasuredCalls).toBe(2);
    expect(byChannel.web.unmeasuredCalls).toBe(1);
    expect(customers.unmeasuredCalls).toBe(3);
    expect(instance.unmeasuredCalls).toBe(8);
    // La invariante del modelo de datos, en el agregado también.
    expect(instance.unmeasuredCalls).toBeLessThanOrEqual(instance.calls);
  });

  // El cero silencioso que la 017 cierra: una respuesta sin tokens informados queda registrada y
  // es distinguible de un consumo cero medido.
  it('una fila no medida es distinguible de una de consumo cero medido', () => {
    const noMedida = run(
      group({ calls: 1, unmeasuredCalls: 1, input: 0, output: 0 }),
    ).instance;
    const ceroMedido = run(group({ calls: 1, unmeasuredCalls: 0, input: 0, output: 0 })).instance;
    expect(noMedida.tokens).toEqual(ceroMedido.tokens);
    expect(noMedida.unmeasuredCalls).not.toBe(ceroMedido.unmeasuredCalls);
  });

  it.each(['reply', 'handoff_summary', 'transcription'] as UsagePurpose[])(
    'cuenta las llamadas no medidas de propósito %s',
    (purpose) => {
      expect(run(group({ purpose, unmeasuredCalls: 2 })).instance.unmeasuredCalls).toBe(2);
    },
  );
});
