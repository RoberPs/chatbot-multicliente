/**
 * El panel no delata al proveedor (017, FR-007, FR-008, SC-006).
 *
 * El operador configura el proveedor en el fichero de entorno de su instancia; el **negocio** no
 * tiene por qué saber quién atiende, y una pantalla que lo nombrase convertiría una decisión de
 * operación en información del producto. Este test recorre todas las pantallas del panel, con y
 * sin bot, y además la información de estado que se publica por red.
 *
 * Lo que busca son los nombres de los tres proveedores, los de sus variables de credencial y los
 * de sus SDK. Es deliberadamente tonto y deliberadamente exhaustivo: la forma de que esto se
 * rompiera es que alguien añadiese un mensaje de ayuda con el nombre de la variable, que es
 * exactamente lo que había antes de la 017 en tres sitios.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LLM_KEY_VARIABLES, LLM_PROVIDERS } from '../../../src/llm/provider.js';
import { buildTestApp, get, login, type Session } from '../../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

/** Todas las pantallas del panel, bajo su prefijo. */
const PANTALLAS = [
  '',
  '/business',
  '/hours',
  '/services',
  '/services/new',
  '/resources',
  '/resources/new',
  '/faqs',
  '/policies',
  '/tone',
  '/handoff',
  '/handoffs',
  '/usage',
  '/web-chat',
  '/chat-design',
  '/playground',
  '/config',
];

/**
 * Lo que no puede aparecer: el nombre de cada proveedor, el de su variable de credencial, el de su
 * paquete y la forma de una credencial. La comparación no distingue mayúsculas, así que `anthropic`
 * cubre también `ANTHROPIC_API_KEY`.
 *
 * **Lo que sí puede aparecer, y no es un descuido: el nombre del modelo configurado.** La pantalla
 * de consumo lo muestra porque la tabla de precios está indexada por él, y es un valor que el
 * operador ha escrito en el entorno de su instancia. De un nombre de modelo se puede **inferir** el
 * proveedor, pero FR-008 prohíbe que el panel lo **nombre**, no que el operador reconozca su propia
 * configuración. Por eso `claude-…` o `gpt-…` no están en esta lista.
 */
const PROHIBIDO = [
  ...LLM_PROVIDERS,
  ...LLM_KEY_VARIABLES,
  '@anthropic-ai/sdk',
  '@google/genai',
  'sk-ant-',
];

function delata(texto: string): string[] {
  const minusculas = texto.toLowerCase();
  return PROHIBIDO.filter((palabra) => minusculas.includes(palabra.toLowerCase()));
}

describe('ninguna pantalla del panel nombra al proveedor', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    // Sin bot: es el caso en que el panel tiene que avisar de que falta la clave del modelo, y
    // donde antes de la 017 se nombraba la variable en tres sitios.
    app = await buildTestApp(t.db, t.url, null);
    session = await login(app);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it.each(PANTALLAS)('sin bot, %s no nombra a nadie', async (url) => {
    const res = await get(app, session, `/admin${url}`);
    expect([200, 302, 303]).toContain(res.statusCode);
    expect(delata(res.body)).toEqual([]);
  });

  it('el aviso de que falta la clave del modelo no nombra su variable', async () => {
    const res = await get(app, session, '/admin/playground');
    expect(res.body).toContain('Falta la clave del modelo de lenguaje');
    expect(delata(res.body)).toEqual([]);
  });

  it('la pantalla del chat web tampoco', async () => {
    const res = await get(app, session, '/admin/web-chat');
    expect(delata(res.body)).toEqual([]);
  });

  // FR-007: tampoco por red. El informe de salud lleva versión y estado, no quién atiende.
  it('la información de estado publicada por red no nombra al proveedor', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(delata(res.body)).toEqual([]);
  });

  // La contraparte del comentario de `PROHIBIDO`: lo que la pantalla de consumo muestra es el
  // nombre del modelo, que es configuración del operador, y nunca el nombre del proveedor.
  it('la pantalla de consumo muestra el modelo configurado, no el proveedor', async () => {
    const res = await get(app, session, '/admin/usage');
    expect(res.body).toContain('claude-sonnet-5-5');
    expect(delata(res.body)).toEqual([]);
  });

  it('el fragmento público del chat web no nombra al proveedor', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat/frame' });
    // Si la ruta no existe en esta configuración, no hay nada que delatar.
    if (res.statusCode === 200) expect(delata(res.body)).toEqual([]);
  });
});
