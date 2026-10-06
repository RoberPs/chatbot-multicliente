import { describe, expect, it } from 'vitest';
import {
  InstanceBusyError,
  MigrationBlockedError,
  MigrationFailedError,
} from '../../../src/backup/errors.js';
import { DatabaseConfigError } from '../../../src/config/database-url.js';
import { CoreVersionError } from '../../../src/health/version.js';
import { startupErrorMessage } from '../../../src/startup.js';

describe('startupErrorMessage (013, contracts/database-tls.md)', () => {
  it('los errores propios del arranque muestran su mensaje', () => {
    expect(startupErrorMessage(new InstanceBusyError())).toBe(
      'Hay una restauración en curso o la instancia ya está en marcha',
    );
    const blocked = new MigrationBlockedError(['0012_x'], 'db_error');
    expect(startupErrorMessage(blocked)).toBe(blocked.message);
    const failed = new MigrationFailedError(['0012_x'], 'copia.cbak', '0011_y');
    expect(startupErrorMessage(failed)).toBe(failed.message);
    const version = new CoreVersionError('No se encuentra el package.json del núcleo');
    expect(startupErrorMessage(version)).toBe(version.message);
  });

  it('DatabaseConfigError: mensaje y acción', () => {
    expect(startupErrorMessage(new DatabaseConfigError('ca_unreadable', 'DATABASE_URL'))).toBe(
      'DATABASE_URL: no se puede leer el certificado de la autoridad indicado en sslrootcert.\n→ Monta el fichero en el contenedor (solo lectura) y comprueba la ruta y sus permisos.',
    );
  });

  it('un error TLS de Node nunca muestra su texto (host y nombres del certificado)', () => {
    const tls = Object.assign(
      new Error(
        "Hostname/IP does not match certificate's altnames: IP: 127.0.0.1 is not in the cert's list: DNS:localhost",
      ),
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    );
    const text = startupErrorMessage(tls);
    expect(text).toBe(
      'DATABASE_URL: el certificado del servidor no es válido para ese nombre o no lo firma una autoridad de confianza.\n→ Revisa el nombre del servidor en la URL y sslrootcert.',
    );
    expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it('cualquier otro error: el texto fijo de unreachable, nunca error.message', () => {
    const text = startupErrorMessage(
      new Error('password authentication failed for user "chatbot_x" at db.interna'),
    );
    expect(text).toBe(
      'DATABASE_URL: no se puede conectar con la base de datos.\n→ Comprueba que el servidor está en marcha y accesible desde la instancia.',
    );
    expect(startupErrorMessage('texto suelto db.interna')).not.toContain('db.interna');
  });
});
