/**
 * Preferencia de tema del panel (014). Módulo puro: entra y sale texto, y las cabeceras las
 * manejan las rutas. La preferencia vive en una cookie del navegador del operador: no es
 * configuración del negocio, no se exporta y no entra en las copias de seguridad (FR-010).
 *
 * La cookie no se firma ni se cifra porque no autoriza nada: lo peor que puede conseguir quien la
 * manipule es ver el panel en el otro tema.
 */

/** Lo que el operador elige en el control. */
export type ThemeChoice = 'auto' | 'light' | 'dark';
/** Lo que se guarda en la cookie: `auto` no se guarda, se borra. */
export type StoredTheme = 'light' | 'dark';

export const THEME_COOKIE = 'kb_theme';
/** Un año. */
const MAX_AGE = 31_536_000;
/** `Path=/admin` cubre también `/admin/login`, donde el control existe sin sesión. */
const PATH = '/admin';

export const THEME_CHOICES = ['auto', 'light', 'dark'] as const;

/**
 * Tema guardado en la cabecera de cookie, o `null` si falta, está vacío o no se reconoce
 * (FR-011). Si la cookie viene repetida manda la primera, que es la de la ruta más concreta.
 */
export function themeFromCookieHeader(header: string | undefined): StoredTheme | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== THEME_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return value === 'light' || value === 'dark' ? value : null;
  }
  return null;
}

/** Cabecera `Set-Cookie` que guarda la elección, o que borra la cookie en automático. */
export function themeCookieHeader(
  choice: ThemeChoice,
  { production }: { production: boolean },
): string {
  const stored = choice === 'auto' ? '' : choice;
  const maxAge = choice === 'auto' ? 0 : MAX_AGE;
  return [
    `${THEME_COOKIE}=${stored}`,
    `Path=${PATH}`,
    `Max-Age=${String(maxAge)}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(production ? ['Secure'] : []),
  ].join('; ');
}

/**
 * Destino al que volver sin JavaScript, comprobado para que no sea una redirección abierta: solo
 * rutas del panel, sin `//` ni `:` y sin espacios ni saltos de línea (que además irían a una
 * cabecera `Location`). Cualquier otra cosa vuelve a la portada.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string') return PATH;
  if (!next.startsWith(PATH)) return PATH;
  if (next.includes('//') || next.includes(':')) return PATH;
  if (/\s/.test(next)) return PATH;
  return next;
}
