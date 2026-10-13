/**
 * El proveedor del modelo en el entorno de la instancia (017, FR-001 – FR-005, R2).
 *
 * Lo que más importa de este fichero es el primer test: un entorno escrito antes de la 017, sin
 * `LLM_PROVIDER`, tiene que seguir cargando exactamente igual. Es la garantía de que los dos
 * entornos ya desplegados no se tocan (FR-003).
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';

const SESSION_SECRET = '3f8b1d6a94c70e25b8af13d05c6e297140bd8a3e5f21c64907ab3d8e15c2f6b4';

/** Lo mínimo para que el entorno cargue, sin nada del modelo. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://chatbot:clave-larga-de-prueba@localhost:5432/chatbot',
    OPERATOR_USER: 'operador',
    OPERATOR_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$abcdefghijklmnop$0123456789abcdef',
    SESSION_SECRET,
    DEFAULT_PHONE_REGION: 'ES',
    DEFAULT_TIMEZONE: 'Europe/Madrid',
    DEFAULT_CURRENCY: 'EUR',
    EMERGENCY_CONTACT_PHONE: '+34600111222',
    NODE_ENV: 'test',
    ...overrides,
  };
}

function loadError(source: NodeJS.ProcessEnv): string {
  try {
    loadEnv(source);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('se esperaba un fallo de carga del entorno');
}

describe('LLM_PROVIDER ausente (FR-003)', () => {
  it('equivale a anthropic y conserva el modelo por defecto', () => {
    const env = loadEnv(baseEnv({ ANTHROPIC_API_KEY: `sk-ant-${'x'.repeat(40)}` }));
    expect(env.LLM_PROVIDER).toBe('anthropic');
    expect(env.LLM_MODEL).toBe('claude-sonnet-5-5');
    expect(env.llmKeyVariable).toBe('ANTHROPIC_API_KEY');
  });

  it('un entorno sin ninguna variable del modelo sigue cargando (instancia solo con panel)', () => {
    const env = loadEnv(baseEnv());
    expect(env.LLM_PROVIDER).toBe('anthropic');
    expect(env.llmApiKey).toBeUndefined();
  });
});

describe('LLM_PROVIDER no elegible (FR-002)', () => {
  it('falla con un mensaje que nombra los tres proveedores', () => {
    const message = loadError(baseEnv({ LLM_PROVIDER: 'mistral' }));
    for (const provider of ['anthropic', 'gemini', 'openai']) {
      expect(message).toContain(provider);
    }
  });
});

describe('credencial del proveedor declarado (FR-004, FR-005)', () => {
  it('con el canal de WhatsApp exige la variable del proveedor declarado, nombrándola', () => {
    const message = loadError(
      baseEnv({
        LLM_PROVIDER: 'gemini',
        LLM_MODEL: 'gemini-de-prueba',
        WHATSAPP_PHONE_NUMBER_ID: '100000000000000',
        WHATSAPP_ACCESS_TOKEN: 'x'.repeat(48),
        WHATSAPP_APP_SECRET: 'y'.repeat(40),
        WHATSAPP_VERIFY_TOKEN: 'z'.repeat(40),
        WHATSAPP_GRAPH_VERSION: 'v21.0',
      }),
    );
    expect(message).toContain('GEMINI_API_KEY es obligatoria con el canal de WhatsApp');
  });

  // FR-004: la credencial de otro proveedor no sirve de respaldo. Aquí hay una clave de Anthropic
  // perfectamente válida presente, y el entorno tiene que fallar igual.
  it('la credencial de otro proveedor presente no cuenta como la del declarado', () => {
    const message = loadError(
      baseEnv({
        LLM_PROVIDER: 'openai',
        LLM_MODEL: 'modelo-de-prueba',
        ANTHROPIC_API_KEY: `sk-ant-${'x'.repeat(40)}`,
        WHATSAPP_PHONE_NUMBER_ID: '100000000000000',
        WHATSAPP_ACCESS_TOKEN: 'x'.repeat(48),
        WHATSAPP_APP_SECRET: 'y'.repeat(40),
        WHATSAPP_VERIFY_TOKEN: 'z'.repeat(40),
        WHATSAPP_GRAPH_VERSION: 'v21.0',
      }),
    );
    expect(message).toContain('OPENAI_API_KEY es obligatoria');
  });

  it('el contacto de emergencia se exige nombrando la variable del declarado', () => {
    const source = baseEnv({
      LLM_PROVIDER: 'gemini',
      LLM_MODEL: 'gemini-de-prueba',
      GEMINI_API_KEY: `AIza${'x'.repeat(35)}`,
    });
    delete source.EMERGENCY_CONTACT_PHONE;
    expect(loadError(source)).toContain('EMERGENCY_CONTACT_PHONE es obligatoria con GEMINI_API_KEY');
  });

  it('la credencial del declarado queda disponible sin que nadie nombre su variable', () => {
    const env = loadEnv(
      baseEnv({
        LLM_PROVIDER: 'openai',
        LLM_MODEL: 'modelo-de-prueba',
        OPENAI_API_KEY: `sk-proj-${'x'.repeat(40)}`,
      }),
    );
    expect(env.llmApiKey).toBe(`sk-proj-${'x'.repeat(40)}`);
    expect(env.llmKeyVariable).toBe('OPENAI_API_KEY');
  });
});

describe('LLM_MODEL (R2)', () => {
  it.each(['gemini', 'openai'])('es obligatoria con LLM_PROVIDER=%s', (provider) => {
    const message = loadError(baseEnv({ LLM_PROVIDER: provider }));
    expect(message).toContain(`LLM_MODEL es obligatoria con LLM_PROVIDER=${provider}`);
  });

  it('no es obligatoria con anthropic, que conserva su valor por defecto', () => {
    expect(loadEnv(baseEnv({ LLM_PROVIDER: 'anthropic' })).LLM_MODEL).toBe('claude-sonnet-5-5');
  });

  it('el valor declarado manda en los tres proveedores', () => {
    for (const provider of ['anthropic', 'gemini', 'openai']) {
      const env = loadEnv(baseEnv({ LLM_PROVIDER: provider, LLM_MODEL: 'modelo-declarado' }));
      expect(env.LLM_MODEL).toBe('modelo-declarado');
    }
  });
});
