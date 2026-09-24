/**
 * Puertos del dominio de conversación. `src/conversation` solo habla con el exterior a través
 * de estas interfaces; los adaptadores (canal, modelo, transcripción) viven fuera.
 */
import type { ModelReply, ReplyContext } from './types.js';

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

export interface SpeechToText {
  /** Transcribe un audio en memoria. `language` es el código ISO detectado ("es"). */
  transcribe(
    audio: { data: Buffer; mimeType: string },
    opts: { signal: AbortSignal },
  ): Promise<{ text: string; language: string }>;
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
  /** Envía un texto al número E.164. Devuelve el id del mensaje del canal. */
  sendText(to: string, body: string, opts?: SendOptions): Promise<{ channelMessageId: string }>;
}

export interface MediaFetcher {
  /** Devuelve el audio en memoria o lanza si supera el límite. */
  fetchAudio(mediaId: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string }>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
