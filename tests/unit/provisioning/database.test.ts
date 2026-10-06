import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyDatabaseUrl } from '../../../src/config/database-url.js';
import {
  buildDatabaseUrl,
  databaseNames,
  describeAdminUrl,
  generateDbPassword,
  parseAdminUrl,
  planSql,
  probeUrl,
  scramVerifier,
  translatePgError,
} from '../../../src/provisioning/database.js';

const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();

describe('nombres y contraseña (research R8)', () => {
  it('chatbot_<id> con guiones cambiados por _ y ≤ 48 caracteres', () => {
    expect(databaseNames('demo-01')).toEqual({
      database: 'chatbot_demo_01',
      user: 'chatbot_demo_01',
    });
    const longest = databaseNames('a'.repeat(40));
    expect(longest.database.length).toBeLessThanOrEqual(48);
  });

  it('contraseña de 32 caracteres base64url', () => {
    const password = generateDbPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateDbPassword()).not.toBe(password);
  });
});

describe('verificador SCRAM-SHA-256', () => {
  // RFC 7677 §3: usuario "user", contraseña "pencil".
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const authMessage =
    'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';

  it('coincide con el vector de prueba del RFC 7677', () => {
    const verifier = scramVerifier('pencil', salt, 4096);
    const match = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier);
    expect(match?.[1]).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');
    const storedKey = Buffer.from(match?.[2] ?? '', 'base64');
    const serverKey = Buffer.from(match?.[3] ?? '', 'base64');
    // Firma del servidor del RFC.
    expect(hmac(serverKey, authMessage).toString('base64')).toBe(
      '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=',
    );
    // Prueba del cliente del RFC: ClientKey = prueba XOR HMAC(StoredKey, AuthMessage).
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const signature = hmac(storedKey, authMessage);
    const clientKey = Buffer.from(proof.map((b, i) => b ^ (signature[i] ?? 0)));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
  });
});

describe('plan SQL', () => {
  const plan = planSql(databaseNames('demo-02'), 'SCRAM-SHA-256$4096:c2FsdA==$AAAA:BBBB');

  it('las sentencias del contrato, con identificadores citados y el verificador', () => {
    expect(plan.checkRole).toBe("SELECT 1 FROM pg_roles    WHERE rolname = 'chatbot_demo_02';");
    expect(plan.checkDatabase).toBe("SELECT 1 FROM pg_database WHERE datname = 'chatbot_demo_02';");
    expect(plan.createRole).toBe(
      `CREATE ROLE "chatbot_demo_02" LOGIN PASSWORD 'SCRAM-SHA-256$4096:c2FsdA==$AAAA:BBBB';`,
    );
    expect(plan.createDatabase).toBe('CREATE DATABASE "chatbot_demo_02" OWNER "chatbot_demo_02";');
    expect(plan.revoke).toBe(
      'REVOKE CONNECT, TEMPORARY ON DATABASE "chatbot_demo_02" FROM PUBLIC;',
    );
  });

  it('no contiene la contraseña en claro', () => {
    const password = generateDbPassword();
    const real = planSql(databaseNames('demo-02'), scramVerifier(password, Buffer.alloc(16, 7)));
    expect(JSON.stringify(real)).not.toContain(password);
  });
});

describe('URL', () => {
  it('buildDatabaseUrl codifica la contraseña y conserva sslmode', () => {
    expect(
      buildDatabaseUrl({
        host: 'db.interna',
        port: 5432,
        database: 'd',
        user: 'u',
        password: 'p@s:s/w',
      }),
    ).toBe('postgres://u:p%40s%3As%2Fw@db.interna:5432/d');
    expect(
      buildDatabaseUrl({
        host: 'h',
        port: 6543,
        database: 'd',
        user: 'u',
        password: 'p',
        sslmode: 'require',
      }),
    ).toBe('postgres://u:p@h:6543/d?sslmode=require');
  });

  it('parseAdminUrl: local y verifiedTls coherentes con classifyDatabaseUrl (013)', () => {
    const urls = [
      'postgres://admin:x@10.0.0.5:5432/postgres',
      'postgres://admin:x@10.0.0.5:5432/postgres?sslmode=require',
      'postgres://admin:x@db.interna/postgres?sslmode=verify-full&sslrootcert=/home/op/ca.crt',
      'postgres://admin:x@localhost/postgres',
      'postgres://admin:x@127.0.0.9/postgres?sslmode=disable',
      'postgres://admin:x@[::1]/postgres',
    ];
    for (const url of urls) {
      const c = classifyDatabaseUrl(url);
      if (c.kind !== 'ok') throw new Error('URL de prueba no válida');
      expect(parseAdminUrl(url)).toMatchObject({ local: c.local, verifiedTls: c.verifiedTls });
    }
    expect(
      parseAdminUrl(
        'postgres://admin:x@db.interna/postgres?sslmode=verify-full&sslrootcert=/home/op/ca.crt',
      ),
    ).toMatchObject({ sslmode: 'verify-full', sslrootcert: '/home/op/ca.crt' });
    expect(parseAdminUrl('mysql://admin:x@db.interna/postgres')).toBeNull();
  });

  it('buildDatabaseUrl añade sslrootcert solo si se pasa', () => {
    const base = { host: 'db.interna', port: 5432, database: 'd', user: 'u', password: 'p' };
    expect(
      buildDatabaseUrl({ ...base, sslmode: 'verify-full', sslrootcert: '/etc/chatbot/db-ca.crt' }),
    ).toBe(
      'postgres://u:p@db.interna:5432/d?sslmode=verify-full&sslrootcert=%2Fetc%2Fchatbot%2Fdb-ca.crt',
    );
    expect(buildDatabaseUrl({ ...base, sslmode: 'verify-full', sslrootcert: null })).toBe(
      'postgres://u:p@db.interna:5432/d?sslmode=verify-full',
    );
  });

  it('buildDatabaseUrl con defaultVerifyFull: verify-full solo con host remoto y sin sslmode', () => {
    const base = { database: 'd', user: 'u', password: 'p', port: 5432, defaultVerifyFull: true };
    expect(buildDatabaseUrl({ ...base, host: 'db.interna' })).toBe(
      'postgres://u:p@db.interna:5432/d?sslmode=verify-full',
    );
    expect(buildDatabaseUrl({ ...base, host: 'localhost' })).toBe(
      'postgres://u:p@localhost:5432/d',
    );
    expect(buildDatabaseUrl({ ...base, host: 'db.interna', sslmode: 'require' })).toBe(
      'postgres://u:p@db.interna:5432/d?sslmode=require',
    );
    expect(classifyDatabaseUrl(buildDatabaseUrl({ ...base, host: 'db.interna' }))).toMatchObject({
      verifiedTls: true,
    });
  });

  it('probeUrl conserva sslmode y sslrootcert de la URL de administración (R3)', () => {
    const probe = probeUrl(
      'postgres://admin:x@db.interna:6000/postgres?sslmode=verify-full&sslrootcert=/home/op/ca.crt',
      databaseNames('demo-02'),
      'clave',
    );
    const u = new URL(probe);
    expect(u.hostname).toBe('db.interna');
    expect(u.port).toBe('6000');
    expect(u.pathname).toBe('/chatbot_demo_02');
    expect(u.searchParams.get('sslmode')).toBe('verify-full');
    expect(u.searchParams.get('sslrootcert')).toBe('/home/op/ca.crt');
  });

  it('describeAdminUrl solo muestra servidor y puerto', () => {
    expect(describeAdminUrl('postgres://admin:clave-secreta@DB.Interna:6000/postgres')).toBe(
      'db.interna:6000',
    );
    expect(describeAdminUrl('postgres://admin:x@host/postgres')).toBe('host:5432');
  });

  it('los errores de pg se traducen a códigos sin su texto', () => {
    const error = Object.assign(new Error('password authentication failed for postgres://a:b@c'), {
      code: '28P01',
    });
    expect(translatePgError(error, 'connect')).toEqual({
      code: 'admin_connect_failed',
      step: 'connect',
    });
    expect(translatePgError({ code: '42501' }, 'role')).toEqual({
      code: 'permission_denied',
      step: 'role',
    });
    expect(translatePgError({ code: 'XX000' }, 'revoke')).toEqual({
      code: 'step_failed',
      step: 'revoke',
    });
    expect(translatePgError(new Error('x'), 'probe')).toEqual({
      code: 'probe_failed',
      step: 'probe',
    });
  });
});
