/**
 * Validación del diseño del chat web (011, data-model §3, research R14).
 *
 * Las reglas de cada campo son las mismas en el panel y en la importación (FR-036); lo que
 * cambia es la forma de la entrada: el formulario llega con nombres `snake_case` y descarta las
 * claves desconocidas (US2-5), y el fichero es estricto (`chatDesignFileSchema`). Todo se
 * valida a la vez y se devuelven todos los errores por campo (FR-011a).
 */
import { z } from 'zod';
import { contrastFailures } from './contrast.js';
import {
  COLOR_FIELDS,
  IMAGE_TYPES,
  SLOTS,
  type Slot,
  ORIGINAL_DESIGN,
  POSITIONS,
  SHAPES,
  SIZES,
  type ChatDesignOptions,
  type ColorField,
  type Hex,
} from './defaults.js';
import {
  MAX_IMAGE_BYTES,
  TOO_BIG_MESSAGE,
  validateDesignImage,
  type DesignImage,
  type ImageChange,
} from './images.js';

export const COLOR_MESSAGE = 'Indica un color opaco en formato #RRGGBB';
export const OPTION_MESSAGE = 'Opción no válida';
export const SINGLE_LINE_MESSAGE = 'Este texto va en una sola línea';
export const CONTROL_MESSAGE = 'El texto tiene caracteres no permitidos';
export const maxLengthMessage = (max: number): string => `Máximo ${max} caracteres`;

/** Textos del diseño: máximo en unidades UTF-16 (como `maxlength`) y si admiten saltos (R14). */
export const TEXT_LIMITS = {
  chatName: { max: 40, multiline: false },
  welcomeText: { max: 280, multiline: true },
  placeholder: { max: 80, multiline: false },
  sendLabel: { max: 20, multiline: false },
} as const;
export type TextField = keyof typeof TEXT_LIMITS;

const HEX = /^#[0-9a-f]{6}$/i;
// Caracteres de control C0, DEL y C1 (el salto de línea se trata aparte).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Color `#rrggbb` opaco, normalizado a minúsculas; sin alfa ni nombres (FR-006). */
export const hexColor = z
  .string({ error: COLOR_MESSAGE })
  .transform((raw, ctx) => {
    const value = raw.trim();
    if (!HEX.test(value)) {
      ctx.addIssue({ code: 'custom', message: COLOR_MESSAGE });
      return z.NEVER;
    }
    return value.toLowerCase();
  });

export const shapeSchema = z.enum(SHAPES, { error: OPTION_MESSAGE });
export const positionSchema = z.enum(POSITIONS, { error: OPTION_MESSAGE });
export const sizeSchema = z.enum(SIZES, { error: OPTION_MESSAGE });

/**
 * Texto del diseño: se recortan los extremos, vacío es `null` (valor por defecto) y se
 * rechazan los caracteres de control; la bienvenida admite saltos de línea (`\r\n` → `\n`).
 */
export function textSchema(field: TextField) {
  const { max, multiline } = TEXT_LIMITS[field];
  return z
    .string({ error: 'Texto no válido' })
    .nullable()
    .transform((raw, ctx) => {
      if (raw === null) return null;
      const value = raw.replace(/\r\n?/g, '\n').trim();
      if (value === '') return null;
      if (!multiline && value.includes('\n')) {
        ctx.addIssue({ code: 'custom', message: SINGLE_LINE_MESSAGE });
        return z.NEVER;
      }
      if (CONTROL.test(value)) {
        ctx.addIssue({ code: 'custom', message: CONTROL_MESSAGE });
        return z.NEVER;
      }
      if (value.length > max) {
        ctx.addIssue({ code: 'custom', message: maxLengthMessage(max) });
        return z.NEVER;
      }
      return value;
    });
}

/** Opciones del diseño en la forma del dominio; las claves desconocidas se descartan. */
export const chatDesignOptionsSchema = z.object({
  primaryColor: hexColor,
  onPrimaryColor: hexColor,
  backgroundColor: hexColor,
  textColor: hexColor,
  botBubbleColor: hexColor,
  shape: shapeSchema,
  position: positionSchema,
  size: sizeSchema,
  chatName: textSchema('chatName'),
  welcomeText: textSchema('welcomeText'),
  placeholder: textSchema('placeholder'),
  sendLabel: textSchema('sendLabel'),
});

/** Campo del formulario del panel → opción del dominio (contracts/admin-chat-design.md). */
export const FORM_FIELDS = {
  primary_color: 'primaryColor',
  on_primary_color: 'onPrimaryColor',
  background_color: 'backgroundColor',
  text_color: 'textColor',
  bot_bubble_color: 'botBubbleColor',
  shape: 'shape',
  position: 'position',
  size: 'size',
  chat_name: 'chatName',
  welcome_text: 'welcomeText',
  placeholder: 'placeholder',
  send_label: 'sendLabel',
} as const satisfies Record<string, keyof ChatDesignOptions>;
export type FormField = keyof typeof FORM_FIELDS;

/** Opción del dominio → campo del formulario. */
export const FORM_FIELD_OF = Object.fromEntries(
  Object.entries(FORM_FIELDS).map(([form, option]) => [option, form]),
) as Record<keyof ChatDesignOptions, FormField>;

/**
 * Valor de un campo del formulario: si llega repetido se toma el último; si no llega, el
 * original (los textos, vacíos).
 */
const formValue = (option: keyof ChatDesignOptions) => (raw: unknown) => {
  const value: unknown = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (value === undefined) return ORIGINAL_DESIGN[option];
  return value;
};

const formField = <T extends z.ZodType>(option: keyof ChatDesignOptions, schema: T) =>
  z.preprocess(formValue(option), schema);

/** Formulario del panel: nombres `snake_case`; descarta las claves desconocidas (US2-5). */
export const chatDesignFormSchema = z
  .object({
    primary_color: formField('primaryColor', hexColor),
    on_primary_color: formField('onPrimaryColor', hexColor),
    background_color: formField('backgroundColor', hexColor),
    text_color: formField('textColor', hexColor),
    bot_bubble_color: formField('botBubbleColor', hexColor),
    shape: formField('shape', shapeSchema),
    position: formField('position', positionSchema),
    size: formField('size', sizeSchema),
    chat_name: formField('chatName', textSchema('chatName')),
    welcome_text: formField('welcomeText', textSchema('welcomeText')),
    placeholder: formField('placeholder', textSchema('placeholder')),
    send_label: formField('sendLabel', textSchema('sendLabel')),
  })
  .transform(
    (f): ChatDesignOptions => ({
      primaryColor: f.primary_color,
      onPrimaryColor: f.on_primary_color,
      backgroundColor: f.background_color,
      textColor: f.text_color,
      botBubbleColor: f.bot_bubble_color,
      shape: f.shape,
      position: f.position,
      size: f.size,
      chatName: f.chat_name,
      welcomeText: f.welcome_text,
      placeholder: f.placeholder,
      sendLabel: f.send_label,
    }),
  );

/** Motivo de un error, para el registro `chat_design_saved` (R12). */
export type IssueReason = 'option' | 'text' | 'contrast' | 'image';

/** Error de un campo del formulario (o de un hueco de imagen). */
export interface DesignIssue {
  field: string;
  message: string;
  reason: IssueReason;
}

export type DesignValidation =
  | { ok: true; options: ChatDesignOptions }
  | { ok: false; issues: DesignIssue[]; errors: Record<string, string> };

const TEXT_FORM_FIELDS = new Set(['chat_name', 'welcome_text', 'placeholder', 'send_label']);

/** Errores por campo: si un campo tiene varios, se unen en el mismo mensaje. */
export function issuesToErrors(issues: DesignIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const before = errors[issue.field];
    errors[issue.field] = before ? `${before} · ${issue.message}` : issue.message;
  }
  return errors;
}

/** Opciones y textos del formulario, con todos los errores a la vez (FR-011a). */
export function validateChatDesignOptions(input: unknown): DesignValidation {
  const parsed = chatDesignFormSchema.safeParse(
    typeof input === 'object' && input !== null ? input : {},
  );
  if (parsed.success) return { ok: true, options: parsed.data };
  const issues = parsed.error.issues.map((issue): DesignIssue => {
    const field = String(issue.path[0] ?? '_form');
    return {
      field,
      message: issue.message,
      reason: TEXT_FORM_FIELDS.has(field) ? 'text' : 'option',
    };
  });
  return { ok: false, issues, errors: issuesToErrors(issues) };
}

/**
 * Opciones de la vista previa en vivo (`preview.css`): cada campo que falte o no valga toma el
 * original, sin errores (solo es una vista, R9). Los textos no se usan aquí.
 */
export function previewOptions(input: Record<string, unknown>): ChatDesignOptions {
  const shape = chatDesignFormSchema.def.in.shape;
  const options: Record<string, unknown> = { ...ORIGINAL_DESIGN };
  for (const [form, option] of Object.entries(FORM_FIELDS)) {
    if (TEXT_FORM_FIELDS.has(form)) continue;
    const parsed = shape[form as FormField].safeParse(input[form]);
    if (parsed.success) options[option] = parsed.data;
  }
  return options as unknown as ChatDesignOptions;
}

/** Colores del formulario que se pueden leer (los mal escritos ya tienen su propio error). */
function formColors(input: Record<string, unknown>): Partial<Record<ColorField, Hex>> {
  const colors: Partial<Record<ColorField, Hex>> = {};
  for (const option of COLOR_FIELDS) {
    const raw = formValue(option)(input[FORM_FIELD_OF[option]]);
    const parsed = hexColor.safeParse(raw);
    if (parsed.success) colors[option] = parsed.data;
  }
  return colors;
}

/**
 * Errores de contraste del formulario (FR-019, FR-020). Cada pareja se marca en los dos colores
 * que la forman, así sale junto al control que el operador esté cambiando.
 */
export function contrastIssues(input: Record<string, unknown>): DesignIssue[] {
  return contrastFailures(formColors(input)).flatMap((failure) =>
    [failure.pair.fg, failure.pair.bg].map(
      (option): DesignIssue => ({
        field: FORM_FIELD_OF[option],
        message: failure.message,
        reason: 'contrast',
      }),
    ),
  );
}

/** Opciones, textos y contraste del formulario, con todos los errores a la vez (FR-011a). */
export function validateChatDesign(input: unknown): DesignValidation {
  const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const base = validateChatDesignOptions(body);
  const contrast = contrastIssues(body);
  if (base.ok && contrast.length === 0) return base;
  const issues = [...(base.ok ? [] : base.issues), ...contrast];
  return { ok: false, issues, errors: issuesToErrors(issues) };
}

/** Cambio de un hueco ya validado: la imagen nueva sale normalizada (R7). */
export type ValidImageChange =
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'replace'; image: DesignImage };

export type FullDesignValidation =
  | { ok: true; options: ChatDesignOptions; images: Record<Slot, ValidImageChange> }
  | { ok: false; issues: DesignIssue[]; errors: Record<string, string> };

/**
 * Guardado del panel: opciones, textos, contraste e imágenes, todo a la vez (FR-011a). Los
 * errores de imagen van en el campo del hueco (`logo`, `avatar`, `icon`).
 */
export function validateChatDesignWithImages(
  input: unknown,
  changes: Partial<Record<Slot, ImageChange>> = {},
): FullDesignValidation {
  const base = validateChatDesign(input);
  const images = {} as Record<Slot, ValidImageChange>;
  const imageIssues: DesignIssue[] = [];
  for (const slot of SLOTS) {
    const change = changes[slot] ?? { kind: 'keep' };
    if (change.kind !== 'replace') {
      images[slot] = change;
      continue;
    }
    const result = validateDesignImage(change.upload);
    if (result.ok) images[slot] = { kind: 'replace', image: result.image };
    else imageIssues.push({ field: slot, message: result.message, reason: 'image' });
  }
  if (base.ok && imageIssues.length === 0) return { ok: true, options: base.options, images };
  const issues = [...(base.ok ? [] : base.issues), ...imageIssues];
  return { ok: false, issues, errors: issuesToErrors(issues) };
}

// --- Fichero de configuración (011, contracts/config-file-chat-design.md) ----------------

export const MISSING_FIELD_MESSAGE = 'Falta este campo';
export const BASE64_MESSAGE = 'La imagen no está en base64';
export const TYPE_MISMATCH_MESSAGE = 'El tipo declarado no coincide con el contenido de la imagen';

/** La clave tiene que estar, con su valor o `null` (un campo que falta no se da por vacío). */
const required = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value, ctx) => {
    if (value === undefined) {
      ctx.addIssue({ code: 'custom', message: MISSING_FIELD_MESSAGE });
      return z.NEVER;
    }
    return value;
  }, schema);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Base64 de 256 KB: lo que pase de aquí ni se decodifica. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/**
 * Imagen del fichero: el tipo declarado tiene que coincidir con el detectado y la imagen cumplir
 * R7. Sale normalizada (sin metadatos), así que reimportar no muestra cambios (SC-008).
 */
const fileImageSchema = z
  .strictObject({ type: z.enum(IMAGE_TYPES), data: z.string() })
  .transform((image, ctx) => {
    const { data } = image;
    if (data.length % 4 !== 0 || !BASE64.test(data)) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: BASE64_MESSAGE });
      return z.NEVER;
    }
    if (data.length > MAX_BASE64_LENGTH) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: TOO_BIG_MESSAGE });
      return z.NEVER;
    }
    const result = validateDesignImage({ bytes: Buffer.from(data, 'base64'), truncated: false });
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: result.message });
      return z.NEVER;
    }
    if (result.image.mimeType !== image.type) {
      ctx.addIssue({ code: 'custom', path: ['type'], message: TYPE_MISMATCH_MESSAGE });
      return z.NEVER;
    }
    return { type: result.image.mimeType, data: result.image.bytes.toString('base64') };
  });

/**
 * Sección `chatDesign` del fichero: objetos estrictos, las mismas reglas que el panel
 * (FR-036). El contraste lo comprueba `fileContrastIssues`, sobre el fichero tal cual, para que
 * salga a la vez que los errores de los campos.
 */
export const chatDesignFileSchema = z.strictObject({
  primaryColor: hexColor,
  onPrimaryColor: hexColor,
  backgroundColor: hexColor,
  textColor: hexColor,
  botBubbleColor: hexColor,
  shape: z.enum(SHAPES),
  position: z.enum(POSITIONS),
  size: z.enum(SIZES),
  chatName: required(textSchema('chatName')),
  welcomeText: required(textSchema('welcomeText')),
  placeholder: required(textSchema('placeholder')),
  sendLabel: required(textSchema('sendLabel')),
  images: z.strictObject({
    logo: required(fileImageSchema.nullable()),
    avatar: required(fileImageSchema.nullable()),
    icon: required(fileImageSchema.nullable()),
  }),
});

/**
 * Parejas sin contraste en la sección del fichero tal cual (solo con los colores bien escritos:
 * los demás ya tienen su error). Cada pareja se marca en su primer color.
 */
export function fileContrastIssues(raw: unknown): Array<{ path: string[]; message: string }> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const colors: Partial<Record<ColorField, Hex>> = {};
  for (const field of COLOR_FIELDS) {
    const parsed = hexColor.safeParse((raw as Record<string, unknown>)[field]);
    if (parsed.success) colors[field] = parsed.data;
  }
  return contrastFailures(colors).map((failure) => ({
    path: [failure.pair.fg],
    message: failure.message,
  }));
}
