/**
 * La interfaz del chat ante un fallo que no entiende (016, T033; FR-009, FR-013, SC-005).
 *
 * El defecto: `frame.js` pintaba «escribiendo…» antes de enviar y solo lo retiraba cuando la
 * respuesta encajaba en alguno de los casos que conocía (202, 400, 401, 429, `unavailable`).
 * Ante un 500, un 502 del proxy o un cuerpo que no es JSON no encajaba en ninguno y el chat se
 * quedaba **«escribiendo…» para siempre**, sin mensaje y sin salida: el peor resultado posible
 * para el cliente final, y un incumplimiento del Principio V.
 *
 * Se ejecuta el script real sobre un DOM mínimo hecho a mano, como en `web-widget.test.ts`: es
 * un script de navegador, no un módulo.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../../../src/channels/web/assets/frame.js', import.meta.url)),
  'utf8',
);

const PAGE_CONTACT = 'Si necesitas hablar con una persona: teléfono +34 911 22 33 44.';

interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  children: FakeNode[];
  value: string;
  scrollTop: number;
  scrollHeight: number;
  dataset: Record<string, string>;
  appendChild(child: FakeNode): void;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
  focus(): void;
  scrollIntoView(): void;
}

interface Reply {
  status: number;
  /** Cuerpo JSON, o `null` para simular un cuerpo que no es JSON (un 502 del proxy). */
  body: unknown;
  headers?: Record<string, string>;
}

/** Monta el DOM mínimo, ejecuta `frame.js` y devuelve los mandos del test. */
function runFrame({
  contact = PAGE_CONTACT,
  replies = {},
}: { contact?: string | null; replies?: Record<string, Reply[]> } = {}) {
  const nodes = new Map<string, FakeNode>();
  const handlers = new Map<string, Array<(event: unknown) => void>>();

  const node = (tagName: string): FakeNode => ({
    tagName,
    className: '',
    textContent: '',
    hidden: false,
    children: [],
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    dataset: {},
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(type, handler) {
      const key = `${tagName}:${type}`;
      handlers.set(key, [...(handlers.get(key) ?? []), handler]);
    },
    removeAttribute: () => undefined,
    setAttribute: () => undefined,
    focus: () => undefined,
    scrollIntoView: () => undefined,
  });

  for (const id of [
    'chat-toggle',
    'chat-panel',
    'chat-close',
    'chat-messages',
    'chat-status',
    'chat-form',
    'chat-text',
    'chat-handoff',
  ]) {
    nodes.set(id, node(id));
  }

  const html = node('html');
  if (contact !== null) html.dataset.contact = contact;

  const calls: Array<{ method: string; path: string }> = [];
  const queue: Record<string, Reply[]> = { ...replies };

  const fetchImpl = (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^.*\/chat\/api/, '');
    calls.push({ method, path });
    const key = `${method} ${path.split('?')[0] ?? ''}`;
    const reply: Reply = queue[key]?.shift() ?? { status: 200, body: {} };
    return Promise.resolve({
      status: reply.status,
      headers: { get: (name: string) => reply.headers?.[name] ?? null },
      json: () =>
        reply.body === null
          ? Promise.reject(new Error('no es JSON'))
          : Promise.resolve(reply.body),
    });
  };

  const context = {
    document: {
      documentElement: html,
      getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: (tagName: string) => node(tagName),
      querySelectorAll: () => [],
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        const key = `document:${type}`;
        handlers.set(key, [...(handlers.get(key) ?? []), handler]);
      },
    },
    window: {
      fetch: fetchImpl,
      crypto: { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
      setInterval: () => 1,
      clearInterval: () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      location: { origin: 'http://localhost', pathname: '/chat/frame' },
      // El iframe avisa a la web que lo aloja; aquí solo hace falta que no estalle.
      parent: { postMessage: () => undefined },
      postMessage: () => undefined,
      sessionStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
    console: { error: () => undefined, warn: () => undefined, log: () => undefined },
  };
  (context.window as { self?: unknown }).self = context.window;

  runInNewContext(source, context);

  const status = nodes.get('chat-status');
  const list = nodes.get('chat-messages');
  const form = nodes.get('chat-form');
  const box = nodes.get('chat-text');

  return {
    calls,
    statusText: () => status?.textContent ?? '',
    notices: () => (list?.children ?? []).map((c) => c.textContent),
    formHidden: () => form?.hidden ?? false,
    /** Escribe un mensaje y lo envía, como haría el visitante. */
    submit: async (text: string) => {
      if (box) box.value = text;
      const submitHandlers = handlers.get('chat-form:submit') ?? [];
      for (const handler of submitHandlers) handler({ preventDefault: () => undefined });
      // Deja correr las promesas de `fetch`.
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    open: async () => {
      for (const handler of handlers.get('chat-toggle:click') ?? []) handler({});
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

const session = (): Record<string, Reply[]> => ({
  'POST /session': [{ status: 201, body: { token: 'tok', maxLength: 1000 } }],
  'GET /messages': [{ status: 200, body: { messages: [], cursor: null, waiting: false } }],
  'GET /state': [{ status: 200, body: { contact: null } }],
});

describe('frame.js ante un fallo que no entiende (FR-009)', () => {
  const unknownFailures: Array<[string, Reply]> = [
    ['500 del servidor', { status: 500, body: { error: 'server' } }],
    ['502 del proxy, sin JSON', { status: 502, body: null }],
    ['200 con un cuerpo que no es JSON', { status: 200, body: null }],
    ['503 sin el bloque unavailable', { status: 503, body: { error: 'busy' } }],
  ];

  it.each(unknownFailures)('%s: deja de indicar espera y ofrece contacto', async (_name, reply) => {
    const frame = runFrame({ replies: { ...session(), 'POST /messages': [reply] } });
    await frame.open();
    await frame.submit('hola');

    // Lo que fallaba: el «escribiendo…» se queda para siempre.
    expect(frame.statusText()).not.toContain('escribiendo');
    expect(frame.statusText()).toBe('');
    // Y el aviso con el contacto **de la página**, sin pedir nada al servidor.
    const notices = frame.notices().join(' | ');
    expect(notices).toContain('Ahora mismo no puedo responder');
    expect(notices).toContain(PAGE_CONTACT);
  });

  it('no esconde el formulario: se puede volver a escribir y la conversación sigue', async () => {
    const frame = runFrame({
      replies: {
        ...session(),
        'POST /messages': [
          { status: 500, body: { error: 'server' } },
          { status: 202, body: {} },
        ],
        'GET /messages': [
          { status: 200, body: { messages: [], cursor: null, waiting: false } },
          { status: 200, body: { messages: [], cursor: null, waiting: false } },
        ],
      },
    });
    await frame.open();
    await frame.submit('hola');
    expect(frame.formHidden()).toBe(false);

    // Segundo envío, ya con el servicio en pie: se acepta.
    await frame.submit('hola otra vez');
    expect(frame.calls.filter((c) => c.method === 'POST' && c.path === '/messages')).toHaveLength(2);
  });

  it('el aviso no se repite en bucle', async () => {
    const frame = runFrame({
      replies: {
        ...session(),
        'POST /messages': [
          { status: 500, body: { error: 'server' } },
          { status: 500, body: { error: 'server' } },
          { status: 500, body: { error: 'server' } },
        ],
      },
    });
    await frame.open();
    await frame.submit('uno');
    await frame.submit('dos');
    await frame.submit('tres');
    const repeated = frame.notices().filter((t) => t.includes('Ahora mismo no puedo responder'));
    expect(repeated).toHaveLength(1);
  });

  it('sin contacto en la página avisa igual, solo sin teléfono (FR-013)', async () => {
    const frame = runFrame({
      contact: null,
      replies: { ...session(), 'POST /messages': [{ status: 500, body: { error: 'server' } }] },
    });
    await frame.open();
    await frame.submit('hola');
    expect(frame.statusText()).toBe('');
    expect(frame.notices().join(' | ')).toContain('Ahora mismo no puedo responder');
  });
});

describe('los casos que ya conocía se comportan igual que antes', () => {
  it('202 arranca la espera, no el aviso', async () => {
    const frame = runFrame({
      replies: { ...session(), 'POST /messages': [{ status: 202, body: {} }] },
    });
    await frame.open();
    await frame.submit('hola');
    expect(frame.notices().join(' | ')).not.toContain('Ahora mismo no puedo responder');
  });

  it('400 explica el tamaño del mensaje', async () => {
    const frame = runFrame({
      replies: { ...session(), 'POST /messages': [{ status: 400, body: { error: 'body' } }] },
    });
    await frame.open();
    await frame.submit('hola');
    expect(frame.statusText()).toContain('caracteres');
    expect(frame.notices().join(' | ')).not.toContain('Ahora mismo no puedo responder');
  });

  it('429 avisa del límite con el contacto de la respuesta', async () => {
    const frame = runFrame({
      replies: {
        ...session(),
        'POST /messages': [
          {
            status: 429,
            body: { unavailable: { message: 'Demasiados mensajes.', contact: 'Llama al 900.' } },
            headers: { 'retry-after': '60' },
          },
        ],
      },
    });
    await frame.open();
    await frame.submit('hola');
    const notices = frame.notices().join(' | ');
    expect(notices).toContain('Demasiados mensajes.');
    expect(notices).toContain('Llama al 900.');
  });

  it('503 con unavailable esconde el formulario, como antes', async () => {
    const frame = runFrame({
      replies: {
        ...session(),
        'POST /messages': [
          {
            status: 503,
            body: { unavailable: { message: 'No disponible.', contact: 'Llama al 900.' } },
          },
        ],
      },
    });
    await frame.open();
    await frame.submit('hola');
    expect(frame.formHidden()).toBe(true);
    expect(frame.notices().join(' | ')).toContain('No disponible.');
  });
});
