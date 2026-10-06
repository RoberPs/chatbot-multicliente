/** Motivo del bloque de contacto y rechazos del verificador (004, R7, FR-009). */
import { describe, expect, it } from 'vitest';
import { createResponder, needsContact } from '../../../src/conversation/responder.js';
import type { ModelReply } from '../../../src/conversation/types.js';
import { FakeChatModel, ManualClock, RecordingActivityLog, reply } from '../../helpers/fakes.js';
import { activeSnapshot } from '../../helpers/snapshot.js';

const FIXED = '00000000-0000-4000-8000-00000000a001';
const ON_REQUEST = '00000000-0000-4000-8000-00000000a003';

const snapshot = activeSnapshot();
const flags = (f: Partial<ModelReply>) => reply('Texto.', f);

describe('needsContact devuelve el motivo', () => {
  it.each<[string, Partial<ModelReply>, boolean, ReturnType<typeof needsContact>]>([
    ['nada', {}, false, null],
    ['petición de persona del modelo', { handoffRequested: true }, false, 'handoff_requested'],
    ['petición de persona detectada', {}, true, 'handoff_requested'],
    ['el modelo ofrece el contacto', { offerContact: true }, false, 'offer_contact'],
    ['pide reservar', { bookingRequested: true }, false, 'booking_requested'],
    ['precio a consultar', { mentionedServiceIds: [ON_REQUEST] }, false, 'price_on_request'],
    ['precio registrado', { mentionedServiceIds: [FIXED] }, false, null],
  ])('%s', (_name, f, detected, expected) => {
    expect(needsContact(snapshot, flags(f), detected)).toBe(expected);
  });

  it('precedencia: persona > ofrecer > reservar > precio a consultar', () => {
    const all = {
      offerContact: true,
      bookingRequested: true,
      mentionedServiceIds: [ON_REQUEST],
    };
    expect(needsContact(snapshot, flags({ ...all, handoffRequested: true }), false)).toBe(
      'handoff_requested',
    );
    expect(needsContact(snapshot, flags(all), false)).toBe('offer_contact');
    expect(
      needsContact(snapshot, flags({ ...all, offerContact: false }), false),
    ).toBe('booking_requested');
  });

  it('needsRephrase anula offer_contact y los demás, pero no la petición de persona', () => {
    const rephrase = { needsRephrase: true, offerContact: true, bookingRequested: true };
    expect(needsContact(snapshot, flags(rephrase), false)).toBeNull();
    expect(needsContact(snapshot, flags(rephrase), true)).toBe('handoff_requested');
  });
});

describe('groundingRejections y contactReason en la respuesta', () => {
  async function respond(...steps: ModelReply[]) {
    const clock = new ManualClock();
    const responder = createResponder({
      chatModel: new FakeChatModel(clock).queue(...steps),
      clock,
      activityLog: new RecordingActivityLog(),
    });
    return responder.respond({
      snapshot,
      history: [],
      pending: [{ kind: 'text', text: '¿a qué hora abrís?' }],
      greeted: true,
      now: clock.now(),
      channel: 'playground',
      customerKey: '0f8fad5b-d9cb-469f-a165-70867728950e',
      conversationId: '00000000-0000-4000-8000-0000000000c1',
    });
  }

  it('0 rechazos', async () => {
    const r = await respond(reply('Abrimos a las 9:00.', { offerContact: true }));
    expect(r).toMatchObject({ groundingRejections: 0, contactReason: 'offer_contact' });
  });

  it('1 rechazo y después una respuesta válida', async () => {
    const r = await respond(reply('Abrimos a las 7:45.'), reply('Abrimos a las 9:00.'));
    expect(r).toMatchObject({ groundingRejections: 1, contactReason: null, contactBlock: false });
    expect(r.text).not.toContain('7:45');
  });

  it('2 rechazos → R-SAFE con contacto de plantilla', async () => {
    const r = await respond(reply('Abrimos a las 7:45.'), reply('Abrimos a las 8:30.'));
    expect(r).toMatchObject({
      groundingRejections: 2,
      template: 'R-SAFE',
      contactReason: 'template',
    });
  });
});
