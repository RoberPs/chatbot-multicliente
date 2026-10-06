/**
 * Texto de `/chat/design.css` (011, research R2): un único bloque `:root { … }` con las
 * propiedades personalizadas del tema. Nunca lleva texto del operador: cada nombre es de la lista
 * cerrada y cada valor, un color ya validado, una medida de las tablas o la URL de una imagen
 * guardada (FR-004, FR-040).
 */
import { CSS_TOKENS, type Theme } from './theme.js';

const SAFE_VALUE =
  /^(#[0-9a-f]{6}|0|\d{1,3}px|50%|url\(\/chat\/design\/avatar\/[0-9a-f]{16}\.(png|jpg|webp)\))$/;

export function renderDesignCss(theme: Theme): string {
  const entries = Object.entries(theme.tokens);
  if (entries.length === 0) return '';
  const lines = entries.map(([name, value]) => {
    if (!(CSS_TOKENS as readonly string[]).includes(name) || !SAFE_VALUE.test(value)) {
      throw new Error(`Token de diseño no permitido: ${name}`);
    }
    return `  ${name}: ${value};`;
  });
  return `:root {\n${lines.join('\n')}\n}\n`;
}
