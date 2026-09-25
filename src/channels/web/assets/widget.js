/**
 * Fragmento que el negocio inserta en su web (004, FR-016, contracts/web-chat-http.md).
 *
 * Solo añade un iframe con el chat servido por la instancia y le cambia el tamaño cuando el
 * propio chat lo pide. No lee cookies, no mira el DOM de la web y no manda nada a ninguna parte.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script || !script.src) return;

  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch {
    return;
  }

  var CLOSED = { width: '72px', height: '72px' };
  var OPEN = { width: '380px', height: '560px' };

  var frame = document.createElement('iframe');
  frame.src = origin + '/chat/frame';
  frame.title = 'Chat con el asistente';
  frame.setAttribute('allow', '');
  frame.setAttribute('loading', 'lazy');
  frame.style.position = 'fixed';
  frame.style.right = '16px';
  frame.style.bottom = '16px';
  frame.style.border = '0';
  frame.style.zIndex = '2147483000';
  frame.style.colorScheme = 'normal';
  frame.style.maxWidth = 'calc(100vw - 32px)';
  frame.style.maxHeight = 'calc(100vh - 32px)';
  frame.style.width = CLOSED.width;
  frame.style.height = CLOSED.height;

  function resize(open) {
    var size = open ? OPEN : CLOSED;
    frame.style.width = size.width;
    frame.style.height = size.height;
  }

  window.addEventListener('message', function (event) {
    // Solo se atiende al propio chat: cualquier otro origen se ignora.
    if (event.origin !== origin) return;
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.type !== 'chat:resize') return;
    resize(data.open === true);
  });

  function insert() {
    if (document.body) document.body.appendChild(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insert);
  } else {
    insert();
  }
})();
