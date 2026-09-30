import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProvisioningError } from '../../../src/provisioning/messages.js';
import {
  parseEnvFile,
  parseEnvText,
  renderTemplate,
  restoreEnvFile,
  setVariable,
  writeNewEnvFile,
} from '../../../src/provisioning/env-file.js';
import { templatePath } from '../../../src/provisioning/repo-paths.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'env-file-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAMPLE = [
  '# comentario',
  'A=uno',
  'B="dos con espacios"',
  "C='tres # no es comentario'",
  'D=cuatro # comentario al final',
  'E=',
  '',
  'F = cinco',
  '',
].join('\n');

describe('parseEnvFile (lectura)', () => {
  it('da lo mismo que process.loadEnvFile y no toca process.env', async () => {
    const path = join(dir, 'muestra.env');
    await writeFile(path, SAMPLE);
    const before = { ...process.env };
    const parsed = parseEnvFile(path);
    expect(process.env).toEqual(before);

    const keys = Object.keys(parsed);
    try {
      process.loadEnvFile(path);
      for (const key of keys) expect(parsed[key]).toBe(process.env[key]);
    } finally {
      for (const key of keys) if (!(key in before)) Reflect.deleteProperty(process.env, key);
    }
    expect(parsed).toMatchObject({ A: 'uno', B: 'dos con espacios', D: 'cuatro', E: '' });
  });

  it('fichero inexistente → env_unreadable sin contenido', () => {
    const path = join(dir, 'no-existe.env');
    let error: unknown;
    try {
      parseEnvFile(path);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).code).toBe('env_unreadable');
    expect((error as ProvisioningError).ctx).toEqual({ path });
  });

  it('un directorio no es legible como entorno', () => {
    expect(() => parseEnvFile(dir)).toThrow(ProvisioningError);
  });
});

describe('renderTemplate (research R7)', () => {
  const template = [
    '# Cabecera de la plantilla',
    'A=por-defecto',
    '',
    '# Comentario de B',
    'B=',
    'C=valor-c',
    'NUEVA_DEL_NUCLEO=42',
    '',
  ].join('\n');

  it('conserva comentarios y orden, sustituye, marca pendientes y copia lo desconocido', () => {
    const text = renderTemplate(template, { A: 'nuevo' }, { B: 'el proveedor' }, [
      'Entorno de la instancia demo-01',
    ]);
    expect(text.split('\n')).toEqual([
      '# Entorno de la instancia demo-01',
      '',
      '# Cabecera de la plantilla',
      'A=nuevo',
      '',
      '# Comentario de B',
      '# PENDIENTE: el proveedor',
      'B=',
      'C=valor-c',
      'NUEVA_DEL_NUCLEO=42',
      '',
    ]);
  });

  it('un valor con espacios o # va entre comillas y se lee igual', () => {
    const text = renderTemplate('X=\n', { X: 'con espacio # y almohadilla' }, {}, []);
    expect(parseEnvText(text).X).toBe('con espacio # y almohadilla');
  });

  it.each([false, true])(
    'con la plantilla real (.env.example) y WhatsApp=%s tiene exactamente sus variables',
    async (whatsapp) => {
      const real = await readFile(templatePath(), 'utf8');
      const pending: Record<string, string> = { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' };
      if (whatsapp) pending.WHATSAPP_ACCESS_TOKEN = 'Meta';
      const text = renderTemplate(
        real,
        {
          NODE_ENV: 'production',
          INSTANCE_ID: 'demo-01',
          ...(whatsapp ? { WHATSAPP_VERIFY_TOKEN: 'x'.repeat(48) } : {}),
        },
        pending,
        ['cabecera'],
      );
      expect(Object.keys(parseEnvText(text)).sort()).toEqual(
        Object.keys(parseEnvText(real)).sort(),
      );
      expect(parseEnvText(text).DATABASE_URL).toBe('');
      expect(text.replaceAll('\r\n', '\n')).toContain('# PENDIENTE: x\nDATABASE_URL=');
    },
  );

  it('writeNewEnvFile nunca sobrescribe: output_exists', async () => {
    const path = join(dir, 'nuevo.env');
    writeNewEnvFile(path, 'A=1\n');
    expect(() => {
      writeNewEnvFile(path, 'A=2\n');
    }).toThrow(ProvisioningError);
    expect(await readFile(path, 'utf8')).toBe('A=1\n');
  });
});

describe('setVariable (research R8, FR-021)', () => {
  const original = [
    '# Cabecera',
    'A=1',
    '# PENDIENTE: se escribe con pnpm instance:db demo-01',
    'DATABASE_URL=',
    'B="dos"',
    '',
  ].join('\n');

  it('reemplaza solo la línea y su # PENDIENTE; el resto, byte a byte', async () => {
    const path = join(dir, 'set.env');
    await writeFile(path, original, { mode: 0o600 });
    const before = await setVariable(path, 'DATABASE_URL', 'postgres://u:p@h:5432/d');
    expect(before).toBe(original);
    expect(await readFile(path, 'utf8')).toBe(
      ['# Cabecera', 'A=1', 'DATABASE_URL=postgres://u:p@h:5432/d', 'B="dos"', ''].join('\n'),
    );
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('conserva los finales de línea CRLF', async () => {
    const path = join(dir, 'crlf.env');
    await writeFile(path, original.replaceAll('\n', '\r\n'));
    await setVariable(path, 'DATABASE_URL', 'x');
    expect(await readFile(path, 'utf8')).toBe('# Cabecera\r\nA=1\r\nDATABASE_URL=x\r\nB="dos"\r\n');
  });

  it('si ya tiene valor → database_url_set sin tocar el fichero', async () => {
    const path = join(dir, 'lleno.env');
    await writeFile(path, 'DATABASE_URL=postgres://ya@h/d\n');
    await expect(setVariable(path, 'DATABASE_URL', 'otra')).rejects.toMatchObject({
      code: 'database_url_set',
    });
    expect(await readFile(path, 'utf8')).toBe('DATABASE_URL=postgres://ya@h/d\n');
  });

  it('restoreEnvFile deja el contenido exacto de antes', async () => {
    const path = join(dir, 'restaurar.env');
    await writeFile(path, original);
    const before = await setVariable(path, 'DATABASE_URL', 'x');
    await restoreEnvFile(path, before);
    expect(await readFile(path, 'utf8')).toBe(original);
  });
});
