/**
 * Enlaces pulsables en las respuestas del bot (004 FR-020a, research R15).
 *
 * Solo parte el texto en trozos `{ text, href? }`; quien pinta (`frame.js`) crea los nodos con
 * `createElement` y `textContent`. La expresión es la de `displayLinks`
 * (`src/conversation/link-rule.ts`, 012): el servidor sustituye el marcador al servir el fichero.
 * Sin ella (el fichero tal cual), no se pinta ningún enlace.
 */
(function () {
  'use strict';

  var RULE = /*__LINK_RULE__*/ null;

  /** Misma comprobación que el campo "Enlace a mapa" del panel. */
  function isSafeHttpsUrl(value) {
    var url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      url.protocol === 'https:' &&
      url.hostname.indexOf('.') !== -1 &&
      !url.username &&
      !url.password
    );
  }

  /** Parte el texto en trozos de texto y enlaces `https://`. Los trozos unidos son el original. */
  function split(text) {
    if (!RULE) return text === '' ? [] : [{ text: text }];
    var candidate = new RegExp(RULE.candidate, RULE.flags);
    var trailing = new RegExp(RULE.trailing);
    var parts = [];
    var last = 0;
    var match;
    while ((match = candidate.exec(text)) !== null) {
      var url = match[0].replace(trailing, '');
      if (url === '' || !isSafeHttpsUrl(url)) continue;
      if (match.index > last) parts.push({ text: text.slice(last, match.index) });
      parts.push({ text: url, href: url });
      last = match.index + url.length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts;
  }

  window.ChatLinks = { split: split };
})();
