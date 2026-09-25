/**
 * Puertos del dominio de conversación. `src/conversation` solo habla con el exterior a través
 * de estas interfaces; los adaptadores (canal, modelo, transcripción) viven fuera.
 */
import { randomUUID } from 'node:crypto';
import type { ModelReply, ReplyContext } from './types.js';

export type { Channel, ChannelPolicies, ChannelPolicy } from './channels.js';

export type ChatModelErrorReason = 'timeout' | 'refusal' | 'invalid_output' | 'api_error';

export class ChatModelError extends Error {
  constructor(
    readonly reason: ChatModelErrorReason,
    readonly status?: number,
  ) {
    super(`Fallo del modelo: ${reason}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'ChatModelError';
  }
}

export interface ChatModel {
  /** Una sola llamada; lanza ChatModelError si no hay respuesta válida en el plazo. */
  reply(input: ReplyContext, opts: { signal: AbortSignal; feedback?: string }): Promise<ModelReply>;
}

export interface Transcript {
  text: string;
  /** Código ISO del idioma detectado ("es"). */
  language: string;
  /** Duración del audio, si el proveedor la da. */
  durationSeconds: number | null;
}

export class SpeechToTextError extends Error {
  constructor(
    readonly reason: 'timeout' | 'provider_error',
    readonly status?: number,
  ) {
    super(`Fallo de la transcripción: ${reason}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'SpeechToTextError';
  }
}

export interface SpeechToText {
  /** Transcribe un audio en memoria; lanza SpeechToTextError si falla. */
  transcribe(
    audio: { data: Buffer; mimeType: string },
    opts: { signal: AbortSignal },
  ): Promise<Transcript>;
}

export interface SendOptions {
  /** Se consulta antes de cada reintento; `false` corta (ventana de 24 h cerrada). */
  canRetry?: () => boolean;
}

export class ChannelSendError extends Error {
  constructor(
    readonly attempts: number,
    readonly status?: number,
  ) {
    super(`Envío fallido tras ${attempts} intento(s)${status === undefined ? '' : ` (${status})`}`);
    this.name = 'ChannelSendError';
  }
}

export interface ChannelSender {
  /** `to` es el channel_user_id. Devuelve el id del saliente en el canal. */
  sendText(to: string, body: string, opts?: SendOptions): Promise<{ channelMessageId: string }>;
}

/**
 * Canales cuyas respuestas se guardan y el cliente recoge (web y playground, research R5): no
 * llama a nada externo; el saliente ya está guardado y solo necesita un id propio.
 */
export const storedDelivery: ChannelSender = {
  sendText: async () => ({ channelMessageId: `out:${randomUUID()}` }),
};

export class MediaTooLargeError extends Error {
  constructor() {
    super('El archivo supera el tamaño máximo');
    this.name = 'MediaTooLargeError';
  }
}

export interface MediaFetcher {
  /** Devuelve el audio en memoria; lanza MediaTooLargeError si supera el límite. */
  fetchAudio(mediaId: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string }>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
