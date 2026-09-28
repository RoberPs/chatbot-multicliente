/**
 * Enlaces pulsables en las respuestas del bot (004 FR-020a, research R15).
 *
 * Solo parte el texto en trozos `{ text, href? }`; quien pinta (`frame.js`) crea los nodos con
 * `createElement` y `textContent`. Es la misma regla que `src/admin/message-links.ts`, y
 * `tests/unit/channels/message-links.test.ts` ejecuta la misma tabla de casos contra las dos.
 */
(function () {
  'use strict';

  /** Candidato: se corta donde lo hace el verificador de cifras del servidor. */
  var CANDIDATE = /https:\/\/[^\s<>"')]+/gi;
  /** Signos que cierran la frase y no forman parte del enlace. */
  var TRAILING = /[.,;:!?\]}»]+$/;

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
    var parts = [];
    var last = 0;
    var match;
    CANDIDATE.lastIndex = 0;
    while ((match = CANDIDATE.exec(text)) !== null) {
      var url = match[0].replace(TRAILING, '');
      if (!isSafeHttpsUrl(url)) continue;
      if (match.index > last) parts.push({ text: text.slice(last, match.index) });
      parts.push({ text: url, href: url });
      last = match.index + url.length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts;
  }

  window.ChatLinks = { split: split };
})();
