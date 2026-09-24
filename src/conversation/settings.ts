/** Constantes de la atención automática (plan y research R4 – R11). */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const conversationSettings = {
  /** Espera sin mensajes nuevos del cliente antes de responder (R5). */
  batchQuietMs: 3 * SECOND,
  /** Tope desde el primer pendiente para quien escribe sin parar (R5). */
  batchMaxWaitMs: 8 * SECOND,
  /** Barrido de seguridad del procesador (R5). */
  processorSweepMs: 1 * SECOND,
  /** Conversaciones procesándose a la vez (R5). */
  processorConcurrency: 4,
  /** Mensajes de la conversación que se pasan al modelo (R4). */
  historyLimit: 30,
  /** Ventana de conversación y de atención de WhatsApp (FR-019, FR-002a). */
  conversationWindowMs: 24 * HOUR,
  /** Límite por número: mensajes en la ventana deslizante (R6). */
  rateLimitMessages: 30,
  rateLimitWindowMs: 15 * MINUTE,
  /** Borrado de conversaciones (FR-030, R11). */
  retentionMs: 30 * 24 * HOUR,
  retentionSweepMs: 1 * HOUR,
  /** Audios (R10). */
  audioMaxBytes: 2 * 1024 * 1024,
  audioMaxSeconds: 120,
  transcriptionTimeoutMs: 10 * SECOND,
  /** Plazo total del modelo por respuesta, compartido por los dos intentos (R7). */
  modelBudgetMs: 20 * SECOND,
  /** Margen mínimo para hacer el segundo intento tras un rechazo del verificador (R7). */
  minRetryBudgetMs: 5 * SECOND,
  /** Esperas entre reintentos de envío a la Graph API. */
  sendRetryDelaysMs: [1 * SECOND, 4 * SECOND, 15 * SECOND] as readonly number[],
  /** Longitud máxima del cuerpo que escribe el modelo. */
  modelBodyMaxChars: 1500,
  /** Longitud máxima de un mensaje de WhatsApp. */
  messageMaxChars: 4096,
} as const;

export type ConversationSettings = typeof conversationSettings;
