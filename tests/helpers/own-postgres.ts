/**
 * Contenedor PostgreSQL 16 **propio** de un fichero de test, con el servidor parable por dentro
 * (016, FR-010, research R9).
 *
 * Por qué no vale el contenedor compartido de `tests/helpers/global-setup.ts`: pararlo dejaría
 * sin base de datos a todos los demás ficheros de test, que van en paralelo. Quien use este
 * ayudante para y arranca un servidor a voluntad, así que necesita el suyo.
 *
 * Por qué se para **por dentro** con `pg_ctl` y no con `container.stop()`: Docker publica el
 * puerto del contenedor en un puerto libre del equipo, y al volver a arrancar el contenedor ese
 * puerto cambia. Con `pg_ctl` el contenedor sigue vivo, el puerto publicado no se mueve y la
 * instancia bajo prueba conserva su `DATABASE_URL` durante todo el corte: es lo que permite
 * comprobar también la recuperación sin reiniciar nada (FR-004).
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/** `PGDATA` de la imagen oficial; `pg_ctl` solo funciona como el usuario `postgres`. */
const PGDATA = '/var/lib/postgresql/data';
const AS_POSTGRES = { user: 'postgres' } as const;

export interface OwnPostgres {
  /** URL de administración (base `postgres`), con el puerto publicado, estable todo el test. */
  adminUrl: string;
  /** La misma URL apuntando a otra base del mismo servidor. */
  url: (database: string) => string;
  /** Para el servidor dentro del contenedor: las conexiones abiertas se caen. */
  stopServer: () => Promise<void>;
  /** Arranca el servidor y espera a que acepte conexiones. */
  startServer: () => Promise<void>;
  /** `true` si el servidor está aceptando conexiones ahora mismo. */
  isUp: () => Promise<boolean>;
  /** Tira el contenedor. */
  stop: () => Promise<void>;
}

async function run(
  container: StartedPostgreSqlContainer,
  command: string[],
  { allowFailure = false } = {},
): Promise<{ exitCode: number; output: string }> {
  const result = await container.exec(command, AS_POSTGRES);
  if (!allowFailure && result.exitCode !== 0) {
    // El mensaje no lleva ninguna dirección de base de datos (FR-012): solo la orden y su salida.
    throw new Error(`${command.join(' ')} salió con ${result.exitCode}: ${result.output.trim()}`);
  }
  return { exitCode: result.exitCode, output: result.output };
}

/** Levanta el contenedor propio. Pensado para un `beforeAll`, con `stop()` en el `afterAll`. */
export async function startOwnPostgres(): Promise<OwnPostgres> {
  const container = await new PostgreSqlContainer('postgres:16').start();
  const adminUrl = container.getConnectionUri();

  const isUp = async (): Promise<boolean> => {
    const { exitCode } = await run(container, ['pg_isready', '-q'], { allowFailure: true });
    return exitCode === 0;
  };

  /** Espera a que el servidor llegue al estado pedido, sondeando cada 200 ms. */
  const waitUntil = async (up: boolean, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await isUp()) === up) return;
      if (Date.now() > deadline) {
        throw new Error(`PostgreSQL no llegó a estar ${up ? 'arriba' : 'abajo'} en ${timeoutMs} ms`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  return {
    adminUrl,
    url: (database) => {
      const u = new URL(adminUrl);
      u.pathname = `/${database}`;
      return u.toString();
    },
    // `-m fast`: corta las conexiones abiertas en lugar de esperar a que se cierren, que es lo
    // que hace un servidor que desaparece de verdad.
    stopServer: async () => {
      await run(container, ['pg_ctl', '-D', PGDATA, '-m', 'fast', '-w', 'stop']);
      await waitUntil(false);
    },
    startServer: async () => {
      await run(container, ['pg_ctl', '-D', PGDATA, '-w', 'start']);
      await waitUntil(true);
    },
    isUp,
    stop: async () => {
      await container.stop();
    },
  };
}
