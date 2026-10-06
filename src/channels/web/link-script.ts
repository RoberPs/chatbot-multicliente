/**
 * `links.js` tal como se sirve (012, FR-031): con la expresión de `displayLinks` en lugar del
 * marcador, para que el chat web pinte exactamente lo mismo que «Probar el bot».
 */
import { DISPLAY_LINK_RULE } from '../../conversation/link-rule.js';

export const LINK_RULE_MARKER = '/*__LINK_RULE__*/ null';

export function injectLinkRule(source: string): string {
  if (!source.includes(LINK_RULE_MARKER))
    throw new Error('links.js no tiene el marcador de la regla');
  return source.replace(LINK_RULE_MARKER, JSON.stringify(DISPLAY_LINK_RULE));
}
