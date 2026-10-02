/**
 * Validación del diseño del chat web (011, data-model §3, research R14).
 *
 * Las reglas de cada campo son las mismas en el panel y en la importación (FR-036); lo que
 * cambia es la forma de la entrada: el formulario llega con nombres `snake_case` y descarta las
 * claves desconocidas (US2-5), y el fichero es estricto (`chatDesignFileSchema`). Todo se
 * valida a la vez y se devuelven todos los errores por campo (FR-011a).
 */
import { z } from 'zod';
import {
  ORIGINAL_DESIGN,
  POSITIONS,
  SHAPES,
  SIZES,
  type ChatDesignOptions,
} from './defaults.js';

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
