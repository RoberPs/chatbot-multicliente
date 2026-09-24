import { describe, expect, it } from 'vitest';
import { buildPrompt, snapshotBlock, stableStringify } from '../../../src/llm/prompt.js';
import { activeSnapshot, replyContext } from '../../helpers/snapshot.js';

function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .reverse()
        .map((k) => [k, reorderKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

describe('prompt del modelo', () => {
  it('la serialización del snapshot no depende del orden de las claves', () => {
    const snapshot = activeSnapshot();
    const reordered = reorderKeys(snapshot) as typeof snapshot;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(snapshot));
    expect(stableStringify(reordered)).toBe(stableStringify(snapshot));
    expect(snapshotBlock(reordered)).toBe(snapshotBlock(snapshot));
  });

  it('dos bloques system: instrucciones fijas y snapshot', () => {
    const prompt = buildPrompt(replyContext());
    expect(prompt.system[0]).toContain('asistente automático');
    expect(prompt.system[1]).toMatch(/^DATOS_DEL_NEGOCIO \(JSON\):\n\{/);
    expect(prompt.system[1]).toContain('Negocio Demo');
    // Las instrucciones fijas no cambian entre peticiones (caché).
    expect(buildPrompt(replyContext({ pending: [] })).system[0]).toBe(prompt.system[0]);
  });

  it('el historial va como turnos user/assistant y empieza por el cliente', () => {
    const prompt = buildPrompt(
      replyContext({
        history: [
          { direction: 'outbound', text: 'respuesta huérfana' },
          { direction: 'inbound', text: 'hola' },
          { direction: 'outbound', text: 'Hola, ¿en qué te ayudo?' },
        ],
      }),
    );
    expect(prompt.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(prompt.messages[0]?.content).toContain(
      '<mensaje_del_cliente>"hola"</mensaje_del_cliente>',
    );
  });

  it('el turno final separa hechos calculados y mensajes del cliente como datos', () => {
    const prompt = buildPrompt(
      replyContext({ pending: [{ kind: 'text', text: '¿abrís el sábado?' }] }),
    );
    const last = prompt.messages.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content).toMatch(/<hechos_calculados>\{.*"openNow":true.*\}<\/hechos_calculados>/);
    expect(last?.content).toContain(
      '<mensajes_del_cliente>[{"tipo":"text","texto":"¿abrís el sábado?"}]</mensajes_del_cliente>',
    );
  });

  it('indica si no debe saludar y la forma de trato; incluye la revisión si la hay', () => {
    const last = buildPrompt(
      replyContext({ greetingPrepended: true, addressForm: 'formal' }),
      'el importe no figura en los datos',
    ).messages.at(-1)?.content;
    expect(last).toContain('no saludes');
    expect(last).toContain('Forma de trato: usted');
    expect(last).toContain('Revisión: el importe no figura en los datos');
  });
});
