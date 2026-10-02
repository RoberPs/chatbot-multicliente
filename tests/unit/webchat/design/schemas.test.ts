/**
 * Validación de opciones y textos del diseño (011, data-model §3, research R14).
 */
import { describe, expect, it } from 'vitest';
import { ORIGINAL_DESIGN } from '../../../../src/webchat/design/defaults.js';
import {
  hexColor,
  textSchema,
  validateChatDesign,
  validateChatDesignOptions,
} from '../../../../src/webchat/design/schemas.js';

const FORM = {
  primary_color: '#1F5FBF',
  on_primary_color: '#ffffff',
  background_color: '#ffffff',
  text_color: '#1d2330',
  bot_bubble_color: '#ffffff',
  shape: 'round',
  position: 'right',
  size: 'medium',
  chat_name: '',
  welcome_text: '',
  placeholder: '',
  send_label: '',
};

describe('colores', () => {
  it('se normalizan a minúsculas', () => {
    expect(hexColor.parse('#1F5FBF')).toBe('#1f5fbf');
    expect(hexColor.parse(' #AbCdEf ')).toBe('#abcdef');
  });

  it.each(['#1f5fbf80', 'red', '#fff', '1f5fbf', '#1f5fbg', ''])('rechaza %j', (value) => {
    const result = hexColor.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Indica un color opaco en formato #RRGGBB');
  });
});

describe('textos', () => {
  it.each([
    ['chatName', 40],
    ['welcomeText', 280],
    ['placeholder', 80],
    ['sendLabel', 20],
  ] as const)('%s admite %i caracteres y no uno más', (field, max) => {
    expect(textSchema(field).parse('a'.repeat(max))).toBe('a'.repeat(max));
    const over = textSchema(field).safeParse('a'.repeat(max + 1));
    expect(over.error?.issues[0]?.message).toBe(`Máximo ${max} caracteres`);
  });

  it('la longitud se cuenta en unidades UTF-16, como maxlength', () => {
    // Un emoji fuera del plano básico ocupa dos unidades.
    expect(textSchema('sendLabel').parse('😀'.repeat(10))).toBe('😀'.repeat(10));
    expect(textSchema('sendLabel').safeParse(`${'😀'.repeat(10)}a`).success).toBe(false);
  });

  it('salto de línea solo en la bienvenida (\\r\\n → \\n)', () => {
    expect(textSchema('welcomeText').parse('Hola\r\nQué tal')).toBe('Hola\nQué tal');
    for (const field of ['chatName', 'placeholder', 'sendLabel'] as const) {
      const result = textSchema(field).safeParse('Hola\nQué tal');
      expect(result.error?.issues[0]?.message).toBe('Este texto va en una sola línea');
    }
  });

  it('rechaza caracteres de control', () => {
    expect(textSchema('chatName').safeParse('Hola\u0007').success).toBe(false);
    expect(textSchema('welcomeText').safeParse('Hola\u0000mundo').success).toBe(false);
    expect(textSchema('chatName').safeParse('Hola\tmundo').success).toBe(false);
  });

  it('recorta los extremos y vacío es null', () => {
    expect(textSchema('chatName').parse('  Recepción  ')).toBe('Recepción');
    expect(textSchema('chatName').parse('   ')).toBeNull();
    expect(textSchema('chatName').parse('')).toBeNull();
    expect(textSchema('chatName').parse(null)).toBeNull();
  });

  it('admite emojis y texto con marcas, que se pintan escapados', () => {
    expect(textSchema('chatName').parse('Hola 👋 <b>x</b> {{ y }}')).toBe('Hola 👋 <b>x</b> {{ y }}');
  });
});

describe('validateChatDesignOptions', () => {
  it('formulario válido → opciones del dominio', () => {
    const result = validateChatDesignOptions({ ...FORM, chat_name: ' Recepción ' });
    expect(result).toEqual({
      ok: true,
      options: { ...ORIGINAL_DESIGN, chatName: 'Recepción' },
    });
  });

  it('las claves desconocidas se descartan (aviso y privacidad no se pueden tocar)', () => {
    const result = validateChatDesignOptions({
      ...FORM,
      privacy_notice: '',
      hide_privacy: '1',
      __proto__: { x: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.options).sort()).toEqual(Object.keys(ORIGINAL_DESIGN).sort());
  });

  it('devuelve todos los errores a la vez, cada uno en su campo', () => {
    const result = validateChatDesignOptions({
      ...FORM,
      primary_color: 'rojo',
      shape: 'hexagonal',
      size: 'huge',
      chat_name: 'x'.repeat(41),
      send_label: 'Enviar\nya',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      primary_color: 'Indica un color opaco en formato #RRGGBB',
      shape: 'Opción no válida',
      size: 'Opción no válida',
      chat_name: 'Máximo 40 caracteres',
      send_label: 'Este texto va en una sola línea',
    });
    expect(new Set(result.issues.map((i) => i.reason))).toEqual(new Set(['option', 'text']));
  });
});

describe('validateChatDesign: contraste (FR-019, FR-020)', () => {
  const cases: Array<[string, Record<string, string>, string, string]> = [
    // [pareja, colores, campo marcado, inicio del mensaje]
    ['texto sobre el principal', { on_primary_color: '#3b6fc4' }, 'on_primary_color', 'El texto sobre el color principal'],
    ['texto sobre el fondo', { text_color: '#aaaaaa' }, 'text_color', 'El texto del chat sobre el fondo'],
    ['texto sobre los mensajes del bot', { bot_bubble_color: '#4a5060', primary_color: '#0b3d91' }, 'bot_bubble_color', 'El texto sobre los mensajes del bot'],
    ['principal sobre el fondo', { primary_color: '#ff8800' }, 'primary_color', 'El color principal frente al fondo del chat'],
  ];

  it.each(cases)('rechaza la pareja %s con su razón y el mínimo', (_name, colors, field, start) => {
    const result = validateChatDesign({ ...FORM, ...colors });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.errors[field] ?? '';
    expect(message).toContain(start);
    expect(message).toMatch(/tiene un contraste de \d+,\d{2}:1; el mínimo es 4,5:1/);
    expect(result.issues.every((i) => i.reason === 'contrast')).toBe(true);
  });

  it('el principal frente a los mensajes del bot se marca en el principal', () => {
    // Fondo blanco (cumple) y burbuja del bot casi del color principal.
    const result = validateChatDesign({ ...FORM, bot_bubble_color: '#c9d8f0', text_color: '#000000' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.primary_color).toContain(
      'El color principal frente a los mensajes del bot tiene un contraste de',
    );
  });

  it('el texto sobre el fondo se marca en los dos controles', () => {
    const result = validateChatDesign({ ...FORM, text_color: '#aaaaaa' });
    if (result.ok) throw new Error('debería fallar');
    expect(result.errors.background_color).toContain('El texto del chat sobre el fondo');
  });

  it('devuelve a la vez los errores de contraste y los de texto', () => {
    const result = validateChatDesign({ ...FORM, text_color: '#aaaaaa', chat_name: 'x'.repeat(41) });
    if (result.ok) throw new Error('debería fallar');
    expect(result.errors.text_color).toContain('contraste');
    expect(result.errors.chat_name).toBe('Máximo 40 caracteres');
    expect(new Set(result.issues.map((i) => i.reason))).toEqual(new Set(['contrast', 'text']));
  });

  it('la paleta original y una paleta propia legible se aceptan', () => {
    expect(validateChatDesign(FORM).ok).toBe(true);
    expect(
      validateChatDesign({
        ...FORM,
        primary_color: '#0b6e4f',
        bot_bubble_color: '#eef6f2',
      }).ok,
    ).toBe(true);
  });
});
