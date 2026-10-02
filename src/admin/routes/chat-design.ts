/**
 * Sección "Diseño del chat" del panel (011, contracts/admin-chat-design.md).
 *
 * Solo compone la sesión, el formulario, el dominio de `src/webchat/design` y las vistas. Todas
 * las rutas cuelgan del contexto del operador (`requireOperator` + `csrfOnPost`). El guardado y
 * el contraste en vivo van en un contexto propio con `@fastify/multipart` (R8), como la subida de
 * la 008: el resto del panel sigue aceptando solo formularios urlencoded.
 *
 * La vista previa pinta las mismas parciales que `/chat/frame` (R9) con un Eta propio cuya raíz
 * es `src/`, porque las parciales viven en el canal web.
 */
import { fileURLToPath } from 'node:url';
import multipart from '@fastify/multipart';
import { Eta } from 'eta';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTransaction } from '../../db/client.js';
import { WEB_MESSAGE_MAX_CHARS } from '../../channels/web/api.js';
import { renderDesignCss } from '../../webchat/design/css.js';
import {
  COLOR_FIELDS,
  DEFAULT_PLACEHOLDER,
  DEFAULT_SEND_LABEL,
  defaultChatName,
  SLOTS,
  type ChatDesignOptions,
  type ResolvedChatDesign,
  type Slot,
} from '../../webchat/design/defaults.js';
import type { ImageChange, ImageUpload } from '../../webchat/design/images.js';
import { chatDesignSaved, type ImageOutcome } from '../../webchat/design/log.js';
import {
  COLOR_MESSAGE,
  contrastIssues,
  FORM_FIELD_OF,
  hexColor,
  previewOptions,
  validateChatDesignWithImages,
  type DesignIssue,
  type ValidImageChange,
} from '../../webchat/design/schemas.js';
import { readChatDesign, saveChatDesign } from '../../webchat/design/store.js';
import { computeTheme, designVersion } from '../../webchat/design/theme.js';
import { readWebChatSettings } from '../../webchat/settings.js';
import { readState, renderPage, savedResponse } from '../render.js';

const TITLE = 'Diseño del chat';
const SAVED_MESSAGE = 'Diseño del chat guardado';
const INVALID_MESSAGE = 'No se ha guardado nada: revisa los campos marcados.';
const TOO_MANY_MESSAGE = 'El formulario trae más campos o ficheros de los permitidos.';

/** Tamaño máximo de cada imagen (FR-027) y del cuerpo del guardado (R8). */
export const MAX_IMAGE_BYTES = 256 * 1024;
const BODY_LIMIT = 8 * 1024 * 1024;

/** CSP de la vista previa (R9): sin scripts, imágenes propias o elegidas (`blob:`). */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Rutas de la vista previa: sus cabeceras las pone esta sección, no el gancho global. */
export const CHAT_DESIGN_PREVIEW_PATHS = [
  '/admin/chat-design/preview',
  '/admin/chat-design/preview.css',
];

const srcDir = fileURLToPath(new URL('../..', import.meta.url));

/** Aviso del panel por cada campo guardado que no se ha podido aplicar (R13). */
const UNSUPPORTED_MESSAGES: Record<string, string> = {
  primaryColor: 'El color principal guardado ya no se admite; el chat usa el original',
  onPrimaryColor: 'El color del texto sobre el principal guardado ya no se admite; el chat usa el original',
  backgroundColor: 'El fondo del chat guardado ya no se admite; el chat usa el original',
  textColor: 'El color del texto guardado ya no se admite; el chat usa el original',
  botBubbleColor: 'El fondo de los mensajes del bot guardado ya no se admite; el chat usa el original',
  palette: 'Los colores guardados ya no tienen contraste suficiente; el chat usa los originales',
  shape: 'La forma guardada ya no se admite; el chat usa la original',
  position: 'La posición guardada ya no se admite; el chat usa la original',
  size: 'El tamaño guardado ya no se admite; el chat usa el original',
  chatName: 'El nombre del chat guardado ya no se admite; el chat usa el nombre por defecto',
  welcomeText: 'La bienvenida guardada ya no se admite; el chat no la muestra',
  placeholder: 'El texto de ayuda guardado ya no se admite; el chat usa el de por defecto',
  sendLabel: 'El texto del botón Enviar guardado ya no se admite; el chat usa "Enviar"',
  logo: 'El logo guardado ya no se admite; el chat no lo muestra',
  avatar: 'El avatar guardado ya no se admite; el chat no lo muestra',
  icon: 'El icono del botón guardado ya no se admite; el chat usa el original',
};

/** Valores del formulario a partir de unas opciones. */
const formValues = (o: ChatDesignOptions): Record<string, string> => ({
  primary_color: o.primaryColor,
  on_primary_color: o.onPrimaryColor,
  background_color: o.backgroundColor,
  text_color: o.textColor,
  bot_bubble_color: o.botBubbleColor,
  shape: o.shape,
  position: o.position,
  size: o.size,
  chat_name: o.chatName ?? '',
  welcome_text: o.welcomeText ?? '',
  placeholder: o.placeholder ?? '',
  send_label: o.sendLabel ?? '',
});

/** Texto de un campo tal como llegó (para volver a pintarlo). */
const echo = (value: unknown): string =>
  typeof value === 'string' ? value : Array.isArray(value) ? echo(value[value.length - 1]) : '';

/** Nombre de cada hueco de imagen en el formulario. */
const IMAGE_LABELS: Record<Slot, { label: string; hint: string }> = {
  logo: { label: 'Logo', hint: 'A la izquierda del nombre, en la cabecera del chat.' },
  avatar: { label: 'Avatar', hint: 'Junto a los mensajes del asistente.' },
  icon: { label: 'Icono del botón', hint: 'En el botón flotante, en lugar del icono de mensaje.' },
};

const isUpload = (value: unknown): value is ImageUpload =>
  typeof value === 'object' &&
  value !== null &&
  Buffer.isBuffer((value as ImageUpload).bytes) &&
  typeof (value as ImageUpload).truncated === 'boolean';

/**
 * Cambio de cada hueco (R8): un fichero nuevo sustituye; si no hay fichero, la casilla
 * "Quitar" lo quita; si no, se conserva.
 */
function imageChanges(body: Record<string, unknown>): Record<Slot, ImageChange> {
  const changes = {} as Record<Slot, ImageChange>;
  for (const slot of SLOTS) {
    const upload = body[slot];
    if (isUpload(upload)) changes[slot] = { kind: 'replace', upload };
    else if (echo(body[`${slot}_remove`]) !== '') changes[slot] = { kind: 'remove' };
    else changes[slot] = { kind: 'keep' };
  }
  return changes;
}

/** Qué ha pasado con cada hueco, para el registro (R12). */
function imageOutcome(change: ValidImageChange, existed: boolean): ImageOutcome {
  if (change.kind === 'replace') return existed ? 'replaced' : 'added';
  if (change.kind === 'remove') return existed ? 'removed' : 'none';
  return existed ? 'kept' : 'none';
}

/** Conversación de ejemplo de la vista previa: genérica, sin sector (FR-044). */
const SAMPLE = [
  { from: 'visitor', text: 'Hola, ¿a qué hora abrís mañana?' },
  { from: 'bot', text: 'Hola. Mañana abrimos de 9:00 a 14:00. ¿Te ayudo con algo más?' },
  { from: 'visitor', text: 'Nada más, gracias.' },
] as const;

export async function chatDesignRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;
  const previewEta = new Eta({ views: srcDir, cache: app.env.NODE_ENV === 'production' });

  async function renderForm(
    request: FastifyRequest,
    reply: FastifyReply,
    extra: {
      values?: Record<string, string>;
      issues?: DesignIssue[];
      general?: string;
      reselect?: Slot[];
    } = {},
    status = 200,
  ): Promise<FastifyReply> {
    const state = await readState(deps);
    const design = await readChatDesign(deps.db);
    const errors: Record<string, string> = {};
    for (const issue of extra.issues ?? []) {
      errors[issue.field] = errors[issue.field]
        ? `${errors[issue.field]} · ${issue.message}`
        : issue.message;
    }
    return renderPage(
      request,
      reply,
      'chat-design',
      {
        state,
        title: TITLE,
        values: extra.values ?? formValues(design.options),
        errors,
        ...(extra.general ? { general: extra.general } : {}),
        saved: design.saved,
        images: design.images,
        imageLabels: IMAGE_LABELS,
        reselect: extra.reselect ?? [],
        unsupported: design.unsupported.map((field) => UNSUPPORTED_MESSAGES[field] ?? field),
        defaults: {
          chat_name: defaultChatName(state.business.name),
          placeholder: DEFAULT_PLACEHOLDER,
          send_label: DEFAULT_SEND_LABEL,
        },
      },
      status,
    );
  }

  app.get('/chat-design', async (request, reply) => renderForm(request, reply));

  // Guardado (multipart o urlencoded): único contexto con multipart de la sección (R8).
  await app.register(async (upload) => {
    await upload.register(multipart, {
      attachFieldsToBody: 'keyValues',
      limits: { files: 3, fileSize: MAX_IMAGE_BYTES, fields: 20, fieldSize: 2048 },
      // Un fichero mayor se corta y queda marcado: el error sale en su campo (US3-4). Lo que
      // pasa de 256 KB se descarta mientras se lee.
      throwFileSizeLimit: false,
      onFile: async (part) => {
        const bytes = await part.toBuffer();
        // Un campo de fichero sin elegir llega vacío y sin nombre.
        const upload: ImageUpload | null =
          bytes.length === 0 && part.filename === ''
            ? null
            : { bytes, truncated: part.file.truncated };
        Object.assign(part, { value: upload });
      },
    });

    upload.setErrorHandler(async (error: FastifyError, request, reply) => {
      if (/^FST_(PARTS|FILES|FIELDS)_LIMIT$/.test(error.code)) {
        return renderForm(request, reply, { general: TOO_MANY_MESSAGE }, 400);
      }
      // El resto (CSRF, 500…) lo trata el manejador común del panel.
      throw error;
    });

    upload.post('/chat-design', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const changes = imageChanges(body);
      // Todo o nada (FR-011a): opciones, textos, contraste e imágenes a la vez.
      const result = validateChatDesignWithImages(body, changes);
      if (!result.ok) {
        chatDesignSaved(request.log, {
          outcome: 'rejected',
          reasons: [...new Set(result.issues.map((i) => i.reason))],
        });
        const values = Object.fromEntries(
          [...Object.keys(formValues(previewOptions({}))), ...SLOTS.map((s) => `${s}_remove`)].map(
            (key) => [key, echo(body[key])],
          ),
        );
        // Un fichero elegido no se puede volver a poner en el campo: se pide de nuevo (R8).
        const reselect = SLOTS.filter((slot) => changes[slot]?.kind === 'replace');
        return renderForm(
          request,
          reply,
          { values, issues: result.issues, general: INVALID_MESSAGE, reselect },
          422,
        );
      }
      const before = await readChatDesign(deps.db);
      await withTransaction(deps.db, (tx) => saveChatDesign(tx, result.options, result.images));
      chatDesignSaved(request.log, {
        outcome: 'saved',
        images: Object.fromEntries(
          SLOTS.map((slot) => [slot, imageOutcome(result.images[slot], before.images[slot] !== undefined)]),
        ) as Record<Slot, ImageOutcome>,
      });
      return savedResponse(request, reply, '/admin/chat-design', SAVED_MESSAGE);
    });

    upload.post('/chat-design/check', { bodyLimit: BODY_LIMIT }, contrastCheck);
  });

  /**
   * Contraste en vivo (FR-020): avisos por control de color, sin guardar nada. Acepta
   * urlencoded y multipart; si llega algún fichero, se ignora.
   */
  async function contrastCheck(request: FastifyRequest, reply: FastifyReply) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fields = COLOR_FIELDS.map((option) => FORM_FIELD_OF[option]);
    const messages: Record<string, string[]> = {};
    for (const field of fields) {
      if (!hexColor.safeParse(echo(body[field])).success) messages[field] = [COLOR_MESSAGE];
    }
    for (const issue of contrastIssues(body)) {
      (messages[issue.field] ??= []).push(issue.message);
    }
    const html = await reply.viewAsync('partials/contrast-issues', { fields, messages });
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  }

  /** Datos de las parciales del chat para la vista previa. */
  async function previewData(design: ResolvedChatDesign) {
    const state = await readState(deps);
    const settings = await readWebChatSettings(deps.db);
    return {
      available: true,
      businessName: state.business.name,
      privacyUrl: settings.privacyUrl,
      maxLength: WEB_MESSAGE_MAX_CHARS,
      theme: computeTheme(design, state.business.name),
      designHref: `/chat/design.css?v=${designVersion(design)}`,
      sample: SAMPLE,
    };
  }

  app.get<{ Querystring: { view?: string } }>('/chat-design/preview', async (request, reply) => {
    const design = await readChatDesign(deps.db);
    const view = request.query.view === 'closed' ? 'closed' : 'open';
    const html = await previewEta.renderAsync('/admin/views/chat-design/preview', {
      ...(await previewData(design)),
      view,
    });
    return reply
      .header('Content-Security-Policy', PREVIEW_CSP)
      .header('X-Frame-Options', 'SAMEORIGIN')
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(html);
  });

  app.get<{ Querystring: Record<string, unknown> }>(
    '/chat-design/preview.css',
    async (request, reply) => {
      const design: ResolvedChatDesign = {
        saved: true,
        options: previewOptions(request.query),
        images: {},
        unsupported: [],
      };
      return reply
        .type('text/css; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(renderDesignCss(computeTheme(design, '')));
    },
  );
}
