/**
 * Clasificación del veredicto de la credencial (017, R5, contracts/credential-verification.md §1).
 *
 * La distinción que sostiene toda la feature: **«rechazada» y «no concluyente» no son lo mismo**.
 * Solo un 401 o un 403 son un veredicto sobre la credencial; un 500, un fallo de red o un plazo
 * agotado son la **ausencia** de veredicto, y confundirlos dejaría una instancia degradada porque
 * el proveedor tuvo un mal rato (FR-030, FR-030a).
 *
 * Ningún test de este fichero hace red ni lee una credencial real: `fetch` se inyecta (FR-038).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCredentialWatcher,
  CREDENTIAL_PROBE_TIMEOUT_MS,
  CREDENTIAL_RETRY_INTERVAL_MS,
  verifyCredential,
  type CredentialVerdict,
} from '../../../src/llm/credential-probe.js';
import { LLM_PROVIDERS, type LlmProvider } from '../../../src/llm/provider.js';

/** Credencial de pruebas: ninguna es real, y ninguna puede aparecer en ninguna salida. */
const CLAVE = 'sk-ant-secreto-que-no-puede-salir-en-ningun-sitio';

/** `fetch` doble que además guarda sus llamadas. */
type FetchDoble = typeof globalThis.fetch & { mock: { calls: unknown[][] } };

function respondeCon(status: number): FetchDoble {
  // Un 204 no admite cuerpo: `Response` lanza si se le da uno.
  const body = status === 204 || status === 205 || status === 304 ? null : '{}';
  return vi.fn(async () => new Response(body, { status }));
}

function falla(error: Error): FetchDoble {
  return vi.fn(async () => {
    throw error;
  });
}

/** Dirección y opciones de la primera petición del doble. */
const primeraPeticion = (f: FetchDoble): [string, RequestInit] =>
  f.mock.calls[0] as [string, RequestInit];

const veredicto = (
  provider: LlmProvider,
  fetchImpl: typeof globalThis.fetch,
): Promise<CredentialVerdict> => verifyCredential(provider, CLAVE, { fetch: fetchImpl });

describe.each(LLM_PROVIDERS)('verifyCredential con %s', (provider) => {
  it.each([200, 201, 204])('un %i es accepted', async (status) => {
    expect(await veredicto(provider, respondeCon(status))).toBe('accepted');
  });

  it.each([401, 403])('un %i es rejected', async (status) => {
    expect(await veredicto(provider, respondeCon(status))).toBe('rejected');
  });

  it.each([429, 500, 502, 503, 404, 400])('un %i es inconclusive', async (status) => {
    expect(await veredicto(provider, respondeCon(status))).toBe('inconclusive');
  });

  it('un fallo de red es inconclusive', async () => {
    expect(await veredicto(provider, falla(new TypeError('fetch failed')))).toBe('inconclusive');
  });

  it('un fallo de DNS es inconclusive', async () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect(await veredicto(provider, falla(dns))).toBe('inconclusive');
  });

  it('un plazo agotado es inconclusive', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(await veredicto(provider, falla(abort))).toBe('inconclusive');
  });

  it('pide el listado de modelos con GET y lleva la credencial en su cabecera', async () => {
    const fetchImpl = respondeCon(200);
    await veredicto(provider, fetchImpl);
    const [url, init] = primeraPeticion(fetchImpl);
    expect(url).toMatch(/^https:\/\//);
    expect(url).toContain('models');
    expect(init.method).toBe('GET');
    // La credencial va en alguna cabecera, y en ninguna otra parte: nunca en la dirección.
    const cabeceras = JSON.stringify(init.headers);
    expect(cabeceras).toContain(CLAVE);
    expect(url).not.toContain(CLAVE);
    // Sin cuerpo: una petición de listado no genera tokens (FR-031).
    expect(init.body).toBeUndefined();
  });

  it('no devuelve ni registra ningún carácter de la credencial (FR-032)', async () => {
    const lineas: unknown[] = [];
    const resultado = await verifyCredential(provider, CLAVE, {
      fetch: respondeCon(401),
      log: (mensaje) => lineas.push(mensaje),
    });
    expect(resultado).toBe('rejected');
    const todo = JSON.stringify({ resultado, lineas });
    expect(todo).not.toContain(CLAVE);
    expect(todo).not.toContain('secreto');
  });
});

describe('plazo y aborto', () => {
  it('el plazo por defecto es de 5 s', () => {
    expect(CREDENTIAL_PROBE_TIMEOUT_MS).toBe(5_000);
  });

  it('la cadencia del reintento es de 5 min (R6)', () => {
    expect(CREDENTIAL_RETRY_INTERVAL_MS).toBe(5 * 60_000);
  });

  it('pasa una señal de aborto a fetch', async () => {
    const fetchImpl = respondeCon(200);
    await verifyCredential('anthropic', CLAVE, { fetch: fetchImpl });
    const [, init] = primeraPeticion(fetchImpl);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('una señal ya abortada da inconclusive, no rejected', async () => {
    const controller = new AbortController();
    controller.abort();
    const resultado = await verifyCredential('anthropic', CLAVE, {
      fetch: respondeCon(200),
      signal: controller.signal,
    });
    expect(resultado).toBe('inconclusive');
  });

  it('una credencial vacía da inconclusive sin pedir nada', async () => {
    const fetchImpl = respondeCon(200);
    expect(await verifyCredential('anthropic', '  ', { fetch: fetchImpl })).toBe('inconclusive');
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });
});

describe('cabeceras propias de cada proveedor (R5)', () => {
  async function cabecerasDe(provider: LlmProvider): Promise<Record<string, string>> {
    const fetchImpl = respondeCon(200);
    await veredicto(provider, fetchImpl);
    return primeraPeticion(fetchImpl)[1].headers as Record<string, string>;
  }

  it('Anthropic usa x-api-key y declara la versión de su API', async () => {
    const h = await cabecerasDe('anthropic');
    expect(h['x-api-key']).toBe(CLAVE);
    expect(h['anthropic-version']).toBeTruthy();
  });

  it('OpenAI usa Authorization: Bearer', async () => {
    const h = await cabecerasDe('openai');
    expect(h.Authorization).toBe(`Bearer ${CLAVE}`);
  });

  it('Gemini usa x-goog-api-key', async () => {
    const h = await cabecerasDe('gemini');
    expect(h['x-goog-api-key']).toBe(CLAVE);
  });
});

describe('vigilante de dos estados (R6)', () => {
  /** Vigilante con una verificación guionizada, sin red. */
  function vigilante(...veredictos: CredentialVerdict[]) {
    const lineas: string[] = [];
    const pedidos: number[] = [];
    let i = 0;
    const watcher = createCredentialWatcher({
      provider: 'anthropic',
      apiKey: CLAVE,
      retryIntervalMs: 50,
      log: (m) => lineas.push(m),
      verify: async () => {
        pedidos.push(i);
        return veredictos[Math.min(i++, veredictos.length - 1)] ?? 'inconclusive';
      },
    });
    return { watcher, lineas, pedidos };
  }

  it('arranca en ok: la ausencia de veredicto no degrada nada', () => {
    const { watcher } = vigilante('inconclusive');
    expect(watcher.state()).toBe('ok');
    watcher.close();
  });

  it('una credencial rechazada degrada, con UNA sola línea', async () => {
    const { watcher, lineas } = vigilante('rejected');
    expect(await watcher.check()).toBe('rejected');
    expect(watcher.state()).toBe('rejected');
    expect(lineas).toHaveLength(1);
    // Comprobar de nuevo mientras sigue rechazada no añade líneas: ni una por reintento.
    await watcher.check();
    await watcher.check();
    expect(watcher.state()).toBe('rejected');
    expect(lineas).toHaveLength(1);
    watcher.close();
  });

  it('sale del degradado sola, con UNA línea al salir (SC-010)', async () => {
    const { watcher, lineas } = vigilante('rejected', 'accepted');
    await watcher.check();
    expect(watcher.state()).toBe('rejected');
    await watcher.check();
    expect(watcher.state()).toBe('ok');
    expect(lineas).toHaveLength(2);
    watcher.close();
  });

  // Lo que esto protege: que un mal rato del proveedor saque a una instancia de un degradado que
  // sí tenía veredicto, y los clientes vuelvan a hablar con un bot que no puede responder.
  it('un inconclusive no saca del degradado', async () => {
    const { watcher, lineas } = vigilante('rejected', 'inconclusive');
    await watcher.check();
    await watcher.check();
    expect(watcher.state()).toBe('rejected');
    expect(lineas).toHaveLength(1);
    watcher.close();
  });

  it('un inconclusive tampoco mete en degradado', async () => {
    const { watcher, lineas } = vigilante('inconclusive');
    await watcher.check();
    expect(watcher.state()).toBe('ok');
    expect(lineas).toHaveLength(0);
    watcher.close();
  });

  it('reintenta solo mientras está rechazada', async () => {
    const { watcher, pedidos } = vigilante('rejected');
    await watcher.check();
    const antes = pedidos.length;
    await new Promise((r) => setTimeout(r, 180));
    expect(pedidos.length).toBeGreaterThan(antes);
    watcher.close();
  });

  it('cerrado no reintenta ni cambia de estado', async () => {
    const { watcher, pedidos } = vigilante('rejected');
    watcher.close();
    await watcher.check();
    expect(pedidos).toHaveLength(0);
    expect(watcher.state()).toBe('ok');
  });

  it('una verificación que lanza no tumba el proceso: queda en inconclusive', async () => {
    const watcher = createCredentialWatcher({
      provider: 'anthropic',
      apiKey: CLAVE,
      verify: async () => {
        throw new Error('fallo inesperado');
      },
    });
    expect(await watcher.check()).toBe('inconclusive');
    expect(watcher.state()).toBe('ok');
    watcher.close();
  });

  it('ninguna línea del vigilante lleva la credencial (FR-032)', async () => {
    const { watcher, lineas } = vigilante('rejected', 'accepted');
    await watcher.check();
    await watcher.check();
    expect(lineas).toHaveLength(2);
    for (const linea of lineas) {
      expect(linea).not.toContain(CLAVE);
      expect(linea).not.toContain('secreto');
    }
    // Sí nombra la variable, que es lo que el operador necesita para saber qué arreglar.
    expect(lineas[0]).toContain('ANTHROPIC_API_KEY');
    watcher.close();
  });
});
