/** Composición de la respuesta: cuándo se añade CONTACTO (contracts/bot-replies.md). */
import { describe, expect, it } from 'vitest';
import { ChatModelError } from '../../../src/conversation/ports.js';
import { createResponder, unreadableSnapshotReply } from '../../../src/conversation/responder.js';
import { contactBlock } from '../../../src/conversation/templates.js';
import type { PendingItem } from '../../../src/conversation/types.js';
import type { KnowledgeSnapshot } from '../../../src/knowledge/types.js';
import {
  FakeChatModel,
  ManualClock,
  RecordingActivityLog,
  reply,
  type ModelStep,
} from '../../helpers/fakes.js';
import { activeSnapshot, activeState } from '../../helpers/snapshot.js';
import { service } from '../../helpers/state.js';

const FIXED = '00000000-0000-4000-8000-00000000a001';
const FROM = '00000000-0000-4000-8000-00000000a002';
const ON_REQUEST = '00000000-0000-4000-8000-00000000a003';
const MISSING = '00000000-0000-4000-8000-00000000a004';

/** Negocio de prueba más un servicio sin importe registrado. */
const snapshotWithMissing = (): KnowledgeSnapshot =>
  activeSnapshot({
    services: [
      ...activeState().services,
      service({ id: MISSING, name: 'Sin precio', priceType: 'fixed', priceCents: null }),
    ],
  });

async function respond(
  modelReply: ModelStep,
  opts: {
    snapshot?: KnowledgeSnapshot;
    pending?: PendingItem[];
    greeted?: boolean;
    audioTranscription?: boolean;
  } = {},
) {
  const clock = new ManualClock();
  const model = new FakeChatModel(clock).queue(modelReply);
  const responder = createResponder({
    chatModel: model,
    clock,
    activityLog: new RecordingActivityLog(),
    audioTranscription: opts.audioTranscription ?? false,
  });
  const snapshot = opts.snapshot ?? activeSnapshot();
  const response = await responder.respond({
    snapshot,
    history: [],
    pending: opts.pending ?? [{ kind: 'text', text: '¿cuánto cuesta?' }],
    // Por defecto, conversación ya saludada: los casos de CONTACTO no llevan saludo.
    greeted: opts.greeted ?? true,
    now: clock.now(),
    phone: '+34600111222',
    conversationId: '00000000-0000-4000-8000-0000000000c1',
  });
  return { response, contact: contactBlock(snapshot), model };
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe('CONTACTO por precios (US2, FR-010, FR-011)', () => {
  it('sin banderas y con servicios de precio conocido no se añade', async () => {
    const { response, contact } = await respond(
      reply('El básico cuesta 25,00 € y el completo desde 40,00 €.', {
        mentionedServiceIds: [FIXED, FROM],
      }),
    );
    expect(response.contactBlock).toBe(false);
    expect(response.text).not.toContain(contact);
  });

  it('se añade si se cita un servicio "a consultar" aunque el modelo no marque offerContact', async () => {
    const { response, contact } = await respond(
      reply('El especial tiene precio a consultar.', { mentionedServiceIds: [ON_REQUEST] }),
    );
    expect(response.contactBlock).toBe(true);
    expect(response.text).toBe(`El especial tiene precio a consultar.\n\n${contact}`);
  });

  it('se añade si se cita un servicio sin importe registrado', async () => {
    const { response, contact } = await respond(
      reply('No tengo registrado el precio de ese servicio.', {
        mentionedServiceIds: [MISSING],
      }),
      { snapshot: snapshotWithMissing() },
    );
    expect(response.contactBlock).toBe(true);
    expect(response.text).toContain(contact);
  });

  it('aparece una sola vez aunque coincidan varias razones', async () => {
    const { response, contact } = await respond(
      reply('El especial es a consultar y el otro no tiene precio.', {
        offerContact: true,
        mentionedServiceIds: [ON_REQUEST, MISSING, FIXED],
      }),
      { snapshot: snapshotWithMissing() },
    );
    expect(occurrences(response.text, contact)).toBe(1);
  });

  it('un id que no es de ningún servicio no añade contacto', async () => {
    const { response } = await respond(
      reply('El básico cuesta 25,00 €.', { mentionedServiceIds: ['desconocido', FIXED] }),
    );
    expect(response.contactBlock).toBe(false);
  });

  it('con needsRephrase no se añade por los precios', async () => {
    const { response } = await respond(
      reply('¿Puedes decirme a qué servicio te refieres?', {
        needsRephrase: true,
        mentionedServiceIds: [ON_REQUEST],
      }),
    );
    expect(response.contactBlock).toBe(false);
  });
});

describe('CONTACTO por banderas y petición de persona (US3, FR-016 – FR-018, SC-008)', () => {
  const text = (t: string): PendingItem[] => [{ kind: 'text', text: t }];

  it.each([
    ['handoffRequested', { handoffRequested: true }],
    ['offerContact', { offerContact: true }],
    ['bookingRequested', { bookingRequested: true }],
  ])('se añade con %s', async (_name, flags) => {
    const { response, contact } = await respond(reply('De acuerdo.', flags));
    expect(response.contactBlock).toBe(true);
    expect(response.text).toBe(`De acuerdo.\n\n${contact}`);
  });

  it('se añade si el detector encuentra una petición de persona aunque el modelo no la marque', async () => {
    const { response, contact } = await respond(reply('Te cuento.'), {
      pending: text('¿Cuánto cuesta? Y pásame con el encargado'),
    });
    expect(response.contactBlock).toBe(true);
    expect(response.text).toContain(contact);
  });

  it('el detector mira todos los mensajes del lote', async () => {
    const { response } = await respond(reply('Te cuento.'), {
      pending: [...text('hola'), ...text('que me llamen'), ...text('gracias')],
    });
    expect(response.contactBlock).toBe(true);
  });

  it('una sola vez aunque se cumplan varias condiciones', async () => {
    const { response, contact } = await respond(
      reply('Claro.', {
        handoffRequested: true,
        offerContact: true,
        bookingRequested: true,
        mentionedServiceIds: [ON_REQUEST],
      }),
      { pending: text('quiero hablar con una persona para pedir cita') },
    );
    expect(occurrences(response.text, contact)).toBe(1);
  });

  it('con needsRephrase y sin petición de persona no se añade nada', async () => {
    const { response } = await respond(
      reply('No te he entendido bien, ¿me lo puedes repetir?', {
        needsRephrase: true,
        offerContact: true,
        bookingRequested: true,
      }),
      { pending: text('asdf qwer') },
    );
    expect(response.contactBlock).toBe(false);
    expect(response.text).toBe('No te he entendido bien, ¿me lo puedes repetir?');
  });

  it('con needsRephrase y el detector activo se añade una vez', async () => {
    const { response, contact } = await respond(
      reply('No te he entendido bien.', { needsRephrase: true }),
      { pending: text('xz no quiero hablar con un bot') },
    );
    expect(occurrences(response.text, contact)).toBe(1);
  });

  it('con needsRephrase y handoffRequested se añade una vez', async () => {
    const { response, contact } = await respond(
      reply('No te he entendido bien.', { needsRephrase: true, handoffRequested: true }),
    );
    expect(occurrences(response.text, contact)).toBe(1);
  });
});

describe('mensajes fijos con contacto (US3, FR-029)', () => {
  it('R-SAFE lleva CONTACTO', async () => {
    const clock = new ManualClock();
    const model = new FakeChatModel(clock).queue(
      reply('Abrimos a las 8:30.'),
      reply('Abrimos a las 7:45.'),
    );
    const responder = createResponder({
      chatModel: model,
      clock,
      activityLog: new RecordingActivityLog(),
    });
    const snapshot = activeSnapshot();
    const response = await responder.respond({
      snapshot,
      history: [],
      pending: [{ kind: 'text', text: '¿a qué hora abrís?' }],
      greeted: true,
      now: clock.now(),
      phone: '+34600111222',
      conversationId: '00000000-0000-4000-8000-0000000000c1',
    });
    expect(response.template).toBe('R-SAFE');
    expect(response.text).toBe(`No dispongo de esa información.\n\n${contactBlock(snapshot)}`);
  });

  it('R-ERR lleva CONTACTO si el snapshot se leyó', async () => {
    const { response, contact } = await respond(new ChatModelError('api_error', 500));
    expect(response.template).toBe('R-ERR');
    expect(response.contactBlock).toBe(true);
    expect(response.text).toBe(
      `Ahora mismo no puedo responder. Por favor, vuelve a escribirme en unos minutos.\n\n${contact}`,
    );
  });

  it('R-ERR con CONTACTO-EMERGENCIA si no se pudo leer el snapshot', () => {
    const response = unreadableSnapshotReply('+34600999888');
    expect(response.template).toBe('R-ERR');
    expect(response.contactBlock).toBe(true);
    expect(response.text).toBe(
      'Ahora mismo no puedo responder. Por favor, vuelve a escribirme en unos minutos.\n\n' +
        'Si necesitas hablar con una persona: teléfono +34 600 99 98 88.',
    );
  });
});

describe('SALUDO al inicio de la conversación (US4, FR-020, FR-021, SC-005)', () => {
  const GREETING = '¡Hola! Soy el asistente automático de Negocio Demo.';

  it('sin greeted, la respuesta empieza por SALUDO y el modelo lo sabe', async () => {
    const { response, model } = await respond(reply('Abrimos a las 9:00.'), { greeted: false });
    expect(response.greeting).toBe(true);
    expect(response.text.startsWith(GREETING)).toBe(true);
    expect(response.text.endsWith('\n\nAbrimos a las 9:00.')).toBe(true);
    expect(model.calls[0]?.context.greetingPrepended).toBe(true);
  });

  it('con greeted, ninguna parte contiene el saludo', async () => {
    const { response, model } = await respond(reply('Abrimos a las 9:00.', { offerContact: true }));
    expect(response.greeting).toBe(false);
    expect(response.text).not.toContain('asistente automático');
    expect(response.text).not.toContain('¡Hola!');
    expect(model.calls[0]?.context.greetingPrepended).toBe(false);
  });

  it('el saludo va antes del cuerpo y del contacto, y usa la forma de trato del snapshot', async () => {
    const snapshot = activeSnapshot({
      tone: { addressForm: 'formal', styleDescription: null, updatedAt: '2026-09-24T10:00:00Z' },
    });
    const { response, contact, model } = await respond(
      reply('Lo consulto.', { handoffRequested: true }),
      { snapshot, greeted: false },
    );
    expect(response.text).toBe(
      `${GREETING} Puedo informarle sobre horario, ubicación, servicios, precios y dudas ` +
        `frecuentes.\n\nLo consulto.\n\n${contact}`,
    );
    expect(model.calls[0]?.context.addressForm).toBe('formal');
  });

  it('R-ERR también lleva el saludo si abre la conversación', async () => {
    const { response } = await respond(new ChatModelError('api_error'), { greeted: false });
    expect(response.text.startsWith(GREETING)).toBe(true);
    expect(response.greeting).toBe(true);
  });
});

describe('tipos no atendidos y audios (FR-028, FR-028a, SC-009)', () => {
  const R_MEDIA_OFF = 'Solo puedo atender mensajes de texto. ¿Me escribes tu consulta?';
  const R_MEDIA_ON =
    'Solo puedo atender mensajes de texto y audios. ¿Me escribes o me grabas tu consulta?';
  const NOTICE_OFF =
    'No puedo ver archivos, imágenes, stickers ni escuchar audios; solo leo mensajes de texto.';
  const NOTICE_ON = 'No puedo ver archivos, imágenes ni stickers; solo leo texto y escucho audios.';
  const R_AUDIO = 'No he podido entender el audio. ¿Puedes repetirlo o escribirme tu consulta?';
  const sticker: PendingItem = { kind: 'other', text: null };

  it('un lote solo de archivos sin pie recibe R-MEDIA sin llamar al modelo', async () => {
    const { response, model } = await respond(reply('no debería usarse'), {
      pending: [sticker, sticker],
    });
    expect(model.calls).toHaveLength(0);
    expect(response).toMatchObject({ text: R_MEDIA_OFF, template: 'R-MEDIA', contactBlock: false });
  });

  it('R-MEDIA cambia con el interruptor de audios', async () => {
    const { response } = await respond(reply('x'), {
      pending: [sticker],
      audioTranscription: true,
    });
    expect(response.text).toBe(R_MEDIA_ON);
  });

  it('con los audios apagados, un audio llega como otro tipo y recibe R-MEDIA', async () => {
    const { response, model } = await respond(reply('x'), {
      pending: [{ kind: 'other', text: null }],
    });
    expect(model.calls).toHaveLength(0);
    expect(response.text).toBe(R_MEDIA_OFF);
  });

  it('un archivo con pie: el modelo contesta al pie y se añade el aviso', async () => {
    const { response, model } = await respond(reply('Abrimos a las 9:00.'), {
      pending: [{ kind: 'other', text: '¿abrís mañana?' }],
    });
    expect(model.calls[0]?.context.pending).toEqual([{ kind: 'other', text: '¿abrís mañana?' }]);
    expect(response.text).toBe(`Abrimos a las 9:00.\n\n${NOTICE_OFF}`);
    expect(response.template).toBeUndefined();
  });

  it('texto y sticker: aviso antes del contacto', async () => {
    const { response, contact } = await respond(
      reply('Te paso el contacto.', { offerContact: true }),
      {
        pending: [{ kind: 'text', text: '¿tenéis parking?' }, sticker],
        audioTranscription: true,
      },
    );
    expect(response.text).toBe(`Te paso el contacto.\n\n${NOTICE_ON}\n\n${contact}`);
  });

  it('con audios encendidos, un lote solo de audios no entendidos recibe R-AUDIO', async () => {
    const { response, model } = await respond(reply('x'), {
      pending: [
        { kind: 'audio', text: null, audioUnderstood: false },
        { kind: 'audio', text: null, audioUnderstood: false },
      ],
      audioTranscription: true,
    });
    expect(model.calls).toHaveLength(0);
    expect(response).toMatchObject({ text: R_AUDIO, template: 'R-AUDIO', contactBlock: false });
  });

  it('un audio entendido va al modelo con su transcripción y sin aviso', async () => {
    const { response, model } = await respond(reply('Abrimos a las 9:00.'), {
      pending: [{ kind: 'audio', text: '¿a qué hora abrís?', audioUnderstood: true }],
      audioTranscription: true,
    });
    expect(model.calls[0]?.context.pending).toEqual([
      { kind: 'audio', text: '¿a qué hora abrís?', audioUnderstood: true },
    ]);
    expect(response.text).toBe('Abrimos a las 9:00.');
  });

  it('R-MEDIA y R-AUDIO llevan el saludo si abren la conversación', async () => {
    const media = await respond(reply('x'), { pending: [sticker], greeted: false });
    expect(media.response.text).toBe(
      `¡Hola! Soy el asistente automático de Negocio Demo. Puedo informarte sobre horario, ` +
        `ubicación, servicios, precios y dudas frecuentes.\n\n${R_MEDIA_OFF}`,
    );
    expect(media.response.greeting).toBe(true);
    const audio = await respond(reply('x'), {
      pending: [{ kind: 'audio', text: null, audioUnderstood: false }],
      audioTranscription: true,
      greeted: false,
    });
    expect(audio.response.text.endsWith(`\n\n${R_AUDIO}`)).toBe(true);
    expect(audio.response.greeting).toBe(true);
  });

  it('variante usted', async () => {
    const snapshot = activeSnapshot({
      tone: { addressForm: 'formal', styleDescription: null, updatedAt: '2026-09-24T10:00:00Z' },
    });
    const { response } = await respond(reply('x'), { pending: [sticker], snapshot });
    expect(response.text).toBe('Solo puedo atender mensajes de texto. ¿Me escribe su consulta?');
  });
});
