/**
 * Ficheros de entorno de las instancias (007, research R7 y R8): lectura con el mismo analizador
 * que `process.loadEnvFile` (`util.parseEnv`), sin tocar `process.env`; generación desde la
 * plantilla sin sobrescribir nunca un fichero, y reescritura atómica de `DATABASE_URL`.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { writeFileAtomic } from './inventory.js';
import { ProvisioningError } from './messages.js';

/** Variables leídas de un fichero de entorno, tal como las ve el arranque. */
export type EnvMap = Record<string, string>;

/** Lee y analiza un fichero de entorno; si no se puede, `env_unreadable` sin su contenido. */
export function parseEnvFile(path: string): EnvMap {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ProvisioningError('env_unreadable', { path });
  }
  return parseEnvText(text);
}

export function parseEnvText(text: string): EnvMap {
  return { ...parseEnv(text) } as EnvMap;
}

// ---------------------------------------------------------------------------
// Generación desde la plantilla (R7)
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Nombre de la variable de una línea `VAR=valor`, o `null`. */
export function lineVariable(line: string): string | null {
  return ASSIGNMENT.exec(line)?.[1] ?? null;
}

/** Valor tal como se escribe: entre comillas dobles si lleva espacios, `#` o comillas. */
function formatValue(value: string): string {
  return /[\s#"'`\\]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/**
 * Procesa la plantilla línea a línea: conserva comentarios y orden, sustituye las variables con
 * valor aportado, deja vacías las pendientes con `# PENDIENTE: <quién>` justo encima y copia el
 * resto con su valor por defecto (también las variables nuevas que la herramienta no conoce).
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
  pending: Record<string, string>,
  header: string[],
): string {
  const eol = template.includes('\r\n') ? '\r\n' : '\n';
  const out = header.map((line) => `# ${line}`);
  if (out.length > 0) out.push('');
  for (const line of template.split(/\r?\n/)) {
    const variable = lineVariable(line);
    if (variable !== null && variable in pending) {
      out.push(`# PENDIENTE: ${pending[variable] ?? ''}`, `${variable}=`);
    } else if (variable !== null && variable in values) {
      out.push(`${variable}=${formatValue(values[variable] ?? '')}`);
    } else out.push(line);
  }
  return out.join(eol);
}

// ---------------------------------------------------------------------------
// Reescritura de una variable (R8, FR-021)
// ---------------------------------------------------------------------------

function fileMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

/**
 * Da valor a una variable vacía de un entorno existente: reemplaza solo su línea (y el
 * `# PENDIENTE` justo encima), conserva el resto byte a byte y el modo, y escribe de forma
 * atómica. Si ya tiene valor, `database_url_set` salvo con `overwrite` (rotación del secreto de
 * salud, 009). Devuelve el contenido anterior para poder restaurarlo si lo que sigue falla.
 */
export async function setVariable(
  path: string,
  variable: string,
  value: string,
  options: { overwrite?: boolean } = {},
): Promise<string> {
  let original: string;
  try {
    original = readFileSync(path, 'utf8');
  } catch {
    throw new ProvisioningError('env_unreadable', { path });
  }
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const index = lines.findIndex((line) => lineVariable(line) === variable);
  if (
    index >= 0 &&
    options.overwrite !== true &&
    (parseEnvText(lines[index] ?? '')[variable] ?? '').trim() !== ''
  ) {
    throw new ProvisioningError('database_url_set', { path });
  }
  const line = `${variable}=${formatValue(value)}`;
  if (index < 0) {
    const last = lines.length - 1;
    if (lines[last] === '') lines.splice(last, 0, line);
    else lines.push(line);
  } else {
    lines[index] = line;
    if (index > 0 && /^#\s*PENDIENTE:/.test(lines[index - 1] ?? '')) lines.splice(index - 1, 1);
  }
  await writeFileAtomic(path, lines.join(eol), fileMode(path));
  return original;
}

/** Vuelve a dejar un entorno como estaba (tras un fallo de `instance:db`). */
export async function restoreEnvFile(path: string, content: string): Promise<void> {
  await writeFileAtomic(path, content, fileMode(path));
}

/** Escribe un entorno nuevo sin sobrescribir nunca uno existente, legible solo por su dueño. */
export function writeNewEnvFile(path: string, content: string): void {
  try {
    writeFileSync(path, content, { flag: 'wx', mode: 0o600, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ProvisioningError('output_exists', { path });
    }
    throw new ProvisioningError('write_failed', { path });
  }
}
