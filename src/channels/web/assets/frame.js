/**
 * Interfaz del chat web dentro del iframe (004 US3, contracts/web-chat-http.md).
 *
 * Pide la sesión, carga el estado y el historial, envía mensajes y sondea la respuesta. Todo lo
 * que viene del visitante o del bot se escribe siempre con `textContent`: este fichero nunca
 * construye HTML a partir de texto (garantía 9). Los enlaces `https://` del bot son elementos
 * `<a>` creados con `createElement` (FR-020a, `links.js`).
 */
(function () {
  'use strict';

  var API = '/chat/api';
  var STORAGE_KEY = 'chat.session';
  /** Cada cuánto se pregunta por la respuesta mientras el bot la prepara (R5). */
  var POLL_MS = 1500;
  /** A partir de aquí se deja de esperar y se da el contacto del negocio (FR-021). */
  var GIVE_UP_MS = 45000;
  /** Mientras la conversación está derivada, cada cuánto se mira si ha vuelto al bot (005, R15). */
  var HANDOFF_POLL_MS = 60000;

  var toggle = document.getElementById('chat-toggle');
  var panel = document.getElementById('chat-panel');
  var close = document.getElementById('chat-close');
  var list = document.getElementById('chat-messages');
  var status = document.getElementById('chat-status');
  var form = document.getElementById('chat-form');
  var box = document.getElementById('chat-text');
  var handoffBar = document.getElementById('chat-handoff');
  if (!toggle || !panel) return;

  /*
   * Imágenes del diseño (011, FR-018): si una no carga se quita; el botón vuelve a su icono
   * original y la cabecera queda sin logo.
   */
  function dropBroken(img) {
    if (img.parentNode) img.parentNode.removeChild(img);
  }
  var designImages = document.querySelectorAll('img.design-icon, img.design-logo');
  for (var d = 0; d < designImages.length; d++) {
    var img = designImages[d];
    if (img.complete && img.naturalWidth === 0) dropBroken(img);
    else img.addEventListener('error', dropBroken.bind(null, img));
  }

  var state = {
    token: null,
    cursor: null,
    contact: null,
    maxLength: 1000,
    /** Instante en el que se empezó a esperar la respuesta actual. */
    waitingSince: null,
    pollTimer: null,
    /** Sondeo lento mientras la conversación está derivada al negocio (005). */
    handoffTimer: null,
    handoffActive: false,
    /** Momento hasta el que no se puede enviar (cabecera `Retry-After`). */
    blockedUntil: 0,
    limitWarned: false,
    loaded: false,
    seen: Object.create(null),
  };

  /* --- Almacenamiento: si el navegador no lo permite, la sesión vive en memoria (R4). --- */

  function readStored() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function writeStored(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Ventana privada o almacenamiento bloqueado: la conversación no sobrevive a la recarga.
    }
  }

  function clearStored() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nada que limpiar.
    }
  }

  /* --- Pintado (solo textContent) --- */

  function setStatus(text) {
    if (status) status.textContent = text || '';
  }

  /**
   * Respuesta del bot: sus enlaces `https://` se pueden pulsar (FR-020a, `links.js`). Cada trozo
   * se escribe con `textContent`; el enlace se crea con `createElement` y su `href`.
   */
  function fillBotText(item, text) {
    var parts = window.ChatLinks ? window.ChatLinks.split(text) : [{ text: text }];
    parts.forEach(function (part) {
      if (!part.href) {
        item.appendChild(document.createTextNode(part.text));
        return;
      }
      var link = document.createElement('a');
      link.href = part.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      link.textContent = part.text;
      item.appendChild(link);
    });
  }

  function addMessage(msg) {
    if (!list || state.seen[msg.id]) return;
    state.seen[msg.id] = true;
    var item = document.createElement('li');
    if (msg.from === 'bot') {
      item.className = 'from-bot';
      fillBotText(item, msg.text);
    } else {
      // Lo que escribe el visitante nunca se enlaza.
      item.className = 'from-visitor';
      item.textContent = msg.text;
    }
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }

  /** Mensaje del propio chat (aviso, disculpa, "no disponible"): nunca viene del visitante. */
  function addNotice(text) {
    if (!list || !text) return;
    var item = document.createElement('li');
    item.className = 'from-bot notice';
    item.textContent = text;
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }

  function showUnavailable(un) {
    stopPolling();
    setStatus('');
    if (un && un.message) addNotice(un.message);
    if (un && un.contact) addNotice(un.contact);
    if (form) form.hidden = true;
  }

  /* --- Tamaño del iframe --- */

  /**
   * Avisa a la web que aloja el iframe del tamaño que necesita el chat. Va a cualquier origen
   * porque el iframe no sabe cuál es el de la página que lo incrusta; el mensaje solo dice si
   * el chat está abierto, nunca contenido de la conversación. El widget, por su parte, sí
   * comprueba el origen de los mensajes que recibe.
   */
  function tellParent(open) {
    if (window.parent === window) return;
    // Tamaño y esquina del diseño (011, R6), por nombre: nunca medidas. Los pone el servidor
    // en <html>; sin diseño, los de siempre.
    var data = (document.documentElement && document.documentElement.dataset) || {};
    window.parent.postMessage(
      {
        type: 'chat:resize',
        open: open,
        size: data.size || 'medium',
        position: data.position || 'right',
      },
      '*',
    );
  }

  /* --- Llamadas a la API --- */

  function request(method, path, body) {
    var headers = { accept: 'application/json' };
    if (state.token) headers.authorization = 'Bearer ' + state.token;
    if (body) headers['content-type'] = 'application/json';
    return window
      .fetch(API + path, {
        method: method,
        headers: headers,
        credentials: 'omit',
        body: body ? JSON.stringify(body) : undefined,
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            return { status: response.status, data: data, headers: response.headers };
          });
      });
  }

  function newSession() {
    return request('POST', '/session').then(function (res) {
      if (res.status === 201 && res.data.token) {
        state.token = res.data.token;
        writeStored(res.data.token);
        return true;
      }
      if (res.data.unavailable) showUnavailable(res.data.unavailable);
      return false;
    });
  }

  function loadState() {
    return request('GET', '/state').then(function (res) {
      if (res.status === 401) return false;
      var data = res.data || {};
      if (typeof data.contact === 'string') state.contact = data.contact;
      if (typeof data.maxLength === 'number') state.maxLength = data.maxLength;
      if (box) box.setAttribute('maxlength', String(state.maxLength));
      if (data.available === false) {
        showUnavailable(data.unavailable);
        return false;
      }
      return true;
    });
  }

  function loadHistory() {
    return request('GET', '/messages').then(function (res) {
      if (res.status !== 200) return;
      applyMessages(res.data);
    });
  }

  /**
   * Franja fija de derivación (005, FR-013a): aviso de la interfaz, no burbuja del bot. Mientras
   * está visible no hay indicador de "escribiendo" y se consulta cada minuto si la conversación
   * ha vuelto al bot; al volver se quita sin añadir ningún mensaje (US4-6).
   */
  function applyHandoff(handoff) {
    var active = Boolean(handoff && handoff.active);
    state.handoffActive = active;
    if (handoffBar) {
      handoffBar.textContent = active ? String(handoff.notice || '') : '';
      handoffBar.hidden = !active;
    }
    if (active) {
      stopPolling();
      setStatus('');
      if (state.handoffTimer === null) {
        state.handoffTimer = window.setInterval(pollHandoff, HANDOFF_POLL_MS);
      }
    } else if (state.handoffTimer !== null) {
      window.clearInterval(state.handoffTimer);
      state.handoffTimer = null;
    }
  }

  function pollHandoff() {
    var path = state.cursor ? '/messages?after=' + encodeURIComponent(state.cursor) : '/messages';
    request('GET', path).then(function (res) {
      if (res.status === 200) applyMessages(res.data);
    });
  }

  function applyMessages(data) {
    var messages = data && data.messages ? data.messages : [];
    for (var i = 0; i < messages.length; i++) addMessage(messages[i]);
    if (data && typeof data.cursor === 'string') state.cursor = data.cursor;
    applyHandoff(data ? data.handoff : null);
    if (data && data.waiting && !state.handoffActive) {
      startPolling();
    } else {
      stopPolling();
      setStatus('');
    }
  }

  /* --- Sondeo de la respuesta --- */

  function startPolling() {
    if (state.handoffActive) return;
    if (state.waitingSince === null) state.waitingSince = Date.now();
    setStatus('escribiendo…');
    if (state.pollTimer !== null) return;
    state.pollTimer = window.setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer !== null) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.waitingSince = null;
  }

  function poll() {
    if (state.waitingSince !== null && Date.now() - state.waitingSince > GIVE_UP_MS) {
      stopPolling();
      setStatus('');
      addNotice('Ahora mismo no puedo responder. Vuelve a escribirme en unos minutos.');
      addNotice(state.contact);
      return;
    }
    var path = state.cursor ? '/messages?after=' + encodeURIComponent(state.cursor) : '/messages';
    request('GET', path).then(function (res) {
      if (res.status === 401) {
        stopPolling();
        return recoverSession();
      }
      if (res.status !== 200) return;
      applyMessages(res.data);
    });
  }

  /** La sesión ya no vale (secreto cambiado, token manipulado): se pide otra. */
  function recoverSession() {
    state.token = null;
    clearStored();
    return newSession().then(function (ok) {
      if (ok) return loadHistory();
    });
  }

  /* --- Envío --- */

  function send(text) {
    var id = window.crypto.randomUUID();
    return request('POST', '/messages', { clientMessageId: id, text: text }).then(function (res) {
      if (res.status === 202) {
        state.limitWarned = false;
        startPolling();
        return loadHistory();
      }
      if (res.status === 401) {
        return recoverSession().then(function () {
          setStatus('');
        });
      }
      if (res.status === 429) {
        var retry = Number(res.headers.get('retry-after')) || 60;
        state.blockedUntil = Date.now() + retry * 1000;
        if (!state.limitWarned) {
          state.limitWarned = true;
          if (res.data.unavailable) {
            addNotice(res.data.unavailable.message);
            addNotice(res.data.unavailable.contact);
          }
        }
        setStatus('');
        return;
      }
      if (res.status === 400) {
        setStatus('El mensaje tiene que tener entre 1 y ' + state.maxLength + ' caracteres.');
        return;
      }
      if (res.data && res.data.unavailable) showUnavailable(res.data.unavailable);
    });
  }

  /* --- Arranque y eventos --- */

  function open() {
    panel.hidden = false;
    toggle.hidden = true;
    toggle.setAttribute('aria-expanded', 'true');
    tellParent(true);
    if (box) box.focus();
    if (state.loaded) return;
    state.loaded = true;
    state.token = readStored();
    var ready = state.token ? Promise.resolve(true) : newSession();
    ready
      .then(function (ok) {
        if (!ok) return;
        return loadState().then(function (available) {
          if (available) return loadHistory();
        });
      })
      .catch(function () {
        setStatus('No se ha podido abrir el chat. Inténtalo de nuevo en unos minutos.');
      });
  }

  function shut() {
    panel.hidden = true;
    toggle.hidden = false;
    toggle.setAttribute('aria-expanded', 'false');
    tellParent(false);
    toggle.focus();
  }

  toggle.addEventListener('click', open);
  if (close) close.addEventListener('click', shut);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) shut();
  });

  if (form && box) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = box.value.trim();
      if (text === '') {
        setStatus('Escribe un mensaje.');
        return;
      }
      if (text.length > state.maxLength) {
        setStatus('El mensaje no puede pasar de ' + state.maxLength + ' caracteres.');
        return;
      }
      if (Date.now() < state.blockedUntil) {
        setStatus('Has enviado muchos mensajes. Espera un momento antes de volver a escribir.');
        return;
      }
      box.value = '';
      // No se pinta una copia local: al aceptarlo, `loadHistory` lo trae ya con su id, y así
      // el mensaje nunca aparece dos veces.
      if (!state.handoffActive) setStatus('escribiendo…');
      send(text).catch(function () {
        setStatus('No se ha podido enviar. Inténtalo de nuevo.');
      });
    });
  }

  shut();
})();
