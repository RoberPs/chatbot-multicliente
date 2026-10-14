/**
 * Ninguna credencial, ni entera ni parcial, sale en ningún mensaje ni en ninguna línea de registro
 * (017, FR-032, SC-004).
 *
 * Los demás tests comprueban que la comprobación **acierta**; este comprueba lo que pasa cuando
 * acierta: el operador recibe un mensaje que nombra la **variable** y el proveedor, nunca el valor.
 * Es la clase de fallo que no se ve en la pantalla —el valor aparece en un registro, en un volcado
 * de `--json`, en un ticket de soporte— y por eso tiene prueba propia.
 *
 * Qué se busca: la credencial entera **y** cualquier trozo suyo de 6 caracteres. Seis porque una
 * coincidencia casual de seis caracteres en un texto en español es improbable, y porque un trozo
 * de seis ya es material útil para quien busque la clave en un registro.
 *
 * Ni red ni credenciales reales (FR-038): el `fetch` va inyectado y las claves son aleatorias.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createCredentialWatcher,
  verifyCredential,
  type CredentialVerdict,
} from '../../../src/llm/credential-probe.js';
import { LLM_PROVIDERS, keyVariableOf, type LlmProvider } from '../../../src/llm/provider.js';
import {
  checkResultJson,
  formatCheckResult,
  validate,
  type CheckResult,
} from '../../../src/provisioning/check.js';
import type { EnvMap } from '../../../src/provisioning/env-file.js';
import { createInventory, type InventoryAccess } from '../../../src/provisioning/inventory.js';
import {
  instanceFromEnv,
  productionEnv,
  TEST_INVENTORY_KEY,
  TODAY,
  whatsappVars,
} from '../../helpers/provisioning.js';

/** Trozo mínimo que se considera una filtración. */
const CHUNK = 6;

/**
 * Trozos de `secret` presentes en `text`. Devuelve **cuántos**, no cuáles: el mensaje de un test
 * que falla no puede filtrar lo que el test vigila.
 */
function leaks(text: string, secret: string): number {
  if (secret.length < CHUNK) return text.includes(secret) ? 1 : 0;
  let found = 0;
  for (let i = 0; i + CHUNK <= secret.length; i += 1) {
    if (text.includes(secret.slice(i, i + CHUNK))) found += 1;
  }
  return found;
}

function expectNoLeak(text: string, secrets: string[]): void {
  const total = secrets.reduce((sum, s) => sum + leaks(text, s), 0);
  expect(total, 'hay trozos de alguna credencial en el texto').toBe(0);
}

/** Credenciales con la forma real de cada proveedor y cuerpo aleatorio y largo. */
const body = () => randomBytes(30).toString('hex');
const keys: Record<LlmProvider, string> = {
  anthropic: `sk-ant-api03-${body()}`,
  gemini: `AIza${body()}`,
  openai: `sk-proj-${body()}`,
};
const allKeys = Object.values(keys);

const inventory = createInventory(TEST_INVENTORY_KEY, TODAY);
const access: InventoryAccess = {
  kind: 'ok',
  path: '/inv/inventory.json',
  inventory,
  key: TEST_INVENTORY_KEY,
};

/** Entorno de producción completo con el proveedor y las credenciales que se le indiquen. */
function env(provider: LlmProvider, present: Partial<Record<LlmProvider, string>>): EnvMap {
  const vars: EnvMap = {};
  for (const [p, key] of Object.entries(present)) {
    vars[keyVariableOf(p as LlmProvider)] = key;
  }
  return productionEnv('demo-secreto', {
    ...whatsappVars(),
    LLM_PROVIDER: provider,
    ...(provider === 'anthropic' ? {} : { LLM_MODEL: 'modelo-del-proveedor' }),
    // `productionEnv` pone siempre la de Anthropic: aquí manda lo que diga el caso.
    ANTHROPIC_API_KEY: '',
    ...vars,
  });
}

const text = (result: CheckResult) =>
  `${checkResultJson(result)}\n${formatCheckResult(result)}\n${JSON.stringify(result)}`;

describe('la comprobación previa no filtra ninguna credencial', () => {
  // El caso que la feature existe para cerrar: la credencial de otro proveedor. El mensaje tiene
  // que decir **de quién parece ser** la clave sin decir cuál es.
  it.each([
    ['anthropic', 'gemini'],
    ['anthropic', 'openai'],
    ['gemini', 'anthropic'],
    ['openai', 'anthropic'],
  ] as const)('credencial de %s puesta en la variable de %s', (declared, wrong) => {
    const result = validate(env(declared, { [declared]: keys[wrong] }), access);
    expect(result.errors.map((e) => e.code)).toContain('llm_key_other_provider');
    expectNoLeak(text(result), allKeys);
  });

  it('con las tres credenciales presentes, el aviso de las no usadas no muestra ninguna', () => {
    const result = validate(env('gemini', keys), access);
    expect(result.warnings.map((w) => w.code)).toContain('llm_key_unused');
    expectNoLeak(text(result), allKeys);
  });

  it.each(['rejected', 'inconclusive'] as const)(
    'el veredicto %s de --validar-credencial no muestra la credencial',
    (verdict: CredentialVerdict) => {
      const result = validate(env('openai', { openai: keys.openai }), access, {
        credentialVerdict: verdict,
      });
      const codes = [...result.errors, ...result.warnings].map((f) => f.code);
      expect(codes).toContain(verdict === 'rejected' ? 'llm_key_rejected' : 'llm_key_unverified');
      expectNoLeak(text(result), allKeys);
    },
  );

  // Una credencial reutilizada entre instancias se detecta comparando huellas, y la huella no es
  // reversible: el hallazgo tampoco puede nombrar el valor.
  it('el secreto reutilizado entre instancias se nombra sin mostrarlo', () => {
    const other = env('anthropic', { anthropic: keys.anthropic });
    const inv = createInventory(TEST_INVENTORY_KEY, TODAY);
    inv.instances.push(instanceFromEnv({ ...other, INSTANCE_ID: 'demo-vecina' }, { status: 'active' }));
    const result = validate(env('anthropic', { anthropic: keys.anthropic }), {
      ...access,
      inventory: inv,
    });
    expectNoLeak(text(result), allKeys);
  });

  it('una forma desconocida tampoco se muestra al avisar de ella', () => {
    // Sin palabras reconocibles a propósito: una clave falsa que contuviera «credencial» haría
    // fallar la búsqueda contra el propio texto del aviso, que sí usa esa palabra.
    const raro = `zq7_${body()}`;
    const result = validate(env('anthropic', { anthropic: raro }), access);
    expect(result.warnings.map((w) => w.code)).toContain('llm_key_format');
    expectNoLeak(text(result), [raro]);
  });
});

describe('la verificación y su vigilante no filtran ninguna credencial', () => {
  const collect = () => {
    const lines: string[] = [];
    return { lines, log: (line: string) => lines.push(line) };
  };

  it.each(LLM_PROVIDERS)('%s: la credencial viaja en cabecera, nunca en la dirección', async (provider) => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = ((url: string, init: RequestInit) => {
      seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      return Promise.resolve(new Response('[]', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const { lines, log } = collect();
    expect(await verifyCredential(provider, keys[provider], { fetch, log })).toBe('accepted');
    // La dirección es lo que acaba en los registros de los intermediarios.
    expectNoLeak(seen.map((s) => s.url).join('\n'), allKeys);
    // En las cabeceras sí está, que es el sitio correcto; si no, no se estaría verificando nada.
    expect(JSON.stringify(seen[0]?.headers)).toContain(keys[provider]);
    expectNoLeak(lines.join('\n'), allKeys);
  });

  it.each(LLM_PROVIDERS)('%s: el rechazo nombra la variable y no el valor', async (provider) => {
    const fetch = (() =>
      Promise.resolve(new Response('no autorizado', { status: 401 }))) as unknown as typeof globalThis.fetch;
    const { lines, log } = collect();
    expect(await verifyCredential(provider, keys[provider], { fetch, log })).toBe('rejected');
    expect(lines.join('\n')).toContain(keyVariableOf(provider));
    expectNoLeak(lines.join('\n'), allKeys);
  });

  // El caso realista de filtración: un cliente HTTP que mete la petición entera —cabeceras
  // incluidas— en el mensaje del error. Si ese texto se registrase, la credencial saldría.
  it('un error del cliente que incluye la credencial en su mensaje no se registra', async () => {
    const fetch = (() => {
      throw new Error(`fallo al pedir https://api/models con x-api-key: ${keys.anthropic}`);
    }) as unknown as typeof globalThis.fetch;
    const { lines, log } = collect();
    expect(await verifyCredential('anthropic', keys.anthropic, { fetch, log })).toBe('inconclusive');
    expectNoLeak(lines.join('\n'), allKeys);
  });

  it('las dos líneas del vigilante nombran la variable y no el valor', async () => {
    let verdict: CredentialVerdict = 'rejected';
    const { lines, log } = collect();
    const watcher = createCredentialWatcher({
      provider: 'gemini',
      apiKey: keys.gemini,
      verify: () => Promise.resolve(verdict),
      log,
      retryIntervalMs: 60 * 60_000,
    });
    try {
      await watcher.check();
      verdict = 'accepted';
      await watcher.check();
      expect(lines).toHaveLength(2);
      expect(lines.every((l) => l.includes('GEMINI_API_KEY'))).toBe(true);
      expectNoLeak(lines.join('\n'), allKeys);
    } finally {
      watcher.close();
    }
  });
});
