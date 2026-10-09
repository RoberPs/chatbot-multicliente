/**
 * Motivos de la comprobación de copias (016, T028; FR-008, FR-012,
 * contracts/backup-verify-socket.md §3).
 *
 * La regla que se comprueba aquí es la de **no mentir**: un fallo ocurrido en una capa nunca se
 * atribuye a otra. Antes de la 016 un solo código, `verify_db_unavailable`, cubría las tres
 * capas —dirección, conexión y creación— y su mensaje decía «no se pudo crear la base de datos
 * temporal» incluso cuando la conexión y la creación habían funcionado y lo que fallaba era
 * interpretar la dirección. Eso es lo que despistó durante la fase 9 del despliegue.
 */
import { describe, expect, it } from 'vitest';
import type { RestoreFailureCode } from '../../../src/backup/errors.js';
import { restoreFailureMessage, restoreFailureReasons } from '../../../src/cli/backup-common.js';
import { RestoreFailure } from '../../../src/backup/errors.js';

/** Los tres motivos de la comprobación, uno por capa. */
const VERIFY_CODES = ['verify_url_invalid', 'verify_db_unavailable', 'verify_db_create_failed'] as const;

/** Motivos que son **de la copia**: no pueden confundirse con los de la comprobación. */
const BACKUP_CODES = [
  'not_a_backup',
  'unsupported_format',
  'wrong_key',
  'corrupted',
  'other_instance',
  'schema_newer',
  'schema_mismatch',
  'count_mismatch',
] as const;

const message = (code: RestoreFailureCode) =>
  restoreFailureMessage(new RestoreFailure(code), 'BACKUP_VERIFY_URL');

describe('cada capa tiene su motivo (FR-008)', () => {
  it('la dirección ininterpretable habla de la dirección, no de crear ni de conectar', () => {
    expect(restoreFailureReasons.verify_url_invalid).toBe(
      'BACKUP_VERIFY_URL no se puede interpretar',
    );
    const text = message('verify_url_invalid');
    expect(text).toContain('no se puede interpretar');
    expect(text).not.toContain('crear');
    expect(text).not.toContain('conectar');
  });

  it('el fallo de conexión habla de conectar, no de crear', () => {
    expect(restoreFailureReasons.verify_db_unavailable).toBe(
      'no se pudo conectar con el servidor de verificación',
    );
    const text = message('verify_db_unavailable');
    expect(text).toContain('conectar');
    // Es el texto que despistaba: la conexión fallaba y el mensaje culpaba a la creación.
    expect(text).not.toContain('crear la base de datos temporal');
  });

  it('el fallo de creación habla de crear y de CREATEDB', () => {
    expect(restoreFailureReasons.verify_db_create_failed).toBe(
      'no se pudo crear la base de datos temporal',
    );
    const text = message('verify_db_create_failed');
    expect(text).toContain('crear la base de datos temporal');
    expect(text).toContain('CREATEDB');
  });

  it('los tres motivos son distintos entre sí, en el corto y en el largo', () => {
    const shorts = VERIFY_CODES.map((c) => restoreFailureReasons[c]);
    const longs = VERIFY_CODES.map(message);
    expect(new Set(shorts).size).toBe(3);
    expect(new Set(longs).size).toBe(3);
  });
});

describe('no se mezclan con los motivos de la copia', () => {
  it.each(BACKUP_CODES)('%s no menciona la comprobación ni su servidor', (code) => {
    const text = message(code);
    for (const word of ['BACKUP_VERIFY_URL', 'servidor de verificación', 'base de datos temporal']) {
      expect(text).not.toContain(word);
    }
  });

  it.each(VERIFY_CODES)('%s no suena a un problema de la copia', (code) => {
    const text = message(code);
    for (const word of ['dañada', 'otra clave', 'no es una copia', 'esquema']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('los códigos de TLS de la 013 conservan el suyo', () => {
  it.each(['db_ca_unreadable', 'db_tls_untrusted', 'db_tls_unsupported'] as const)(
    '%s sigue nombrando la variable y su causa',
    (code) => {
      const text = message(code);
      expect(text).toContain('BACKUP_VERIFY_URL');
      expect(text).not.toContain('base de datos temporal');
    },
  );
});

describe('ningún texto lleva datos de la dirección (FR-012)', () => {
  const all: RestoreFailureCode[] = [...VERIFY_CODES, ...BACKUP_CODES];

  it.each(all)('%s', (code) => {
    const texts = [restoreFailureReasons[code], message(code)];
    for (const text of texts) {
      for (const secret of ['postgres://', 'host=', '/var/run', '127.0.0.1', '5432', '@']) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
