/**
 * Puertos del dominio de conversación. `src/conversation` solo habla con el exterior a través
 * de estas interfaces; los adaptadores (canal, modelo, transcripción) viven fuera.
 */
import { randomUUID } from 'node:crypto';
import type { TokenUsage } from '../usage/types.js';
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
  /**
   * Una sola llamada; lanza ChatModelError si no hay respuesta válida en el plazo. Si el
   * proveedor responde (aunque la respuesta se descarte), llama una vez a `onUsage` con sus
   * tokens antes de devolver o lanzar (010, R1).
   */
  reply(
    input: ReplyContext,
    opts: { signal: AbortSignal; feedback?: string; onUsage?: (usage: TokenUsage) => void },
  ): Promise<ModelReply>;
}

export interface Transcript {
  text: string;
  /** Código ISO del idioma detectado ("es"). */
  language: string;
  /** Duración del audio, si el proveedor la da. */
  durationSeconds: number | null;
}

export class SpeechToTextError extends Error {
  /** El proveedor respondió (y puede haber cobrado): el consumo se registra igual (012, R6). */
  readonly responded: boolean;
  /** Duración que informó el proveedor en su respuesta, si la dio. */
  readonly durationSeconds: number | null;

  constructor(
    readonly reason: 'timeout' | 'provider_error',
    readonly status?: number,
    details: { responded?: boolean; durationSeconds?: number | null } = {},
  ) {
    super(`Fallo de la transcripción: ${reason}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'SpeechToTextError';
    this.responded = details.responded ?? false;
    this.durationSeconds = details.durationSeconds ?? null;
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
  /** Plazo de quien llama, combinado con el propio del canal (012, R11). */
  signal?: AbortSignal;
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
  /**
   * Devuelve el audio en memoria; lanza MediaTooLargeError si supera el límite. La descarga
   * respeta `signal`: el plazo de la transcripción la cubre entera (012, R11).
   */
  fetchAudio(
    mediaId: string,
    maxBytes: number,
    opts?: { signal?: AbortSignal },
  ): Promise<{ data: Buffer; mimeType: string }>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
