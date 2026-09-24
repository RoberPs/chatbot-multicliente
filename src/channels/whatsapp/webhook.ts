/**
 * Webhook de la WhatsApp Cloud API (contracts/whatsapp-webhook.md).
 *
 * Plugin encapsulado: el parser JSON solo existe en este contexto y conserva el cuerpo en
 * bruto para verificar la firma; el resto de la app sigue sin aceptar JSON.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ActivityLog } from '../../conversation/activity-log.js';
import type { InboundEvent } from '../../conversation/types.js';
import type { WhatsAppEnv } from '../../config/env.js';
import { parseWebhookPayload } from './payload.js';

export interface WhatsAppWebhookOptions {
  config: WhatsAppEnv;
  audioTranscription: boolean;
  activityLog: ActivityLog;
  /** Guarda los mensajes; si lanza, se responde 503 para que Meta reintente. */
  onInbound: (events: InboundEvent[]) => Promise<void>;
}

const BODY_LIMIT = 512 * 1024;

/** Comparación en tiempo constante de dos textos de cualquier longitud. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function validSignature(raw: Buffer, header: unknown, secret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return safeEqual(header.toLowerCase(), expected);
}

export const whatsappWebhook: FastifyPluginAsync<WhatsAppWebhookOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const { config, activityLog } = opts;

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (
      mode === 'subscribe' &&
      typeof token === 'string' &&
      typeof challenge === 'string' &&
      safeEqual(token, config.verifyToken)
    ) {
      return reply.code(200).type('text/plain; charset=utf-8').send(challenge);
    }
    return reply.code(403).type('text/plain; charset=utf-8').send('Forbidden');
  });

  app.post('/', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (!validSignature(raw, request.headers['x-hub-signature-256'], config.appSecret)) {
      activityLog.log({ event: 'webhook_rejected', reason: 'signature' });
      return reply.code(401).send();
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      json = undefined;
    }
    const parsed = parseWebhookPayload(json, {
      phoneNumberId: config.phoneNumberId,
      audioTranscription: opts.audioTranscription,
    });
    if (!parsed.ok) {
      activityLog.log({ event: 'webhook_rejected', reason: 'payload' });
      return reply.code(400).send();
    }

    for (let i = 0; i < parsed.data.failedStatuses; i++) {
      activityLog.log({ event: 'send_failed', attempts: 1, finalFailure: true });
    }
    const events: InboundEvent[] = [];
    for (const event of parsed.data.events) {
      if (event.isGroup) {
        activityLog.log({ event: 'message_discarded', reason: 'group' });
      } else {
        events.push(event);
      }
    }
    if (events.length > 0) {
      try {
        await opts.onInbound(events);
      } catch (error) {
        request.log.error({ errorClass: (error as Error).name }, 'Recepción de WhatsApp fallida');
        return reply.code(503).send();
      }
    }
    return reply.code(200).send();
  });
};
