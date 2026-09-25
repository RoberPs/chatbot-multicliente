/**
 * Comportamiento del fragmento que el negocio pega en su web (004, T051).
 *
 * Lo importante: el iframe se inserta invisible y solo se muestra cuando el propio chat se
 * anuncia. Si el navegador bloquea el marco porque la web no está permitida, nunca llega ese
 * mensaje y el visitante no ve ni el recuadro de marco bloqueado.
 *
 * Se ejecuta el script real sobre un DOM mínimo hecho a mano: es un script de navegador, no un
 * módulo, y así no hace falta ninguna dependencia nueva.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../../../src/channels/web/assets/widget.js', import.meta.url)),
  'utf8',
);

const INSTANCE = 'https://instancia.example';

interface FakeElement {
  tagName: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  src?: string;
  title?: string;
  contentWindow: object;
  setAttribute(name: string, value: string): void;
}

type MessageHandler = (event: {
  origin: string;
  source: unknown;
  data: unknown;
}) => void;

/** DOM mínimo con lo que usa el fragmento. */
function runWidget(scriptSrc = `${INSTANCE}/chat/widget.js`) {
  const appended: FakeElement[] = [];
  const messageHandlers: MessageHandler[] = [];

  const createElement = (tagName: string): FakeElement => ({
    tagName,
    style: {},
    attributes: {},
    contentWindow: { id: 'frame-window' },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  });

  const document = {
    currentScript: { src: scriptSrc },
    readyState: 'complete',
    createElement,
    body: {
      appendChild: (element: FakeElement) => appended.push(element),
    },
    addEventListener: () => undefined,
  };

  const window = {
    addEventListener: (type: string, handler: MessageHandler) => {
      if (type === 'message') messageHandlers.push(handler);
    },
  };

  // El script es un IIFE de navegador: se ejecuta en un contexto con solo lo que necesita.
  runInNewContext(source, { window, document, URL });

  const frame = appended[0];
  const send = (data: unknown, over: { origin?: string; source?: unknown } = {}) => {
    for (const handler of messageHandlers) {
      handler({
        origin: over.origin ?? INSTANCE,
        source: 'source' in over ? over.source : frame?.contentWindow,
        data,
      });
    }
  };
  return { frame, appended, send };
}

describe('widget.js del chat web', () => {
  let widget: ReturnType<typeof runWidget>;

  beforeEach(() => {
    widget = runWidget();
  });

  it('inserta un iframe del chat de la instancia, fijo abajo a la derecha', () => {
    expect(widget.appended).toHaveLength(1);
    expect(widget.frame?.tagName).toBe('iframe');
    expect(widget.frame?.src).toBe(`${INSTANCE}/chat/frame`);
    expect(widget.frame?.title).toBe('Chat con el asistente');
    expect(widget.frame?.attributes.allow).toBe('');
    expect(widget.frame?.style.position).toBe('fixed');
  });

  it('el iframe empieza invisible y en tamaño cerrado', () => {
    expect(widget.frame?.style.visibility).toBe('hidden');
    expect(widget.frame?.style.width).toBe('72px');
    expect(widget.frame?.style.height).toBe('72px');
  });

  it('se muestra cuando el chat se anuncia con chat:resize', () => {
    widget.send({ type: 'chat:resize', open: false });
    expect(widget.frame?.style.visibility).toBe('visible');
    expect(widget.frame?.style.width).toBe('72px');

    widget.send({ type: 'chat:resize', open: true });
    expect(widget.frame?.style.width).toBe('380px');
    expect(widget.frame?.style.height).toBe('560px');
  });

  it('sigue invisible si el chat no se anuncia: marco bloqueado o mensajes ajenos', () => {
    // Otro origen (una web que intenta manejar el chat desde fuera).
    widget.send({ type: 'chat:resize', open: true }, { origin: 'https://atacante.example' });
    // El origen correcto pero otra ventana (otro iframe de la página).
    widget.send({ type: 'chat:resize', open: true }, { source: { id: 'otra-ventana' } });
    // Un mensaje del chat que no es del protocolo.
    widget.send({ type: 'otra-cosa', open: true });
    widget.send(null);

    expect(widget.frame?.style.visibility).toBe('hidden');
    expect(widget.frame?.style.width).toBe('72px');
  });

  it('sin script identificable no toca la página', () => {
    const sinSrc = runWidget('no-es-una-url');
    expect(sinSrc.appended).toEqual([]);
  });
});
