/**
 * Validación de opciones y textos del diseño (011, data-model §3, research R14).
 */
import { describe, expect, it } from 'vitest';
import { ORIGINAL_DESIGN } from '../../../../src/webchat/design/defaults.js';
import {
  hexColor,
  textSchema,
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
