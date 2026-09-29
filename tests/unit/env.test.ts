import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://x',
  OPERATOR_USER: 'operador',
  OPERATOR_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$abc$def',
  SESSION_SECRET: '3f9a1c7e5b2d4086a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b2',
  NODE_ENV: 'production',
  // Copias (006): obligatorias en production.
  INSTANCE_ID: 'demo-01',
  BACKUP_DIR: '/var/lib/chatbot/backups',
  BACKUP_KEY: '9c4e1a7f3b5d2068e1a3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b4',
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
      expect(loadEnv({ ...base, PUBLIC_BASE_URL: 'http://localhost:3000' }).PUBLIC_BASE_URL).toBe(
        'http://localhost:3000',
      );
    });

    it.each([
      ['con ruta', 'https://chat.ejemplo.com/bot'],
      ['http público', 'http://chat.ejemplo.com'],
      ['no es una URL', 'chat.ejemplo.com'],
    ])('rechaza una URL %s', (_name, value) => {
      expect(() => loadEnv({ ...base, PUBLIC_BASE_URL: value })).toThrow(/PUBLIC_BASE_URL/);
    });
  });

  describe('avisos de derivación (005)', () => {
    it('SMTP ausente → smtp null', () => {
      expect(loadEnv(base).smtp).toBeNull();
      expect(loadEnv({ ...base, SMTP_URL: '', SMTP_FROM: ' ' }).smtp).toBeNull();
    });

    it.each([
      ['smtps', 'smtps://usuario:clave@correo.ejemplo.com:465'],
      ['smtp con STARTTLS', 'smtp://usuario:clave@correo.ejemplo.com:587'],
    ])('SMTP completo (%s) → url y remitente', (_name, url) => {
      const env = loadEnv({ ...base, SMTP_URL: url, SMTP_FROM: ' Avisos@Ejemplo.com ' });
      expect(env.smtp).toEqual({ url, from: 'avisos@ejemplo.com' });
    });

    it('solo una de las dos variables SMTP → error', () => {
      expect(() => loadEnv({ ...base, SMTP_URL: 'smtp://correo.ejemplo.com:587' })).toThrow(
        /SMTP_URL y SMTP_FROM/,
      );
      expect(() => loadEnv({ ...base, SMTP_FROM: 'avisos@ejemplo.com' })).toThrow(
        /SMTP_URL y SMTP_FROM/,
      );
    });

    it.each([
      ['https', 'https://correo.ejemplo.com'],
      ['sin esquema', 'correo.ejemplo.com:587'],
      ['sin host', 'smtp://'],
    ])('SMTP_URL con esquema no válido (%s) → error', (_name, url) => {
      expect(() => loadEnv({ ...base, SMTP_URL: url, SMTP_FROM: 'avisos@ejemplo.com' })).toThrow(
        /SMTP_URL/,
      );
    });

    it('SMTP_FROM que no es un email → error', () => {
      expect(() =>
        loadEnv({ ...base, SMTP_URL: 'smtp://correo.ejemplo.com:587', SMTP_FROM: 'avisos' }),
      ).toThrow(/SMTP_FROM/);
    });

    it('WHATSAPP_TEMPLATE_LANG: es por defecto; xx o xx_XX', () => {
      expect(loadEnv(base).WHATSAPP_TEMPLATE_LANG).toBe('es');
      expect(loadEnv({ ...base, WHATSAPP_TEMPLATE_LANG: '' }).WHATSAPP_TEMPLATE_LANG).toBe('es');
      expect(loadEnv({ ...base, WHATSAPP_TEMPLATE_LANG: 'es_MX' }).WHATSAPP_TEMPLATE_LANG).toBe(
        'es_MX',
      );
    });

    it.each([['español'], ['ES'], ['es-ES'], ['es_mx']])(
      'WHATSAPP_TEMPLATE_LANG con formato no válido (%s) → error',
      (value) => {
        expect(() => loadEnv({ ...base, WHATSAPP_TEMPLATE_LANG: value })).toThrow(
          /WHATSAPP_TEMPLATE_LANG/,
        );
      },
    );
  });
  describe('copias de seguridad (006)', () => {
    const KEY_B = '1b3d5f7092a4c6e8f0a2c4e6183b5d7f9a1c3e5072b4d6f8e0a2c4e6f8193b5d';
    const { INSTANCE_ID: _i, BACKUP_DIR: _d, BACKUP_KEY: _k, ...withoutBackup } = base;
    const dev = { ...withoutBackup, NODE_ENV: 'development' };

    it('las tres variables → env.backup con valores por defecto del resto', () => {
      const env = loadEnv(base);
      expect(env.backup).toEqual({
        instanceId: 'demo-01',
        dir: '/var/lib/chatbot/backups',
        key: base.BACKUP_KEY,
        previousKeys: [],
      });
      expect(env.BACKUP_RETENTION_DAYS).toBe(7);
      expect(env.BACKUP_DAILY_TIME).toBe('03:00');
      expect(env.BACKUP_VERIFY_URL).toBe(base.DATABASE_URL);
    });

    it('fuera de production, ninguna → env.backup null', () => {
      expect(loadEnv(dev).backup).toBeNull();
      expect(
        loadEnv({ ...dev, INSTANCE_ID: '', BACKUP_DIR: ' ', BACKUP_KEY: '' }).backup,
      ).toBeNull();
    });

    it('fuera de production van juntas: una parcial es un error que nombra las que faltan', () => {
      expect(() => loadEnv({ ...dev, INSTANCE_ID: 'demo-01' })).toThrow(
        /van juntas; faltan: BACKUP_DIR, BACKUP_KEY/,
      );
    });

    it.each(['INSTANCE_ID', 'BACKUP_DIR', 'BACKUP_KEY'] as const)(
      'en production falta %s → error',
      (name) => {
        const { [name]: _omit, ...rest } = base;
        expect(() => loadEnv(rest)).toThrow(new RegExp(`faltan: ${name}`));
      },
    );

    it.each([['Demo-01'], ['-demo'], ['demo-'], ['demo_01'], ['a'.repeat(41)]])(
      'INSTANCE_ID no válido (%s) → error',
      (value) => {
        expect(() => loadEnv({ ...base, INSTANCE_ID: value })).toThrow(/INSTANCE_ID/);
      },
    );

    it('INSTANCE_ID de 1 y de 40 caracteres es válido', () => {
      expect(loadEnv({ ...base, INSTANCE_ID: 'a' }).backup?.instanceId).toBe('a');
      expect(loadEnv({ ...base, INSTANCE_ID: 'a'.repeat(40) }).backup?.instanceId).toHaveLength(40);
    });

    it('BACKUP_DIR debe ser absoluta', () => {
      expect(() => loadEnv({ ...base, BACKUP_DIR: 'backups' })).toThrow(/BACKUP_DIR/);
      expect(() => loadEnv({ ...base, BACKUP_DIR: './backups' })).toThrow(/BACKUP_DIR/);
    });

    it.each([
      ['corta', 'abcdef0123456789'],
      ['no hex', 'z'.repeat(64)],
      ['repetitiva', 'ab'.repeat(32)],
    ])('BACKUP_KEY %s → error', (_name, key) => {
      expect(() => loadEnv({ ...base, BACKUP_KEY: key })).toThrow(/BACKUP_KEY/);
    });

    it('BACKUP_KEY igual a SESSION_SECRET → error', () => {
      expect(() => loadEnv({ ...base, BACKUP_KEY: base.SESSION_SECRET.toUpperCase() })).toThrow(
        /BACKUP_KEY debe ser distinta de SESSION_SECRET/,
      );
    });

    it('BACKUP_KEYS_PREVIOUS: lista de claves de 64 hex separadas por comas', () => {
      expect(
        loadEnv({
          ...base,
          BACKUP_KEYS_PREVIOUS: ` ${KEY_B.toUpperCase()} , ${base.SESSION_SECRET}`,
        }).backup?.previousKeys,
      ).toEqual([KEY_B, base.SESSION_SECRET]);
      expect(() => loadEnv({ ...base, BACKUP_KEYS_PREVIOUS: `${KEY_B},abc` })).toThrow(
        /BACKUP_KEYS_PREVIOUS/,
      );
    });

    it.each([['0'], ['31'], ['7.5'], ['siete']])('BACKUP_RETENTION_DAYS=%s → error', (value) => {
      expect(() => loadEnv({ ...base, BACKUP_RETENTION_DAYS: value })).toThrow(
        'BACKUP_RETENTION_DAYS debe estar entre 1 y 30 días (máximo 30)',
      );
    });

    it('BACKUP_RETENTION_DAYS 1 y 30 son válidos', () => {
      expect(loadEnv({ ...base, BACKUP_RETENTION_DAYS: '1' }).BACKUP_RETENTION_DAYS).toBe(1);
      expect(loadEnv({ ...base, BACKUP_RETENTION_DAYS: '30' }).BACKUP_RETENTION_DAYS).toBe(30);
    });

    it('BACKUP_DAILY_TIME: HH:MM de 24 h', () => {
      expect(loadEnv({ ...base, BACKUP_DAILY_TIME: '23:59' }).BACKUP_DAILY_TIME).toBe('23:59');
      for (const value of ['24:00', '3:00', '03:60', 'mediodía']) {
        expect(() => loadEnv({ ...base, BACKUP_DAILY_TIME: value })).toThrow(/BACKUP_DAILY_TIME/);
      }
    });

    it('BACKUP_VERIFY_URL propia sustituye a DATABASE_URL', () => {
      expect(
        loadEnv({ ...base, BACKUP_VERIFY_URL: 'postgres://verificador@otra/postgres' })
          .BACKUP_VERIFY_URL,
      ).toBe('postgres://verificador@otra/postgres');
    });
  });
});
