/**
 * Ayudas mínimas del panel que no puede dar htmx (004). Sin JavaScript sigue funcionando todo:
 * el fragmento del chat web se puede seleccionar y copiar a mano.
 */
(function () {
  'use strict';

  /** Botón "Copiar": copia al portapapeles y, si no se puede, selecciona el texto. */
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    var field = document.querySelector(button.getAttribute('data-copy'));
    if (!field) return;
    field.focus();
    field.select();
    var done = function () {
      var label = button.getAttribute('data-copied');
      if (label) button.textContent = label;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(field.value).then(done, function () {
        // Sin permiso para el portapapeles: el texto queda seleccionado para copiarlo a mano.
      });
    }
  });
})();
