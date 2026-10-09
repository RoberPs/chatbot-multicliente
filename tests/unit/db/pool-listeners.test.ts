/**
 * Inventario de los puntos que abren conexiones a PostgreSQL (016, T037; **criterio verificable
 * de FR-005**).
 *
 * Por qué una prueba estática y no de comportamiento: el fallo 1 no era un error de lógica sino
 * un **descuido sistemático**. Un `pg.Pool` o un `pg.Client` que emite `error` sin ningún oyente
 * lanza esa excepción como no capturada y Node **termina el proceso**; con la base de datos
 * caída, eso les pasa a todas las conexiones ociosas a la vez. Corregir solo el punto donde se
 * vio dejaba los otros siete expuestos, y el siguiente despliegue habría encontrado el mismo
 * fallo en otro sitio.
 *
 * Así que lo que se vigila es que **ninguna** construcción de `pg.Pool` ni de `pg.Client` en
 * `src/` quede sin su oyente de `error`. Si alguien añade una, esta prueba falla y dice en qué
 * fichero y en qué línea.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

/**
 * Los ocho puntos del inventario de research R1, comprobados contra el código real. Está aquí
 * como referencia de lo que se revisó: si aparece uno nuevo, el recuento cambia y hay que
 * mirarlo a conciencia, no solo añadirlo a la lista.
 */
const INVENTORY = [
  'backup/locks.ts',
  'backup/service.ts', // dos: el de las copias y el administrador de la verificación
  'cli/backup-common.ts',
  'db/client.ts',
  'db/migrate.ts',
  'health/report.ts',
  'provisioning/database.ts',
];

interface Construction {
  file: string;
  line: number;
  text: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

/** Construcciones de `pg.Pool` y `pg.Client` en `src/`, con su fichero y su línea. */
function constructions(): Construction[] {
  const found: Construction[] = [];
  for (const path of walk(SRC)) {
    const relative = path.slice(SRC.length + 1).replaceAll('\\', '/');
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (/new\s+pg\.(Pool|Client)\s*\(/.test(text)) {
        found.push({ file: relative, line: index + 1, text: text.trim() });
      }
    });
  }
  return found;
}

/**
 * ¿Hay un oyente de `error` registrado **antes del primer uso** de la conexión?
 *
 * No basta con que exista en alguna parte del fichero: tiene que ir entre la construcción y la
 * primera llamada a `connect()` o `query()`, porque cualquier hueco entre las dos es una ventana
 * en la que un fallo de conexión termina el proceso. Es el defecto que corrige T042 en
 * `backup/locks.ts`, donde el oyente estaba después de conectar.
 */
function listenerBeforeFirstUse(path: string, line: number): boolean {
  const lines = readFileSync(join(SRC, path), 'utf8').split('\n');
  const declaration = lines[line - 1] ?? '';
  const variable = /(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+pg\./.exec(declaration);
  const name = variable?.[1];
  // Construcción sin variable (`connect(new pg.Client(...))`): no puede tener oyente.
  if (name === undefined) return false;

  const after = lines.slice(line - 1);
  const listener = new RegExp(`${name}\\.on\\(\\s*['"]error['"]`);
  const firstUse = new RegExp(`${name}\\.(connect|query)\\(`);
  const listenerAt = after.findIndex((text) => listener.test(text));
  const useAt = after.findIndex((text) => firstUse.test(text));
  if (listenerAt === -1) return false;
  // Sin uso visible (el pool lo usa Drizzle), basta con que el oyente exista.
  return useAt === -1 || listenerAt < useAt;
}

describe('inventario de conexiones a PostgreSQL (FR-005)', () => {
  const all = constructions();

  it('hay construcciones que vigilar (la prueba no se queda en vacío)', () => {
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it('todas están en los ficheros del inventario de research R1', () => {
    const unexpected = all.filter((c) => !INVENTORY.includes(c.file));
    const detail = unexpected.map((c) => `${c.file}:${String(c.line)} → ${c.text}`).join('\n');
    expect(
      unexpected,
      `Hay una conexión a PostgreSQL en un fichero que no está en el inventario de la 016.\n` +
        `Revisa que trate el fallo de una conexión ociosa sin terminar el proceso y añádela\n` +
        `al inventario de research R1 y de esta prueba:\n${detail}`,
    ).toEqual([]);
  });

  it('ninguna queda sin su oyente de error antes de su primer uso', () => {
    const naked = all.filter((c) => !listenerBeforeFirstUse(c.file, c.line));
    const detail = naked.map((c) => `${c.file}:${String(c.line)} → ${c.text}`).join('\n');
    expect(
      naked,
      `Una conexión a PostgreSQL sin oyente de \`error\`: cuando la base de datos se cae, su\n` +
        `conexión ociosa emite \`error\`, nadie lo recoge y Node TERMINA EL PROCESO (016,\n` +
        `FR-001, FR-005). Añade \`.on('error', …)\` justo después de construirla, antes de\n` +
        `conectar:\n${detail}`,
    ).toEqual([]);
  });
});
