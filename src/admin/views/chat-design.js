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

  /* --- Imágenes elegidas: se ven en la vista previa sin subirse (FR-009, FR-011). --- */

  var MAX_IMAGE_BYTES = 256 * 1024;
  var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  /** URL `blob:` de la imagen elegida en cada hueco. */
  var chosen = { logo: null, avatar: null, icon: null };

  /** URL que debe verse en un hueco: la elegida, ninguna si se quita, o la guardada. */
  function imageUrl(f, slot) {
    var input = f.querySelector('input[type="file"][data-image-slot="' + slot + '"]');
    if (chosen[slot]) return chosen[slot];
    var remove = f.elements.namedItem(slot + '_remove');
    if (remove && remove.checked) return '';
    return input ? input.getAttribute('data-saved') || '' : '';
  }

  /** `<img>` del hueco dentro de `parent`: lo crea, lo actualiza o lo quita. */
  function placeImage(doc, parent, className, url, before) {
    if (!parent) return;
    var img = parent.querySelector('img.' + className);
    if (!url) {
      if (img) img.remove();
      return;
    }
    if (!img) {
      img = doc.createElement('img');
      img.className = className;
      img.alt = '';
      parent.insertBefore(img, before || parent.firstChild);
    }
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
  }

  function applyImages(f, doc) {
    var head = doc.querySelector('.panel-head');
    placeImage(doc, head, 'design-logo', imageUrl(f, 'logo'), head ? head.querySelector('h1') : null);
    placeImage(doc, doc.getElementById('chat-toggle'), 'design-icon', imageUrl(f, 'icon'), null);
    var avatar = imageUrl(f, 'avatar');
    var root = doc.documentElement;
    if (avatar) {
      root.style.setProperty('--chat-avatar', 'url("' + avatar + '")');
      root.setAttribute('data-avatar', 'on');
    } else {
      root.style.removeProperty('--chat-avatar');
      root.removeAttribute('data-avatar');
    }
  }

  /** Aviso sin bloquear: la comprobación que cuenta es la del servidor al guardar. */
  function onImageChosen(input) {
    var slot = input.getAttribute('data-image-slot');
    if (chosen[slot]) URL.revokeObjectURL(chosen[slot]);
    chosen[slot] = null;
    var warning = document.querySelector('[data-image-warning="' + slot + '"]');
    var file = input.files && input.files[0];
    var message = '';
    if (file) {
      if (IMAGE_TYPES.indexOf(file.type) < 0) {
        message = 'Este fichero no parece PNG, JPEG ni WebP: al guardar se rechazará.';
      } else if (file.size > MAX_IMAGE_BYTES) {
        message = 'La imagen supera el máximo de 256 KB: al guardar se rechazará.';
      }
      chosen[slot] = URL.createObjectURL(file);
    }
    if (warning) warning.textContent = message;
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
      applyImages(f, doc);
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
    if (event.type === 'change' && event.target.hasAttribute('data-image-slot')) {
      onImageChosen(event.target);
    }
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
