/**
 * Interfaz del chat web dentro del iframe (004).
 *
 * De momento solo abre y cierra el panel y avisa a la web que lo aloja del tamaño que necesita
 * (`chat:resize`, contracts/web-chat-http.md). La conversación (sesión, envío y sondeo de
 * respuestas) se añade con la historia 3.
 *
 * Todo el contenido que venga del visitante o del bot se escribe siempre con `textContent`.
 */
(function () {
  'use strict';

  var toggle = document.getElementById('chat-toggle');
  var panel = document.getElementById('chat-panel');
  var close = document.getElementById('chat-close');
  if (!toggle || !panel) return;

  /**
   * Avisa a la web que aloja el iframe del tamaño que necesita el chat. Va a cualquier origen
   * porque el iframe no sabe cuál es el de la página que lo incrusta; el mensaje solo dice si
   * el chat está abierto, nunca contenido de la conversación. El widget, por su parte, sí
   * comprueba el origen de los mensajes que recibe.
   */
  function tellParent(open) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'chat:resize', open: open }, '*');
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggle.hidden = open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    tellParent(open);
    if (open) {
      var box = document.getElementById('chat-text');
      if (box) box.focus();
    } else {
      toggle.focus();
    }
  }

  toggle.addEventListener('click', function () {
    setOpen(true);
  });
  if (close) {
    close.addEventListener('click', function () {
      setOpen(false);
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  });

  setOpen(false);
})();
