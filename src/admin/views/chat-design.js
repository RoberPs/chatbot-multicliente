/**
 * Vista previa en vivo de "Diseño del chat" (011, research R9, contracts/admin-chat-design.md).
 *
 * Solo actúa si en la página está el formulario de la sección. Los dos iframes de la vista previa
 * son del mismo origen: este script les cambia la hoja de diseño (calculada por el servidor en
 * `preview.css`) y escribe los textos con `textContent` o el atributo `placeholder`; nunca
 * construye HTML a partir de texto. Nada viaja ni se guarda hasta pulsar "Guardar" (FR-011).
 * Sin JavaScript no hay vista previa en vivo, pero guardar funciona igual.
 */
(function () {
  'use strict';

  var FORM_ID = 'chat-design-form';
  var DELAY_MS = 150;
  /** Campos que llegan a `preview.css`; los textos se aplican aquí. */
  var CSS_FIELDS = [
    'primary_color',
    'on_primary_color',
    'background_color',
    'text_color',
    'bot_bubble_color',
    'shape',
    'position',
    'size',
  ];
  var timer = null;

  function form() {
    return document.getElementById(FORM_ID);
  }

  function value(f, name) {
    var field = f.elements.namedItem(name);
    if (!field) return '';
    // Grupo de radios: el marcado.
    if (typeof field.value === 'string') return field.value;
    return '';
  }

  /** Texto del campo o, si está vacío, el valor por defecto que deja el servidor. */
  function textOrDefault(f, name) {
    var field = f.elements.namedItem(name);
    if (!field) return '';
    var text = field.value.trim();
    return text !== '' ? text : field.getAttribute('data-default') || '';
  }

  function previewDocuments() {
    var frames = document.querySelectorAll('iframe.chat-preview');
    var docs = [];
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentDocument) docs.push(frames[i].contentDocument);
      } catch {
        // Aún cargando o de otro origen: se aplicará al terminar de cargar.
      }
    }
    return docs;
  }

  function applyTexts(f, doc) {
    var title = doc.querySelector('.panel-head h1');
    if (title) title.textContent = textOrDefault(f, 'chat_name');
    var box = doc.getElementById('chat-text');
    if (box) box.setAttribute('placeholder', textOrDefault(f, 'placeholder'));
    var send = doc.querySelector('.composer button');
    if (send) send.textContent = textOrDefault(f, 'send_label');

    var list = doc.getElementById('chat-messages');
    if (!list) return;
    var welcome = list.querySelector('li.welcome');
    var field = f.elements.namedItem('welcome_text');
    var text = field ? field.value.replace(/\r\n?/g, '\n').trim() : '';
    if (text === '') {
      if (welcome) welcome.remove();
      return;
    }
    if (!welcome) {
      welcome = doc.createElement('li');
      welcome.className = 'welcome';
      list.insertBefore(welcome, list.firstChild);
    }
    welcome.textContent = text;
  }

  function apply() {
    timer = null;
    var f = form();
    if (!f) return;
    var params = new URLSearchParams();
    CSS_FIELDS.forEach(function (name) {
      params.set(name, value(f, name));
    });
    var href = '/admin/chat-design/preview.css?' + params.toString();
    previewDocuments().forEach(function (doc) {
      var link = doc.getElementById('chat-design-css');
      if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
      applyTexts(f, doc);
    });
  }

  function schedule() {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(apply, DELAY_MS);
  }

  /** El selector de color y su texto `#RRGGBB` van siempre a la par. */
  function syncColor(target) {
    var f = form();
    if (!f) return;
    if (target.type === 'color' && target.hasAttribute('data-color-for')) {
      var text = f.elements.namedItem(target.getAttribute('data-color-for'));
      if (text) {
        text.value = target.value;
        // El contraste en vivo (htmx) escucha el campo de texto.
        text.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (target.classList && target.classList.contains('color-text')) {
      var picker = f.querySelector('input[type="color"][data-color-for="' + target.name + '"]');
      if (picker && /^#[0-9a-fA-F]{6}$/.test(target.value.trim())) {
        picker.value = target.value.trim().toLowerCase();
      }
    }
  }

  function onEdit(event) {
    var f = form();
    if (!f || !f.contains(event.target)) return;
    syncColor(event.target);
    schedule();
  }

  document.addEventListener('input', onEdit);
  document.addEventListener('change', onEdit);
  // Al cargar (o recargar) un iframe se le aplica lo que se está editando. `load` no burbujea:
  // se escucha en la fase de captura.
  document.addEventListener(
    'load',
    function (event) {
      if (event.target && event.target.classList && event.target.classList.contains('chat-preview')) {
        schedule();
      }
    },
    true,
  );
})();
