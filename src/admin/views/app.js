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
  /**
   * Tema del panel (014, R6): al cambiar la opción se aplica al momento, sin recargar y sin perder
   * lo escrito en un formulario a medio rellenar (FR-007). htmx manda el POST por detrás, que solo
   * guarda la cookie. En automático se quita el atributo para que vuelva a mandar el sistema.
   */
  document.addEventListener('change', function (event) {
    var input = event.target.closest('.theme-switch input[name="theme"]');
    if (!input) return;
    var root = document.documentElement;
    if (input.value === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', input.value);
  });
})();
