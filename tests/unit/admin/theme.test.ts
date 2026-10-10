/**
 * La preferencia de tema del panel (014, data-model §1): se lee de la cabecera de cookie, se
 * escribe con una cabecera `Set-Cookie` y no autoriza nada. Cualquier valor que no sea `light` ni
 * `dark` equivale a automático, sin error (FR-011).
 */
import { describe, expect, it } from 'vitest';
import {
  safeNext,
  THEME_COOKIE,
  themeCookieHeader,
  themeFromCookieHeader,
} from '../../../src/admin/theme.js';

describe('themeFromCookieHeader', () => {
  it('sin cabecera, con la cabecera vacía o sin la cookie: automático', () => {
    expect(themeFromCookieHeader(undefined)).toBeNull();
    expect(themeFromCookieHeader('')).toBeNull();
    expect(themeFromCookieHeader('kb_session=abc')).toBeNull();
  });

  it('lee los dos valores válidos', () => {
    expect(themeFromCookieHeader('kb_theme=light')).toBe('light');
    expect(themeFromCookieHeader('kb_theme=dark')).toBe('dark');
  });

  it('un valor desconocido, vacío o con otra caja es automático (FR-011)', () => {
    expect(themeFromCookieHeader('kb_theme=morado')).toBeNull();
    expect(themeFromCookieHeader('kb_theme=')).toBeNull();
    expect(themeFromCookieHeader('kb_theme=DARK')).toBeNull();
    expect(themeFromCookieHeader('kb_theme')).toBeNull();
  });

  it('la encuentra rodeada de otras cookies y con espacios', () => {
    expect(themeFromCookieHeader('kb_session=abc; kb_theme=dark; kb_device=xyz')).toBe('dark');
    expect(themeFromCookieHeader('  kb_theme = dark ; kb_session=abc')).toBe('dark');
  });

  it('con la cookie repetida manda la primera, que es la de la ruta más concreta', () => {
    expect(themeFromCookieHeader('kb_theme=dark; kb_theme=light')).toBe('dark');
    expect(themeFromCookieHeader('kb_theme=morado; kb_theme=dark')).toBeNull();
  });

  it('no se confunde con una cookie cuyo nombre acaba igual', () => {
    expect(themeFromCookieHeader('otro_kb_theme=dark')).toBeNull();
    expect(themeFromCookieHeader('kb_theme_previo=dark')).toBeNull();
  });
});

describe('themeCookieHeader', () => {
  it('guarda la elección un año, con Path=/admin para que cubra el acceso', () => {
    expect(themeCookieHeader('dark', { production: false })).toBe(
      `${THEME_COOKIE}=dark; Path=/admin; Max-Age=31536000; HttpOnly; SameSite=Lax`,
    );
    expect(themeCookieHeader('light', { production: false })).toBe(
      `${THEME_COOKIE}=light; Path=/admin; Max-Age=31536000; HttpOnly; SameSite=Lax`,
    );
  });

  it('en automático borra la cookie con Max-Age=0', () => {
    expect(themeCookieHeader('auto', { production: false })).toBe(
      `${THEME_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
  });

  it('en producción añade Secure, y solo ahí', () => {
    expect(themeCookieHeader('dark', { production: true })).toBe(
      `${THEME_COOKIE}=dark; Path=/admin; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(themeCookieHeader('auto', { production: true })).toMatch(/; Secure$/);
    expect(themeCookieHeader('dark', { production: false })).not.toMatch(/Secure/);
  });
});

describe('safeNext', () => {
  it('acepta rutas del panel', () => {
    expect(safeNext('/admin')).toBe('/admin');
    expect(safeNext('/admin/hours')).toBe('/admin/hours');
    expect(safeNext('/admin/services/abc?x=1')).toBe('/admin/services/abc?x=1');
    expect(safeNext('/admin/login')).toBe('/admin/login');
  });

  it('rechaza cualquier destino fuera del panel y cae en /admin', () => {
    expect(safeNext('//evil.com')).toBe('/admin');
    expect(safeNext('http://evil.com')).toBe('/admin');
    expect(safeNext('/admin//evil.com')).toBe('/admin');
    expect(safeNext('/chat')).toBe('/admin');
    expect(safeNext('')).toBe('/admin');
    expect(safeNext(undefined)).toBe('/admin');
    expect(safeNext(42)).toBe('/admin');
    expect(safeNext('/admin/hours:8080')).toBe('/admin');
  });

  it('rechaza un destino con espacios o saltos de línea (cabecera Location)', () => {
    expect(safeNext('/admin/hours\nSet-Cookie: x=1')).toBe('/admin');
    expect(safeNext('/admin/ho urs')).toBe('/admin');
  });
});
