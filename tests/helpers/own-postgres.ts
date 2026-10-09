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
 * puerto cambia. Con `pg_ctl` el puerto publicado no se mueve y la instancia bajo prueba
 * conserva su `DATABASE_URL` durante todo el corte: es lo que permite comprobar también la
 * recuperación sin reiniciar nada (FR-004).
 *
 * Y por qué se cambia el proceso principal del contenedor: en la imagen oficial, PostgreSQL
 * **es** el proceso principal, así que pararlo mata el contenedor y con él el puerto publicado.
 * Aquí el proceso principal es un `sleep` que no se va a morir nunca, y PostgreSQL arranca a su
 * lado con el mismo script de la imagen (`docker-entrypoint.sh`, que hace el `initdb` y crea el
 * usuario y la base de la primera vez). Así el contenedor sobrevive a que su PostgreSQL se
 * pare, que es justamente lo que esta prueba necesita reproducir.
 */
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/** `PGDATA` de la imagen oficial; `pg_ctl` solo funciona como el usuario `postgres`. */
const PGDATA = '/var/lib/postgresql/data';
const AS_POSTGRES = { user: 'postgres' } as const;
const USER = 'postgres';
const PASSWORD = 'postgres';

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
  container: StartedTestContainer,
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
  const container = await new GenericContainer('postgres:16')
    .withEnvironment({
      POSTGRES_USER: USER,
      POSTGRES_PASSWORD: PASSWORD,
      POSTGRES_DB: 'postgres',
    })
    .withExposedPorts(5432)
    // `sleep infinity` es el proceso principal; PostgreSQL arranca a su lado y puede pararse
    // sin que el contenedor —ni el puerto publicado— se vayan con él.
    .withEntrypoint(['/bin/bash', '-c'])
    .withCommand(['docker-entrypoint.sh postgres & sleep infinity'])
    // El `initdb` de la primera vez tarda: se espera a que el puerto escuche de verdad.
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminUrl = `postgres://${USER}:${PASSWORD}@${host}:${String(port)}/postgres`;

  const isUp = async (): Promise<boolean> => {
    const { exitCode } = await run(container, ['pg_isready', '-q'], { allowFailure: true });
    return exitCode === 0;
  };

  /**
   * Confirma que el servidor llegó al estado pedido.
   *
   * `pg_ctl -w` ya espera por su cuenta, así que esto normalmente acierta en el primer intento y
   * no hay que sondear. Se sondea **cada segundo**, no más rápido: cada comprobación es un
   * `docker exec`, que en Windows cuesta bastante, y sondear en bucle apretado le quitaba CPU a
   * los demás proyectos de la suite, que corren en paralelo con este.
   */
  const waitUntil = async (up: boolean, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await isUp()) === up) return;
      if (Date.now() > deadline) {
        throw new Error(`PostgreSQL no llegó a estar ${up ? 'arriba' : 'abajo'} en ${timeoutMs} ms`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  // La primera vez, `pg_isready` puede responder antes de que el script termine de crear el
  // usuario y la base: se espera a que esté todo listo antes de devolver el control.
  await waitUntil(true);

  return {
    adminUrl,
    url: (database) => `postgres://${USER}:${PASSWORD}@${host}:${String(port)}/${database}`,
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
