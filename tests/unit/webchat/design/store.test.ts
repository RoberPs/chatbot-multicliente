/**
 * Lectura tolerante del diseño guardado (011, R13): cada campo se interpreta por separado; un
 * valor que ya no se admite toma el original y se anota en `unsupported`.
 */
import { describe, expect, it } from 'vitest';
import { ORIGINAL_DESIGN } from '../../../../src/webchat/design/defaults.js';
import { resolveChatDesign, type ChatDesignRow } from '../../../../src/webchat/design/store.js';

const row = (over: Partial<ChatDesignRow> = {}): ChatDesignRow => ({
  id: 1,
  primaryColor: '#0b6e4f',
  onPrimaryColor: '#ffffff',
  backgroundColor: '#ffffff',
  textColor: '#1d2330',
  botBubbleColor: '#eef6f2',
  shape: 'soft',
  position: 'left',
  size: 'large',
  chatName: 'Atención al cliente',
  welcomeText: 'Hola\nTe respondo al momento.',
  placeholderText: null,
  sendLabel: 'Mandar',
  updatedAt: '2026-10-02 10:00:00+00',
  ...over,
});

describe('resolveChatDesign', () => {
  it('sin fila: el aspecto original y saved = false', () => {
    const resolved = resolveChatDesign(null);
    expect(resolved).toEqual({
      saved: false,
      options: ORIGINAL_DESIGN,
      images: {},
      unsupported: [],
    });
  });

  it('con una fila válida: lo guardado, sin campos no admitidos', () => {
    const resolved = resolveChatDesign(row());
    expect(resolved.saved).toBe(true);
    expect(resolved.unsupported).toEqual([]);
    expect(resolved.options).toMatchObject({
      primaryColor: '#0b6e4f',
      shape: 'soft',
      position: 'left',
      size: 'large',
      chatName: 'Atención al cliente',
      welcomeText: 'Hola\nTe respondo al momento.',
      placeholder: null,
      sendLabel: 'Mandar',
    });
  });

  it('cada valor que ya no vale toma el original y se anota; el resto se aplica', () => {
    const resolved = resolveChatDesign(
      row({
        primaryColor: 'verde',
        shape: 'hexagonal',
        size: 'huge',
        position: 'center',
        chatName: 'x'.repeat(41),
      }),
    );
    expect(resolved.options.primaryColor).toBe(ORIGINAL_DESIGN.primaryColor);
    expect(resolved.options.shape).toBe('round');
    expect(resolved.options.size).toBe('medium');
    expect(resolved.options.position).toBe('right');
    expect(resolved.options.chatName).toBeNull();
    expect(resolved.unsupported.sort()).toEqual(
      ['chatName', 'position', 'primaryColor', 'shape', 'size'].sort(),
    );
    // Lo que sí vale se aplica.
    expect(resolved.options.botBubbleColor).toBe('#eef6f2');
    expect(resolved.options.sendLabel).toBe('Mandar');
  });
});

describe('resolveChatDesign: contraste de lo guardado (R13)', () => {
  it('si alguna pareja ya no cumple, toda la paleta vuelve a la original', () => {
    const resolved = resolveChatDesign(row({ textColor: '#aaaaaa', shape: 'soft' }));
    expect(resolved.options.primaryColor).toBe(ORIGINAL_DESIGN.primaryColor);
    expect(resolved.options.botBubbleColor).toBe(ORIGINAL_DESIGN.botBubbleColor);
    expect(resolved.options.textColor).toBe(ORIGINAL_DESIGN.textColor);
    expect(resolved.unsupported).toContain('palette');
    // El resto del diseño se aplica.
    expect(resolved.options.shape).toBe('soft');
  });
});
