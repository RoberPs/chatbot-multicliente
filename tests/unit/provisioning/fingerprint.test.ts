import { describe, expect, it } from 'vitest';
import {
  databaseIdentity,
  envFingerprints,
  fingerprint,
  keyCheck,
  normalize,
  parseInventoryKey,
  verifyKey,
} from '../../../src/provisioning/fingerprint.js';
import {
  collectSecrets,
  OTHER_INVENTORY_KEY_HEX,
  productionEnv,
  TEST_INVENTORY_KEY,
  TODAY,
  whatsappVars,
} from '../../helpers/provisioning.js';

const OTHER_KEY = Buffer.from(OTHER_INVENTORY_KEY_HEX, 'hex');

describe('huellas (research R4)', () => {
  it('determinista, de 22 caracteres base64url, dependiente de la clave y de la clase', () => {
    const a = fingerprint(TEST_INVENTORY_KEY, 'secret', 'valor');
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fingerprint(TEST_INVENTORY_KEY, 'secret', 'valor')).toBe(a);
    expect(fingerprint(OTHER_KEY, 'secret', 'valor')).not.toBe(a);
    expect(fingerprint(TEST_INVENTORY_KEY, 'database', 'valor')).not.toBe(a);
    expect(fingerprint(TEST_INVENTORY_KEY, 'secret', 'valor2')).not.toBe(a);
  });

  it('la clase secret es común: el mismo valor en SESSION_SECRET y BACKUP_KEY da la misma huella', () => {
    const value = 'ab'.repeat(8) + '0123456789abcdef'.repeat(3);
    const env = productionEnv('demo-01', { SESSION_SECRET: value });
    const other = productionEnv('demo-02', { BACKUP_KEY: value.toUpperCase() });
    const session = envFingerprints(env, TEST_INVENTORY_KEY, TODAY).find(
      (f) => f.variable === 'SESSION_SECRET',
    );
    const backup = envFingerprints(other, TEST_INVENTORY_KEY, TODAY).find(
      (f) => f.variable === 'BACKUP_KEY',
    );
    expect(session?.value).toBe(backup?.value);
  });

  it('normalización por variable', () => {
    expect(normalize('SESSION_SECRET', ' ABCDEF ')).toBe('abcdef');
    expect(normalize('BACKUP_KEYS_PREVIOUS', 'ABC')).toBe('abc');
    expect(normalize('PUBLIC_BASE_URL', 'https://Chat.Ejemplo.com/')).toBe(
      'https://chat.ejemplo.com',
    );
    expect(normalize('BACKUP_DIR', '/var/lib/chatbot/backups/')).toBe('/var/lib/chatbot/backups');
    expect(normalize('BACKUP_DIR', '/')).toBe('/');
    expect(normalize('ANTHROPIC_API_KEY', '  sk-ant-X  ')).toBe('sk-ant-X');
    expect(databaseIdentity('postgres://u:p@DB.Interna/base')).toEqual({
      host: 'db.interna',
      port: 5432,
      name: 'base',
      user: 'u',
    });
    expect(databaseIdentity('postgresql://u%40x:p@h:6543/b%20c?sslmode=require')).toEqual({
      host: 'h',
      port: 6543,
      name: 'b c',
      user: 'u@x',
    });
    expect(databaseIdentity('')).toBeNull();
    expect(databaseIdentity('mysql://u@h/b')).toBeNull();
  });

  it('keyCheck y verifyKey', () => {
    const check = keyCheck(TEST_INVENTORY_KEY);
    expect(check).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(verifyKey(TEST_INVENTORY_KEY, check)).toBe(true);
    expect(verifyKey(OTHER_KEY, check)).toBe(false);
    expect(verifyKey(TEST_INVENTORY_KEY, 'corto')).toBe(false);
    expect(parseInventoryKey('xyz')).toBeNull();
    expect(parseInventoryKey(` ${OTHER_INVENTORY_KEY_HEX.toUpperCase()} `)?.equals(OTHER_KEY)).toBe(
      true,
    );
  });

  it('envFingerprints produce exactamente las variables y clases de la tabla', () => {
    const previous = ['1b3d5f7092a4c6e8f0a2c4e6183b5d7f9a1c3e5072b4d6f8e0a2c4e6f8193b5d'];
    const env = productionEnv('demo-01', {
      ...whatsappVars(),
      STT_API_KEY: 'stt-0123456789abcdefghij',
      SMTP_URL: 'smtps://avisos:clave-larga-de-smtp@correo.ejemplo.com:465',
      SMTP_FROM: 'avisos@ejemplo.com',
      BACKUP_KEYS_PREVIOUS: previous.join(','),
    });
    const fps = envFingerprints(env, TEST_INVENTORY_KEY, TODAY);
    expect(fps.map((f) => `${f.variable}:${f.class}:${String(f.current)}`).sort()).toEqual(
      [
        'SESSION_SECRET:secret:true',
        'BACKUP_KEY:secret:true',
        'BACKUP_KEYS_PREVIOUS:secret:false',
        'OPERATOR_PASSWORD_HASH:secret:true',
        'ANTHROPIC_API_KEY:secret:true',
        'WHATSAPP_ACCESS_TOKEN:secret:true',
        'WHATSAPP_APP_SECRET:secret:true',
        'WHATSAPP_VERIFY_TOKEN:secret:true',
        'STT_API_KEY:secret:true',
        'SMTP_URL:secret:true',
        'DATABASE_PASSWORD:secret:true',
        'DATABASE:database:true',
        'DATABASE_USER:database_user:true',
        'PUBLIC_BASE_URL:public_url:true',
        'WHATSAPP_PHONE_NUMBER_ID:whatsapp_phone:true',
        'BACKUP_DIR:backup_dir:true',
      ].sort(),
    );
    expect(fps.every((f) => f.since === TODAY)).toBe(true);
    expect(fps.some((f) => f.variable === 'INSTANCE_ID')).toBe(false);
    const text = JSON.stringify(fps);
    expect(collectSecrets(env).some((s) => text.includes(s))).toBe(false);
  });

  it('omite las variables vacías', () => {
    const env = productionEnv('demo-01', { ANTHROPIC_API_KEY: '', DATABASE_URL: '' });
    const variables = envFingerprints(env, TEST_INVENTORY_KEY, TODAY).map((f) => f.variable);
    expect(variables).not.toContain('ANTHROPIC_API_KEY');
    expect(variables).not.toContain('DATABASE');
    expect(variables).not.toContain('DATABASE_PASSWORD');
    expect(variables).not.toContain('WHATSAPP_ACCESS_TOKEN');
  });
});
