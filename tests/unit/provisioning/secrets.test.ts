import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cryptoRandom,
  generateHexSecret,
  generateOperatorPassword,
  generateVerifyToken,
  hashOperatorPassword,
  isPlaceholder,
  OPERATOR_HASH_OPTIONS,
  PASSWORD_ALPHABET,
  secretQuality,
  type RandomSource,
} from '../../../src/provisioning/secrets.js';

const hex = () => randomBytes(32).toString('hex');
const codes = (variable: string, value: string) =>
  secretQuality(variable, value).map((f) => f.code);
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA';

describe('secretQuality (research R3)', () => {
  it.each(['SESSION_SECRET', 'BACKUP_KEY', 'BACKUP_KEYS_PREVIOUS', 'HEALTH_SECRET'])(
    '%s: 64 hex con más de 8 caracteres distintos',
    (variable) => {
      expect(codes(variable, hex())).toEqual([]);
      expect(codes(variable, hex().toUpperCase())).toEqual([]);
      expect(codes(variable, 'abcdef0123')).toEqual(['weak_secret']);
      expect(codes(variable, 'ab'.repeat(32))).toEqual(['weak_secret']);
      expect(codes(variable, 'z'.repeat(64))).toEqual(['weak_secret']);
    },
  );

  it('OPERATOR_PASSWORD_HASH: formato argon2id y parámetros mínimos', () => {
    expect(codes('OPERATOR_PASSWORD_HASH', HASH)).toEqual([]);
    expect(codes('OPERATOR_PASSWORD_HASH', 'plano')).toEqual(['weak_secret']);
    expect(codes('OPERATOR_PASSWORD_HASH', HASH.replace('argon2id', 'argon2i'))).toEqual([
      'weak_secret',
    ]);
    expect(codes('OPERATOR_PASSWORD_HASH', HASH.replace('m=65536', 'm=4096'))).toEqual([
      'weak_argon2_params',
    ]);
    expect(codes('OPERATOR_PASSWORD_HASH', HASH.replace('t=3', 't=1'))).toEqual([
      'weak_argon2_params',
    ]);
  });

  it('longitudes mínimas de los valores de terceros', () => {
    const token = (n: number) => randomBytes(n).toString('base64url').slice(0, n);
    expect(codes('WHATSAPP_VERIFY_TOKEN', randomBytes(24).toString('hex'))).toEqual([]);
    expect(codes('WHATSAPP_VERIFY_TOKEN', token(31))).toEqual(['weak_secret']);
    expect(codes('WHATSAPP_VERIFY_TOKEN', '0101010101010101010101010101010101')).toEqual([
      'weak_secret',
    ]);
    expect(codes('WHATSAPP_APP_SECRET', randomBytes(16).toString('hex'))).toEqual([]);
    expect(codes('WHATSAPP_APP_SECRET', token(31))).toEqual(['weak_secret']);
    expect(codes('WHATSAPP_ACCESS_TOKEN', token(40))).toEqual([]);
    expect(codes('WHATSAPP_ACCESS_TOKEN', token(39))).toEqual(['weak_secret']);
    expect(codes('ANTHROPIC_API_KEY', `sk-ant-${token(40)}`)).toEqual([]);
    expect(codes('ANTHROPIC_API_KEY', token(45))).toEqual(['llm_key_format']);
    expect(codes('ANTHROPIC_API_KEY', `sk-ant-${token(10)}`)).toEqual(['weak_secret']);
    expect(codes('STT_API_KEY', token(20))).toEqual([]);
    expect(codes('STT_API_KEY', token(19))).toEqual(['weak_secret']);
    expect(codes('DATABASE_URL', token(16))).toEqual([]);
    expect(codes('DATABASE_URL', token(15))).toEqual(['weak_secret']);
    expect(codes('DATABASE_URL', 'chatbot')).toEqual(['example_database']);
  });

  it.each([
    ['changeme123'],
    ['test-token-0123456789abcdefghijklmnopqrstuvwxyz'],
    ['sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyz'],
    ['mi_password_0123456789abcdefghijklmnopqrstuvwxyz'],
    ['supersecret1'],
    ['x'.repeat(48)],
    ['0123456789012345678901234567890123456789'],
    ['abcdefghijklmnopqrstuvwxyzabcdefghijklmnop'],
    ['PENDIENTE'],
    ['placeholder-placeholder-placeholder-placeholder'],
  ])('valor de relleno %s → weak_secret', (value) => {
    expect(isPlaceholder(value)).toBe(true);
    expect(codes('WHATSAPP_ACCESS_TOKEN', value)).toContain('weak_secret');
  });

  it('un valor aleatorio largo con xxx o test en medio no es de relleno', () => {
    const a = `${randomBytes(12).toString('hex')}xxx${randomBytes(4).toString('hex')}`;
    const b = `Qz7Kp2Wm9Rt4Yv8Nb3Hj6Lx1testFg5Dc0SaE`;
    expect(isPlaceholder(a)).toBe(false);
    expect(isPlaceholder(b)).toBe(false);
    expect(codes('WHATSAPP_ACCESS_TOKEN', `${a}${a}`)).toEqual([]);
  });

  it('ningún resultado contiene el valor', () => {
    const value = `sk-ant-test-${randomBytes(30).toString('hex')}`;
    expect(JSON.stringify(secretQuality('ANTHROPIC_API_KEY', value))).not.toContain(value);
  });
});

describe('generación de secretos (research R7)', () => {
  /** Aleatoriedad que da primero `first` y después la real. */
  const scripted = (first: Buffer[]): RandomSource => {
    const queue = [...first];
    return {
      bytes: (n) => queue.shift() ?? randomBytes(n),
      int: (max) => cryptoRandom.int(max),
    };
  };

  it('SESSION_SECRET y BACKUP_KEY de 64 hex; token de 48 hex; contraseña de 24 del alfabeto', () => {
    expect(generateHexSecret('SESSION_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect(generateHexSecret('BACKUP_KEY')).toMatch(/^[0-9a-f]{64}$/);
    expect(generateHexSecret('HEALTH_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect(codes('HEALTH_SECRET', generateHexSecret('HEALTH_SECRET'))).toEqual([]);
    // Marcadores de posición de la plantilla: no son un secreto.
    for (const placeholder of ['changeme', 'PENDIENTE', '', 'secret-de-salud']) {
      expect(codes('HEALTH_SECRET', placeholder)).toEqual(['weak_secret']);
    }
    expect(generateVerifyToken()).toMatch(/^[0-9a-f]{48}$/);
    expect(PASSWORD_ALPHABET).toHaveLength(56);
    expect(PASSWORD_ALPHABET).not.toMatch(/[IOlo01]/);
    const password = generateOperatorPassword();
    expect(password).toHaveLength(24);
    expect(password).toMatch(new RegExp(`^[${PASSWORD_ALPHABET}]{24}$`));
  });

  it('todos los valores generados superan secretQuality', () => {
    for (let i = 0; i < 50; i++) {
      expect(codes('SESSION_SECRET', generateHexSecret('SESSION_SECRET'))).toEqual([]);
      expect(codes('BACKUP_KEY', generateHexSecret('BACKUP_KEY'))).toEqual([]);
      expect(codes('WHATSAPP_VERIFY_TOKEN', generateVerifyToken())).toEqual([]);
      expect(codes('OPERATOR_PASSWORD', generateOperatorPassword())).toEqual([]);
    }
  });

  it('descarta un valor que no pasa secretQuality y devuelve el siguiente', () => {
    const weak = Buffer.alloc(32, 0xaa); // "aaaa…": un solo carácter repetido
    const value = generateHexSecret('SESSION_SECRET', scripted([weak]));
    expect(value).not.toBe(weak.toString('hex'));
    expect(codes('SESSION_SECRET', value)).toEqual([]);
    const token = generateVerifyToken(scripted([Buffer.alloc(24, 0x11)]));
    expect(token).not.toBe('11'.repeat(24));
  });

  it('el hash se calcula con el hasher inyectado; el real usa argon2id con los parámetros de operator:hash-password', async () => {
    const seen: string[] = [];
    const hash = await hashOperatorPassword('contraseña-de-prueba-larga', (p) => {
      seen.push(p);
      return Promise.resolve('hash-falso');
    });
    expect(hash).toBe('hash-falso');
    expect(seen).toEqual(['contraseña-de-prueba-larga']);
    expect(OPERATOR_HASH_OPTIONS.type).toBe(2); // argon2id
    const real = await hashOperatorPassword(generateOperatorPassword());
    expect(codes('OPERATOR_PASSWORD_HASH', real)).toEqual([]);
  });
});

/**
 * 017 (FR-028, R4): severidad de la forma de la credencial del modelo.
 *
 * Este bloque es la **regresión del fallo que la feature existe para cerrar**. Antes de la 017,
 * `secretQuality` comprobaba a mano que `ANTHROPIC_API_KEY` empezara por `sk-ant-` y emitía
 * `llm_key_format` como **aviso**. Un aviso no deja el entorno no apto, así que una clave de Gemini
 * pegada en `ANTHROPIC_API_KEY` **pasaba** `pnpm instance:check` y la instancia fallaba después,
 * en silencio, delante de cada cliente.
 */
describe('forma de la credencial del modelo (017, FR-028)', () => {
  const token = (n: number) => randomBytes(n).toString('base64url').slice(0, n);
  const hallazgo = (variable: string, value: string) =>
    secretQuality(variable, value).find(
      (f) => f.code === 'llm_key_other_provider' || f.code === 'llm_key_format',
    );

  it('la credencial correcta de cada variable no produce ningún hallazgo', () => {
    expect(hallazgo('ANTHROPIC_API_KEY', `sk-ant-${token(45)}`)).toBeUndefined();
    expect(hallazgo('GEMINI_API_KEY', `AIza${token(40)}`)).toBeUndefined();
    expect(hallazgo('GEMINI_API_KEY', `AQ.${token(40)}`)).toBeUndefined();
    expect(hallazgo('OPENAI_API_KEY', `sk-proj-${token(45)}`)).toBeUndefined();
    expect(hallazgo('OPENAI_API_KEY', `sk-${token(45)}`)).toBeUndefined();
  });

  // EL FALLO: hoy esto pasaba con un simple aviso. Ahora es ERROR y el entorno queda no apto.
  it.each([
    ['una clave de Gemini en la variable de Anthropic', 'ANTHROPIC_API_KEY', `AIza${'x'.repeat(40)}`, 'gemini'],
    ['una clave nueva de Gemini en la de Anthropic', 'ANTHROPIC_API_KEY', `AQ.${'x'.repeat(40)}`, 'gemini'],
    ['una clave de OpenAI en la de Anthropic', 'ANTHROPIC_API_KEY', `sk-proj-${'x'.repeat(45)}`, 'openai'],
    ['una clave de Anthropic en la de Gemini', 'GEMINI_API_KEY', `sk-ant-${'x'.repeat(45)}`, 'anthropic'],
    ['una clave de Anthropic en la de OpenAI', 'OPENAI_API_KEY', `sk-ant-${'x'.repeat(45)}`, 'anthropic'],
    ['una clave de Gemini en la de OpenAI', 'OPENAI_API_KEY', `AIza${'x'.repeat(40)}`, 'gemini'],
  ])('%s es ERROR y dice de quién parece', (_caso, variable, valor, proveedor) => {
    const f = hallazgo(variable, valor);
    expect(f?.code).toBe('llm_key_other_provider');
    expect(f?.severity).toBe('error');
    expect(f?.otherProvider).toBe(proveedor);
  });

  // La trampa del orden (R3): `sk-ant-` es subconjunto de `sk-`. Si se evaluara al revés, una
  // clave de Anthropic en su propia variable se declararía «de OpenAI» y el entorno correcto
  // quedaría no apto.
  it('una clave de Anthropic en su variable NO se acusa de ser de OpenAI', () => {
    expect(hallazgo('ANTHROPIC_API_KEY', `sk-ant-api03-${'x'.repeat(40)}`)).toBeUndefined();
  });

  it('una forma no reconocida es AVISO, no error (R3)', () => {
    const f = hallazgo('ANTHROPIC_API_KEY', `xyz-${'x'.repeat(45)}`);
    expect(f?.code).toBe('llm_key_format');
    expect(f?.severity).toBe('warning');
  });

  it('la regla vale para las tres variables, no solo para la de Anthropic', () => {
    for (const variable of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) {
      expect(hallazgo(variable, `forma-rara-${'x'.repeat(40)}`)?.code).toBe('llm_key_format');
    }
  });

  it('ningún hallazgo lleva el valor examinado (FR-032)', () => {
    const valor = `AIza${'secretosecreto'.repeat(3)}`;
    const texto = JSON.stringify(secretQuality('ANTHROPIC_API_KEY', valor));
    expect(texto).not.toContain(valor);
    expect(texto).not.toContain('secretosecreto');
  });
});
