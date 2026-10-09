/**
 * API JSON del chat web (004 US3, contracts/web-chat-http.md).
 *
 * Es el adaptador del canal `web`: traduce peticiones del iframe a eventos de la recepción
 * común y respuestas guardadas a JSON. No decide nada sobre cómo se responde (eso es del
 * procesador) ni toca la IP del visitante, que no sale de esta capa (FR-029).
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BotHttp } from '../../app.js';
import * as conversations from '../../conversation/repositories/conversation.js';
import { findByChannel } from '../../conversation/repositories/customer.js';
import {
  decodeCursor,
  encodeCursor,
  hasPending,
  listForConversation,
} from '../../conversation/repositories/message.js';
import { conversationSettings } from '../../conversation/settings.js';
import { formOf, unavailableContact } from '../../conversation/templates.js';
import { isPoolBusy, type Db } from '../../db/client.js';
import { noteDbError } from '../../db/outage.js';
import type { KnowledgeReader } from '../../knowledge/types.js';
import { findActiveByConversation } from '../../handoff/repositories/handoff.js';
import { activeHandoffNotice } from '../../handoff/templates.js';
import {
  unavailable,
  UNAVAILABLE_MESSAGE,
  webChatAvailability,
  type Unavailable,
  type WebChatAvailability,
} from '../../webchat/availability.js';
import type { ProtectionConfig } from '../../usage/protection.js';
import { issueWebSession } from '../../webchat/session-token.js';
import { requireSameOrigin, requireWebSession } from './guards.js';

/** Longitud máxima de un mensaje del visitante (FR-020). */
export const WEB_MESSAGE_MAX_CHARS = 1000;
/** Cuerpo JSON máximo de la API del chat. */
export const WEB_BODY_LIMIT = 8 * 1024;

const messageSchema = z.object({
  clientMessageId: z.uuid(),
  text: z.string().trim().min(1).max(WEB_MESSAGE_MAX_CHARS),
});

export interface WebApiDeps {
  db: Db;
  /** `null` sin `ANTHROPIC_API_KEY`: el chat contesta "no disponible" (R11). */
  bot: BotHttp | null;
  /** Lector del snapshot sobre el pool de `db` (012); por defecto, el del bot. */
  reader?: KnowledgeReader | null;
  /** Último contacto conocido, compartido con el frame (012). */
  lastContact?: { value: string | null };
  /** Contacto de la instancia cuando no hay bot ni snapshot (FR-022). */
  emergencyPhone: string | null;
  sessionSecret: string;
  /** Producción y modelos de la instancia (012). */
  protection?: ProtectionConfig;
}

/** Límite por IP superado; el cuerpo de la respuesta lo compone el manejador de errores. */
class IpLimitError extends Error {
  readonly statusCode = 429;
  constructor(readonly reason: 'session_limit' | 'ip_limit') {
    super('Límite de peticiones por IP superado');
  }
}

/** Límites por IP en memoria (004, R10, FR-025). */
const IP_LIMITS = {
  session: { max: 20, timeWindow: '1 hour' },
  messages: { max: 120, timeWindow: '15 minutes' },
  other: { max: 600, timeWindow: '15 minutes' },
} as const;

export async function webChatApi(api: FastifyInstance, deps: WebApiDeps): Promise<void> {
  const { db, bot, emergencyPhone, sessionSecret } = deps;
  const reader = deps.reader ?? bot?.reader ?? null;
  const activityLog = bot?.activityLog ?? null;
  const now = () => bot?.clock.now() ?? new Date();

  /**
   * Último contacto conocido del negocio. El constructor de la respuesta de
   * `@fastify/rate-limit` es sincrónico y no puede leer la base, así que se guarda el contacto
   * cada vez que se comprueba la disponibilidad; si nunca se ha podido leer, va el de
   * emergencia de la instancia (FR-022).
   */
  const contactHolder = deps.lastContact ?? { value: unavailableContact(null, emergencyPhone) };

  /**
   * Configuración de límite por IP de una ruta. La clave es la común de la app,
   * `clientKey(request.ip)` (respetando `TRUST_PROXY`; IPv6 por su /64, 012); la IP no se
   * registra ni se pasa a ninguna capa de dominio (FR-029, R10).
   *
   * `@fastify/rate-limit` **lanza** lo que devuelve el constructor, así que tiene que ser un
   * `Error` con `statusCode`; el cuerpo del contrato lo da el manejador de errores de abajo.
   */
  const perIp = (
    limit: { max: number; timeWindow: string },
    reason: 'session_limit' | 'ip_limit',
  ) => ({
    rateLimit: {
      max: limit.max,
      timeWindow: limit.timeWindow,
      errorResponseBuilder: () => new IpLimitError(reason),
    },
  });

  // El resto de la app no acepta JSON: el parser existe solo en este plugin.
  api.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: WEB_BODY_LIMIT },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(new SyntaxError('JSON no válido'), undefined);
      }
    },
  );
  // El panel registra `@fastify/formbody` en la raíz y se hereda aquí: sin quitarlo, el chat
  // aceptaría formularios de hasta el límite global (256 KB) en lugar de sus 8 KB.
  api.removeContentTypeParser('application/x-www-form-urlencoded');

  /** Límite por IP, cuerpo demasiado grande o JSON roto: nada llega a la recepción. */
  api.setErrorHandler(async (error: FastifyError, request, reply: FastifyReply) => {
    // 016 (FR-014): si el fallo es porque la base de datos no está, el vigilante del corte lo
    // agrupa y lo registra una sola vez. **Ninguna respuesta cambia**: el 503 con `unavailable`
    // y el contacto de emergencia que ya da este canal es justamente el correcto (FR-002).
    noteDbError(error);
    const status = error.statusCode ?? 500;
    if (error instanceof IpLimitError) {
      // Sin la IP en el registro: solo que se ha alcanzado el límite (FR-029).
      activityLog?.log({ event: 'web_rejected', reason: error.reason });
      return reply.code(429).send({
        unavailable: {
          reason: 'ip_limit',
          message: UNAVAILABLE_MESSAGE,
          contact: contactHolder.value,
        },
      });
    }
    if (status === 413 || error instanceof SyntaxError || status === 400) {
      activityLog?.log({ event: 'web_rejected', reason: 'invalid' });
      return reply.code(status === 413 ? 413 : 400).send({ error: 'body' });
    }
    if (status < 500) return reply.code(status).send({ error: 'request' });
    // 012: el pool público no dio conexión a tiempo; el iframe lo reintenta.
    if (isPoolBusy(error)) return reply.code(503).send({ error: 'busy' });
    // Un fallo repetido del canal público tiene que dejar rastro; el serializador de
    // peticiones no registra la IP y `redact` cubre la cabecera de autorización.
    request.log.error({ err: error }, 'Error en el chat web');
    return reply.code(500).send({ error: 'server' });
  });

  api.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  api.addHook('preHandler', requireSameOrigin({ activityLog }));

  /** Estado del chat ahora mismo; sin bot, "no disponible" sin tocar la base. */
  const availability = async (): Promise<WebChatAvailability> => {
    const state: WebChatAvailability =
      bot && reader
        ? await webChatAvailability({
            tx: db,
            reader,
            botPresent: true,
            emergencyPhone,
            now: now(),
            activityLog: bot.activityLog,
            ...(deps.protection ? { protection: deps.protection } : {}),
          })
        : { available: false, unavailable: unavailable('no_bot', null, emergencyPhone) };
    contactHolder.value = state.available
      ? unavailableContact(state.snapshot, emergencyPhone)
      : state.unavailable.contact;
    return state;
  };

  api.post(
    '/session',
    { config: perIp(IP_LIMITS.session, 'session_limit') },
    async (_request, reply) => {
      const state = await availability();
      if (!state.available) return reply.code(200).send({ unavailable: state.unavailable });
      const { token } = issueWebSession(sessionSecret);
      activityLog?.log({ event: 'web_session_created' });
      return reply.code(201).send({ token });
    },
  );

  await api.register(async (authed) => {
    authed.addHook('preHandler', requireWebSession({ secret: sessionSecret, activityLog }));

    /** Identificador del visitante ya comprobado por la guarda. */
    const visitorOf = (request: FastifyRequest): string => {
      const id = request.webVisitor?.channelUserId;
      if (id === undefined) throw new Error('Petición sin sesión comprobada');
      return id;
    };

    authed.get(
      '/state',
      { config: perIp(IP_LIMITS.other, 'ip_limit') },
      async (_request, reply) => {
        const state = await availability();
        const snapshot = state.available ? state.snapshot : null;
        return reply.code(200).send({
          available: state.available,
          businessName: snapshot?.business.name ?? null,
          privacyUrl: state.available ? state.settings.privacyUrl : null,
          // Siempre: el iframe lo usa también para la disculpa si algo falla (FR-021).
          contact: state.available
            ? unavailableContact(snapshot, emergencyPhone)
            : state.unavailable.contact,
          maxLength: WEB_MESSAGE_MAX_CHARS,
          unavailable: state.available ? null : state.unavailable,
        });
      },
    );

    /** Conversación vigente del visitante: la última con un entrante de hace menos de 24 h. */
    async function currentConversation(channelUserId: string) {
      const customer = await findByChannel(db, 'web', channelUserId);
      if (!customer) return null;
      const latest = await conversations.findLatestForCustomer(db, customer.id);
      if (!latest) return null;
      const age = now().getTime() - latest.lastInboundAt.getTime();
      return age <= conversationSettings.conversationWindowMs ? latest : null;
    }

    authed.get<{ Querystring: { after?: string } }>(
      '/messages',
      { config: perIp(IP_LIMITS.other, 'ip_limit') },
      async (request, reply) => {
        const raw = request.query.after ?? '';
        const after = raw === '' ? null : decodeCursor(raw);
        if (raw !== '' && after === null) {
          activityLog?.log({ event: 'web_rejected', reason: 'invalid' });
          return reply.code(400).send({ error: 'after' });
        }
        const conversation = await currentConversation(visitorOf(request));
        if (!conversation) {
          return reply
            .code(200)
            .send({ messages: [], cursor: null, waiting: false, handoff: null });
        }
        const rows = await listForConversation(db, conversation.id, after);
        const last = rows.at(-1);
        const handoff = await handoffBanner(conversation.id);
        return reply.code(200).send({
          // Nunca `reply_trace`: la información técnica es solo del panel (FR-009).
          messages: rows.map((m) => ({
            id: m.id,
            from: m.direction === 'outbound' ? 'bot' : 'visitor',
            text: m.body ?? '',
            at: m.sentAt.toISOString(),
          })),
          cursor: last ? encodeCursor(last) : raw === '' ? null : raw,
          // Con la conversación derivada no hay respuesta que esperar (005, R15).
          waiting: handoff ? false : await hasPending(db, conversation.id),
          handoff,
        });
      },
    );

    authed.post(
      '/messages',
      { bodyLimit: WEB_BODY_LIMIT, config: perIp(IP_LIMITS.messages, 'ip_limit') },
      async (request, reply) => {
        const parsed = messageSchema.safeParse(request.body);
        if (!parsed.success) {
          activityLog?.log({ event: 'web_rejected', reason: 'invalid' });
          const field =
            parsed.error.issues[0]?.path[0] === 'clientMessageId' ? 'clientMessageId' : 'text';
          return reply.code(400).send({ error: field, maxLength: WEB_MESSAGE_MAX_CHARS });
        }
        if (!bot) {
          return reply
            .code(200)
            .send({ accepted: false, unavailable: unavailable('no_bot', null, emergencyPhone) });
        }

        const channelUserId = visitorOf(request);
        const { clientMessageId, text } = parsed.data;
        let outcome;
        try {
          [outcome] = await bot.intake.handle([
            {
              channel: 'web',
              channelUserId,
              // FR-023: el reintento del navegador no crea otro mensaje.
              channelMessageId: `web:${channelUserId}:${clientMessageId}`,
              sentAt: now(),
              kind: 'text',
              text,
              caption: null,
              mediaId: null,
              otherType: null,
              isGroup: false,
              profileName: null,
              buttonPayload: null,
            },
          ]);
        } catch {
          // FR-022: sin información del negocio se contesta con el contacto de emergencia.
          return reply.code(503).send({ unavailable: unavailable('no_bot', null, emergencyPhone) });
        }
        if (!outcome) throw new Error('La recepción no devolvió resultado');

        if (outcome.status === 'discarded') {
          // El tope de gasto (010) se ve igual que el de respuestas: "no disponible" (FR-017).
          const reason =
            outcome.reason === 'group'
              ? 'disabled'
              : outcome.reason === 'spend_cap'
                ? 'quota'
                : outcome.reason;
          const snapshot = await readableSnapshot();
          return reply
            .code(200)
            .send({ accepted: false, unavailable: unavailable(reason, snapshot, emergencyPhone) });
        }
        // Guardado, repetido o limitado: para el visitante es lo mismo (el bot ya decidirá).
        return reply.code(202).send({ accepted: true });
      },
    );

    /**
     * Aviso fijo de la derivación activa (005, FR-013a): con el teléfono que dio el visitante y
     * nunca los destinos de avisos del negocio; `null` sin derivación.
     */
    async function handoffBanner(
      conversationId: string,
    ): Promise<{ active: true; notice: string } | null> {
      const active = await findActiveByConversation(db, conversationId);
      if (!active) return null;
      const snapshot = await readableSnapshot();
      const notice = activeHandoffNotice(
        snapshot?.business.name ?? 'el negocio',
        active.customerPhone ?? '',
        formOf(snapshot?.tone.addressForm ?? null),
      );
      return { active: true, notice };
    }

    /** Snapshot para el contacto del objeto `unavailable`; `null` si no se puede leer. */
    async function readableSnapshot() {
      if (!reader) return null;
      try {
        return await reader.getSnapshot();
      } catch {
        return null;
      }
    }
  });
}

/** Objeto `unavailable` tal como lo manda la API (para los tests y el frame). */
export type { Unavailable };
