import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractSemanticVersion,
  isSemanticVersion,
  readCoreVersion,
} from '../../../src/health/version.js';

describe('isSemanticVersion (009, R4)', () => {
  it.each(['1.4.0', '0.1.0', '10.20.30', '1.4.0-rc.1', '2.0.0-beta-2'])('acepta %s', (v) => {
    expect(isSemanticVersion(v)).toBe(true);
  });

  it.each(['1.4', 'v1.4.0', 'latest', '', ' 1.4.0', '1.4.0 ', '1.4.0-', 'chatbot:1.4.0'])(
    'rechaza «%s»',
    (v) => {
      expect(isSemanticVersion(v)).toBe(false);
    },
  );
});

describe('extractSemanticVersion', () => {
  it.each([
    ['chatbot:1.4.0', '1.4.0'],
    ['1.3.2', '1.3.2'],
    ['registro/chatbot:2.0.0-rc.1', '2.0.0-rc.1'],
    ['imagen 1.4.0 desplegada el 2026-10-01', '1.4.0'],
  ])('%s → %s', (text, version) => {
    expect(extractSemanticVersion(text)).toBe(version);
  });

  it.each(['chatbot:latest', 'v1.4', '', 'sin versión'])('«%s» → null', (text) => {
    expect(extractSemanticVersion(text)).toBeNull();
  });
});

describe('readCoreVersion', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'version-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sube directorios hasta el package.json del núcleo', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'chatbotasesor', version: '1.4.0' }),
    );
    // Un package.json de otro paquete en medio no cuenta.
    const nested = join(dir, 'dist', 'src', 'health');
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(dir, 'dist', 'package.json'),
      JSON.stringify({ name: 'otro', version: '9.9.9' }),
    );
    expect(readCoreVersion(nested)).toBe('1.4.0');
  });

  it('sin package.json del núcleo → error claro', async () => {
    const nested = join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    expect(() => readCoreVersion(nested)).toThrow(/package\.json del núcleo/);
  });

  it.each(['latest', '1.4', '', undefined])(
    'version no semántica (%s) → error, nunca inventa',
    async (version) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'chatbotasesor', version }),
      );
      expect(() => readCoreVersion(dir)).toThrow(/no es una versión semántica/);
    },
  );

  it('por defecto lee el package.json del repositorio', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(readCoreVersion()).toBe(pkg.version);
  });
});
