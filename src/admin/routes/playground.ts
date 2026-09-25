/**
 * "Probar el bot" (004 US1, contracts/admin-web-channel.md, research R6).
 *
 * El operador conversa con el bot por el canal `playground`: los mensajes pasan por la misma
 * recepción y el mismo procesador que los de un cliente (FR-008), así que la respuesta llega
 * después y la página la recoge sondeando con htmx. El identificador de la conversación de
 * prueba vive en la sesión cifrada; "Nueva conversación" genera otro (FR-010).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as conversations from '../../conversation/repositories/conversation.js';
import { findByChannel } from '../../conversation/repositories/customer.js';
import {
  decodeCursor,
  encodeCursor,
  hasPending,
  listForConversation,
  type ConversationMessage,
} from '../../conversation/repositories/message.js';
import type { Db } from '../../db/client.js';
import { isHtmx } from '../auth/plugin.js';
import { parseForm } from '../form-parse.js';
import { readState, renderPage, savedResponse, viewHelpers } from '../render.js';

const TITLE = 'Probar el bot';
const MAX_CHARS = 1000;
const NO_BOT =
  'Falta la clave del modelo de lenguaje (ANTHROPIC_API_KEY) en la configuración de la instancia.';

const textSchema = z
  .string()
  .trim()
  .min(1, 'Escribe un mensaje')
  .max(MAX_CHARS, 'El mensaje no puede pasar de 1 000 caracteres');

interface Thread {
  messages: ConversationMessage[];
  /** El operador tiene mensajes sin contestar: hay que seguir sondeando. */
  waiting: boolean;
}

const EMPTY: Thread = { messages: [], waiting: false };

/** Conversación de prueba vigente; `after` limita a los mensajes posteriores al cursor. */
async function readThread(
  db: Db,
  playgroundId: string,
  after: { sentAt: Date; id: string } | null = null,
): Promise<Thread> {
  const customer = await findByChannel(db, 'playground', playgroundId);
  if (!customer) return EMPTY;
  const conversation = await conversations.findLatestForCustomer(db, customer.id);
  if (!conversation) return EMPTY;
  return {
    messages: await listForConversation(db, conversation.id, after),
    waiting: await hasPending(db, conversation.id),
  };
}

/** Cursor del indicador de sondeo; `null` cuando no queda nada por esperar. */
const pollCursor = (thread: Thread): string | null => {
  const last = thread.messages.at(-1);
  return thread.waiting && last ? encodeCursor(last) : null;
};

export async function playgroundRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.knowledge;

  /** Identificador de la conversación de prueba; se crea al entrar si no había (FR-010). */
  function playgroundId(request: FastifyRequest): string {
    const current = request.session.get('playgroundId');
    if (typeof current === 'string' && current !== '') return current;
    const created = randomUUID();
    request.session.set('playgroundId', created);
    return created;
  }

  async function renderPlayground(
    request: FastifyRequest,
    reply: FastifyReply,
    extra: Record<string, unknown> = {},
    status = 200,
  ): Promise<FastifyReply> {
    const thread = await readThread(db, playgroundId(request));
    return renderPage(
      request,
      reply,
      'playground',
      {
        state: await readState(db),
        title: TITLE,
        botPresent: app.bot !== null,
        messages: thread.messages,
        poll: pollCursor(thread),
        ...extra,
      },
      status,
    );
  }

  const fragment = (reply: FastifyReply, html: string, status = 200) =>
    reply.code(status).type('text/html; charset=utf-8').send(html);

  app.get('/playground', async (request, reply) => renderPlayground(request, reply));

  app.post('/playground/messages', async (request, reply) => {
    const bot = app.bot;
    // Sin clave del modelo no hay cadena que probar: se avisa y no se guarda nada.
    if (!bot) return renderPlayground(request, reply, { general: NO_BOT }, 422);

    const form = parseForm(request.body);
    const parsed = textSchema.safeParse(typeof form.text === 'string' ? form.text : '');
    if (!parsed.success) {
      const error = parsed.error.issues[0]?.message ?? 'Mensaje no válido';
      if (!isHtmx(request)) {
        return renderPlayground(
          request,
          reply,
          { errors: { text: error }, general: 'Revisa los campos marcados.' },
          422,
        );
      }
      const html = await reply.viewAsync('partials/playground-form', {
        csrf: reply.generateCsrf(),
        disabled: false,
        error,
        oob: false,
      });
      return fragment(
        reply.header('HX-Retarget', '#playground-form').header('HX-Reswap', 'outerHTML'),
        html,
        422,
      );
    }

    const id = playgroundId(request);
    await bot.intake.handle([
      {
        channel: 'playground',
        channelUserId: id,
        channelMessageId: `pg:${id}:${randomUUID()}`,
        // Hora del servidor: el canal no trae marca propia.
        sentAt: bot.clock.now(),
        kind: 'text',
        text: parsed.data,
        caption: null,
        mediaId: null,
        otherType: null,
        isGroup: false,
      },
    ]);
    if (!isHtmx(request)) return reply.redirect('/admin/playground', 303);

    const thread = await readThread(db, id);
    const html = await reply.viewAsync('partials/playground-thread', {
      messages: thread.messages,
      poll: pollCursor(thread),
      wrap: true,
      h: viewHelpers,
    });
    // La caja de texto se sustituye por una vacía (htmx, fuera del objetivo del intercambio).
    const box = await reply.viewAsync('partials/playground-form', {
      csrf: reply.generateCsrf(),
      disabled: false,
      error: '',
      oob: true,
    });
    return fragment(reply, html + box);
  });

  app.get<{ Querystring: { after?: string } }>('/playground/messages', async (request, reply) => {
    const raw = request.query.after ?? '';
    const after = raw === '' ? null : decodeCursor(raw);
    if (raw !== '' && after === null) {
      return reply.code(400).type('text/plain; charset=utf-8').send('Cursor no válido');
    }
    const thread = await readThread(db, playgroundId(request), after);
    if (thread.messages.length === 0) {
      // 204: htmx no cambia nada y sigue sondeando mientras falte la respuesta.
      return thread.waiting ? reply.code(204).send() : fragment(reply, '');
    }
    const html = await reply.viewAsync('partials/playground-thread', {
      messages: thread.messages,
      // Sin indicador: la llegada de la respuesta detiene el sondeo.
      poll: null,
      wrap: false,
      h: viewHelpers,
    });
    return fragment(reply, html);
  });

  app.post('/playground/reset', async (request, reply) => {
    if (!app.bot) return renderPlayground(request, reply, { general: NO_BOT }, 422);
    request.session.set('playgroundId', randomUUID());
    return savedResponse(request, reply, '/admin/playground', 'Conversación de prueba nueva');
  });
}
