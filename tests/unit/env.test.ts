import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://x',
  OPERATOR_USER: 'operador',
  OPERATOR_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$abc$def',
  SESSION_SECRET: '3f9a1c7e5b2d4086a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b2',
  NODE_ENV: 'production',
};

describe('variables de la instancia', () => {
  it('acepta una configuración válida con valores por defecto', () => {
    expect(loadEnv(base)).toMatchObject({
      DEFAULT_PHONE_REGION: 'ES',
      DEFAULT_TIMEZONE: 'Europe/Madrid',
      DEFAULT_CURRENCY: 'EUR',
      PORT: 3000,
      TRUST_PROXY: false,
    });
  });

  it.each([
    ['el valor de ejemplo antiguo', 'cambia-esto-por-un-secreto-largo-de-al-menos-32-bytes'],
    ['vacío', ''],
    ['hex demasiado corto', 'abcdef0123456789'],
    ['hex repetitivo', 'a'.repeat(64)],
  ])('rechaza SESSION_SECRET %s', (_name, secret) => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: secret })).toThrow(/SESSION_SECRET/);
  });

  it('NODE_ENV es obligatoria', () => {
    const { NODE_ENV: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/NODE_ENV/);
  });

  it('TRUST_PROXY: saltos o IP/CIDR, nunca true', () => {
    expect(loadEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...base, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).TRUST_PROXY).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
    expect(() => loadEnv({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it('rechaza un hash que no es Argon2id', () => {
    expect(() => loadEnv({ ...base, OPERATOR_PASSWORD_HASH: 'plano' })).toThrow(/Argon2id/);
  });

  describe('canal de WhatsApp y bot', () => {
    const channel = {
      WHATSAPP_PHONE_NUMBER_ID: '123456',
      WHATSAPP_ACCESS_TOKEN: 'token',
      WHATSAPP_APP_SECRET: 'secreto',
      WHATSAPP_VERIFY_TOKEN: 'verificacion',
      WHATSAPP_GRAPH_VERSION: 'v23.0',
      EMERGENCY_CONTACT_PHONE: '+34 600 111 222',
      ANTHROPIC_API_KEY: 'sk-ant-prueba',
    };

    it('canal completo → objeto whatsapp y valores por defecto del modelo y los audios', () => {
      const env = loadEnv({ ...base, ...channel });
      expect(env.whatsapp).toEqual({
        phoneNumberId: '123456',
        accessToken: 'token',
        appSecret: 'secreto',
        verifyToken: 'verificacion',
        graphVersion: 'v23.0',
      });
      expect(env.emergencyContactPhone).toBe('+34600111222');
      expect(env.LLM_MODEL).toBe('claude-sonnet-5');
      expect(env.LLM_EFFORT).toBe('medium');
      expect(env.audioTranscription).toBe(false);
      expect(env.STT_MODEL).toBe('whisper-1');
    });

    it('canal ausente (o con líneas vacías) → whatsapp null', () => {
      expect(loadEnv(base).whatsapp).toBeNull();
      expect(
        loadEnv({ ...base, WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_ACCESS_TOKEN: ' ' }).whatsapp,
      ).toBeNull();
    });

    it('canal parcial → error que nombra las que faltan', () => {
      const { WHATSAPP_APP_SECRET: _a, WHATSAPP_GRAPH_VERSION: _b, ...partial } = channel;
      expect(() => loadEnv({ ...base, ...partial })).toThrow(
        /faltan: WHATSAPP_APP_SECRET, WHATSAPP_GRAPH_VERSION/,
      );
    });

    it('EMERGENCY_CONTACT_PHONE es obligatoria con el canal y debe ser E.164', () => {
      const { EMERGENCY_CONTACT_PHONE: _omit, ...rest } = channel;
      expect(() => loadEnv({ ...base, ...rest })).toThrow(/EMERGENCY_CONTACT_PHONE es obligatoria/);
      expect(() => loadEnv({ ...base, ...channel, EMERGENCY_CONTACT_PHONE: '600111222' })).toThrow(
        /E\.164/,
      );
    });

    it('ANTHROPIC_API_KEY es obligatoria con el canal', () => {
      const { ANTHROPIC_API_KEY: _omit, ...rest } = channel;
      expect(() => loadEnv({ ...base, ...rest })).toThrow(/ANTHROPIC_API_KEY/);
    });

    it('audios: off por defecto sin STT_API_KEY; on sin STT_API_KEY es un error', () => {
      expect(loadEnv({ ...base, ...channel, AUDIO_TRANSCRIPTION: 'off' }).audioTranscription).toBe(
        false,
      );
      expect(() => loadEnv({ ...base, ...channel, AUDIO_TRANSCRIPTION: 'on' })).toThrow(
        /STT_API_KEY/,
      );
      expect(
        loadEnv({ ...base, ...channel, AUDIO_TRANSCRIPTION: 'on', STT_API_KEY: 'sk' })
          .audioTranscription,
      ).toBe(true);
    });

    it('LLM_EFFORT inválido', () => {
      expect(() => loadEnv({ ...base, LLM_EFFORT: 'max' })).toThrow(/LLM_EFFORT/);
    });
  });

  describe('bot sin WhatsApp (004)', () => {
    it('clave del modelo sin contacto de emergencia → error', () => {
      expect(() => loadEnv({ ...base, ANTHROPIC_API_KEY: 'sk-ant-prueba' })).toThrow(
        /EMERGENCY_CONTACT_PHONE es obligatoria con ANTHROPIC_API_KEY/,
      );
    });

    it('clave del modelo con contacto de emergencia → válido y sin WhatsApp', () => {
      const env = loadEnv({
        ...base,
        ANTHROPIC_API_KEY: 'sk-ant-prueba',
        EMERGENCY_CONTACT_PHONE: '+34600111222',
      });
      expect(env.whatsapp).toBeNull();
      expect(env.emergencyContactPhone).toBe('+34600111222');
    });
  });

  describe('PUBLIC_BASE_URL', () => {
    it('ausente → undefined', () => {
      expect(loadEnv(base).PUBLIC_BASE_URL).toBeUndefined();
      expect(loadEnv({ ...base, PUBLIC_BASE_URL: '' }).PUBLIC_BASE_URL).toBeUndefined();
    });

    it('https o http local → origen sin barra final', () => {
      expect(
        loadEnv({ ...base, PUBLIC_BASE_URL: 'https://Chat.Ejemplo.com/' }).PUBLIC_BASE_URL,
      ).toBe('https://chat.ejemplo.com');
      expect(
        loadEnv({ ...base, PUBLIC_BASE_URL: 'http://localhost:3000' }).PUBLIC_BASE_URL,
      ).toBe('http://localhost:3000');
    });

    it.each([
      ['con ruta', 'https://chat.ejemplo.com/bot'],
      ['http público', 'http://chat.ejemplo.com'],
      ['no es una URL', 'chat.ejemplo.com'],
    ])('rechaza una URL %s', (_name, value) => {
      expect(() => loadEnv({ ...base, PUBLIC_BASE_URL: value })).toThrow(/PUBLIC_BASE_URL/);
    });
  });
});
