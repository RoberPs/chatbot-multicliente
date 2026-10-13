/**
 * Consumo de una respuesta: suma de los intentos del responder (010, R2; FR-002, FR-004).
 *
 * 017 (FR-025) cambia una regla a propósito: una llamada **con respuesta** que no informó tokens
 * ya no desaparece del registro. Antes dejaba la respuesta sin consumo ninguno, y eso es un cero
 * silencioso justo donde vive el tope de gasto. Ahora cuenta en `calls` y en `unmeasuredCalls`.
 *
 * Lo que **no** ha cambiado: el plazo agotado y el fallo de la API no son respuestas, así que no
 * cuentan. Y con un proveedor que informa de los cuatro conceptos —el caso de Anthropic, el único
 * alcanzable hoy en producción— `unmeasuredCalls` es siempre 0 y nada se ve distinto.
 */
import { describe, expect, it } from 'vitest';
import { ChatModelError } from '../../../src/conversation/ports.js';
import { createResponder } from '../../../src/conversation/responder.js';
import type { PendingItem } from '../../../src/conversation/types.js';
import {
  FakeChatModel,
  ManualClock,
  RecordingActivityLog,
  reply,
  tokens,
  type ModelStep,
} from '../../helpers/fakes.js';
import { activeSnapshot } from '../../helpers/snapshot.js';

/** Hora inventada: el verificador la rechaza y el responder reintenta. */
const UNGROUNDED = reply('Abrimos a las 7:45.');
const GROUNDED = reply('Te paso el contacto del negocio.');

async function respond(steps: ModelStep[], pending?: PendingItem[]) {
  const clock = new ManualClock();
  const model = new FakeChatModel(clock).queue(...steps);
  const responder = createResponder({
    chatModel: model,
    clock,
    activityLog: new RecordingActivityLog(),
  });
  const response = await responder.respond({
    snapshot: activeSnapshot(),
    history: [],
    pending: pending ?? [{ kind: 'text', text: '¿a qué hora abrís?' }],
    greeted: true,
    now: clock.now(),
    channel: 'whatsapp',
    customerKey: '+34600111222',
    conversationId: '00000000-0000-4000-8000-0000000000c1',
  });
  return { response, model };
}

describe('response.usage', () => {
  it('una llamada: calls = 1 con sus tokens', async () => {
    const { response } = await respond([{ reply: GROUNDED, usage: tokens(1000, 200, 0, 800) }]);
    expect(response.template).toBeUndefined();
    expect(response.usage).toEqual({
      calls: 1,
      unmeasuredCalls: 0,
      tokens: tokens(1000, 200, 0, 800),
    });
  });

  it('reintento del verificador: un solo consumo con calls = 2 y los tokens sumados', async () => {
    const { response, model } = await respond([
      { reply: UNGROUNDED, usage: tokens(1000, 200, 500, 0) },
      { reply: GROUNDED, usage: tokens(1100, 150, 0, 500) },
    ]);
    expect(model.calls).toHaveLength(2);
    expect(response.groundingRejections).toBe(1);
    expect(response.usage).toEqual({
      calls: 2,
      unmeasuredCalls: 0,
      tokens: tokens(2100, 350, 500, 500),
    });
  });

  it('un intento que no informa tokens cuenta como llamada no medida (017, FR-025)', async () => {
    const { response } = await respond([
      { reply: UNGROUNDED, usage: null },
      { reply: GROUNDED, usage: tokens(900, 100) },
    ]);
    expect(response.usage).toEqual({ calls: 2, unmeasuredCalls: 1, tokens: tokens(900, 100) });
  });

  it('sin tokens en ningún intento hay registro, con los tokens a 0 (017, FR-025)', async () => {
    const { response } = await respond([GROUNDED]);
    // Distinguible de un consumo cero medido, donde `unmeasuredCalls` sería 0 (SC-005).
    expect(response.usage).toEqual({ calls: 1, unmeasuredCalls: 1, tokens: tokens(0, 0) });
  });

  it('R-SAFE tras dos rechazos conserva el consumo de los dos intentos', async () => {
    const { response } = await respond([
      { reply: UNGROUNDED, usage: tokens(1000, 200) },
      { reply: reply('Abrimos a las 6:15.'), usage: tokens(1000, 220) },
    ]);
    expect(response.template).toBe('R-SAFE');
    expect(response.usage).toEqual({ calls: 2, unmeasuredCalls: 0, tokens: tokens(2000, 420) });
  });

  it('R-ERR tras una respuesta descartada con tokens conserva el consumo', async () => {
    const { response } = await respond([
      { error: new ChatModelError('invalid_output'), usage: tokens(1000, 4000) },
    ]);
    expect(response.template).toBe('R-ERR');
    expect(response.usage).toEqual({ calls: 1, unmeasuredCalls: 0, tokens: tokens(1000, 4000) });
  });

  it('R-ERR sin respuesta del proveedor no tiene consumo', async () => {
    const { response } = await respond([new ChatModelError('api_error', 529)]);
    expect(response.template).toBe('R-ERR');
    expect(response.usage).toBeUndefined();
  });

  it('R-ERR tras un intento con tokens y otro fallido sin respuesta: solo cuenta el primero', async () => {
    const { response } = await respond([
      { reply: UNGROUNDED, usage: tokens(1000, 200) },
      { error: new ChatModelError('api_error', 500) },
    ]);
    expect(response.template).toBe('R-ERR');
    expect(response.usage).toEqual({ calls: 1, unmeasuredCalls: 0, tokens: tokens(1000, 200) });
  });

  it('las plantillas sin modelo no tienen consumo', async () => {
    const { response, model } = await respond(
      [{ reply: GROUNDED, usage: tokens(1, 1) }],
      [{ kind: 'other', text: null }],
    );
    expect(response.template).toBe('R-MEDIA');
    expect(model.calls).toHaveLength(0);
    expect(response.usage).toBeUndefined();
  });
});
