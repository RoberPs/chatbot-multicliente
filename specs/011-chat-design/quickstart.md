# Quickstart: validar el diseño del chat web

**Feature**: 011-chat-design. Guía para comprobar de punta a punta que la feature funciona. Las
reglas y rutas están en [data-model.md](data-model.md) y [contracts/](contracts/).

## Requisitos

- Entorno local de CLAUDE.md: `pnpm install`, `docker compose up -d db`, `.env` con la credencial
  del operador, `pnpm db:migrate` (aplica `0007_chat_design`) y `pnpm dev`.
- Un negocio con nombre y el chat web activado en `/admin/web-chat`, con `http://localhost:8080`
  entre las webs permitidas y un enlace de privacidad.
- Una página de prueba servida en ese origen con el fragmento **tal como se copiaba antes de esta
  feature**, por ejemplo:

  ```bash
  mkdir -p /tmp/web && printf '<!doctype html><title>Web</title><h1>Web de prueba</h1><script src="http://localhost:3000/chat/widget.js" defer></script>' > /tmp/web/index.html
  npx --yes http-server /tmp/web -p 8080
  ```

- Imágenes de prueba de `tests/fixtures/images/` (válidas, SVG renombrado, de más de 256 KB, de
  2000 × 2000 px, dañada).

## Pruebas automáticas

```bash
pnpm test:unit -- design            # contraste, derivados, tokens, imágenes, textos, formato v2
pnpm test:contract -- chat-design   # panel, vista previa, design.css, imágenes, frame sin y con diseño
pnpm test:integration -- chat-design config-transfer backup
pnpm test                           # todo, incluidas las de la 004, 008 y 010 (no regresión)
pnpm lint && pnpm typecheck
```

Esperado: todo en verde; en particular el test del frame sin diseño (HTML idéntico al de la 004) y
el de cobertura de columnas con las dos tablas nuevas.

## Escenarios manuales

### 1. Sin diseño todo sigue igual (US1-1, US4-1, FR-015)

1. Abre `http://localhost:8080`: botón azul circular abajo a la derecha; al abrir, 380 × 560,
   "Asistente de <negocio>", "Escribe tu mensaje", "Enviar".
2. Abre `/admin/chat-design`: el formulario muestra esos valores, no hay "Restaurar" y la vista
   previa es idéntica al chat.

### 2. Colores, forma, nombre y textos con vista previa (US1)

1. Cambia el color principal, la forma a "Suave", el nombre, la bienvenida (con dos líneas), la
   ayuda y "Enviar". La vista previa cambia en menos de un segundo sin guardar (SC-002).
2. Escribe `<b>hola</b> {{ x }}` en el nombre: la vista previa lo muestra literal.
3. Sal de la página sin guardar y vuelve: valores guardados; el chat de la web no ha cambiado.
4. Repite y guarda. Recarga `http://localhost:8080` sin tocar la página: el chat se ve como la vista
   previa, con la bienvenida arriba de la conversación, junto al aviso, y se desplaza con los
   mensajes; vuelve a aparecer al cerrar y abrir y al recargar con la conversación empezada; no está
   en `GET /chat/api/messages`.
5. Deja vacíos nombre, ayuda y Enviar y guarda: vuelven los textos por defecto; bienvenida vacía =
   sin bienvenida.

### 3. Contraste y elementos obligatorios (US2)

1. Pon el texto sobre el principal casi igual que el principal: aviso junto al control con la
   pareja, la razón y "mínimo 4,5:1" mientras editas.
2. Guarda: `422`, nada cambia. Repite con JavaScript desactivado en el navegador: también `422`.
3. Con `curl` y la cookie de sesión, manda un `POST` con campos inventados `privacy_notice=` o
   `hide_privacy=1`: el aviso y el enlace siguen en el chat.
4. Guarda nombre de 40 caracteres, bienvenida de 280, tamaño pequeño, forma redondeada y las tres
   imágenes. En escritorio y en un móvil (o el modo dispositivo del navegador a 360 × 640): aviso,
   enlace de privacidad, campo, Enviar y cerrar visibles y usables; el nombre se corta con puntos
   suspensivos sin tapar el cierre (SC-004).
5. Navega con el teclado por el chat: el foco se ve en todos los controles con la paleta propia.
6. Desactiva el chat o alcanza un tope: mensaje de no disponible y contacto, con los colores del
   diseño. Pide hablar con una persona en una conversación con diseño: la franja de derivación se
   lee (texto oscuro sobre amarillo).

### 4. Imágenes (US3)

1. Sube un PNG como logo, un JPEG como avatar y un WebP como icono: la vista previa las muestra
   antes de guardar; tras guardar, el chat también, sin deformar (logo junto al nombre, avatar junto
   a los mensajes del bot, icono dentro del botón circular).
2. Intenta un SVG, un SVG renombrado a `.png`, un HTML renombrado, un fichero vacío, uno de más de
   256 KB y uno de 2000 × 2000: cada uno se rechaza en su campo, no se guarda nada y la imagen
   anterior sigue.
3. Sustituye el icono y guarda: la web muestra el nuevo al recargar (sin vaciar caché). La URL
   antigua (`/chat/design/icon/<antigua>.webp`) da `404`.
4. Marca "Quitar" en el logo y guarda: cabecera sin logo; avatar e icono siguen.
5. En las herramientas del navegador, pestaña Red: todas las peticiones del chat van a
   `localhost:3000`; ninguna cookie; las imágenes con su `Content-Type` y `nosniff`.

### 5. Posición y tamaño (US4)

1. Guarda "Abajo a la izquierda" y "Grande". Recarga `http://localhost:8080` (con el fragmento
   antiguo): botón y chat abierto a la izquierda, 440 × 640.
2. Prueba "Pequeño" y un móvil: el chat no sale de la pantalla con ningún tamaño.

### 6. Exportar e importar (US5)

1. Con un diseño completo exporta en `/admin/config`: el fichero trae `formatVersion: 2` y la sección
   `chatDesign` con las tres imágenes; ocupa bastante menos de 5 MB.
2. En otra instancia (o tras restaurar el aspecto original) importa: la vista previa muestra
   "Diseño del chat" con cada opción y las imágenes añadidas; confirma: mismo diseño; la activación
   del chat web del destino no cambia.
3. Importa otra vez el mismo fichero: sin cambios de diseño en la vista previa (SC-008).
4. Importa un fichero de la versión 1 (de antes de esta feature): la vista previa anuncia que el
   diseño se eliminará; al confirmar, aspecto original.
5. Descarga la "configuración anterior" e impórtala: vuelve el diseño anterior.
6. Edita el fichero: color con poco contraste, `"size": "huge"`, imagen con `type` falso, texto de
   300 caracteres: se rechaza entero con un error por campo.

### 7. Restaurar el aspecto original (US6)

1. Pulsa "Restaurar el aspecto original" y cancela: nada cambia.
2. Confírmalo: formulario con los valores originales; el chat de la web vuelve al de la 004; las URL
   de las imágenes dan `404`.

### 8. Copias de seguridad (006)

`pnpm db:backup` con un diseño guardado, restaura el aspecto original, `pnpm db:restore <fichero>`
con la instancia parada y arranca: el diseño y sus imágenes vuelven. `pnpm db:verify <fichero>`
pasa.

## Registros

Con `pnpm dev` en la terminal, cada guardado, rechazo, restauración e importación deja una línea
`chat_design_saved`, `chat_design_reset` o `config_import_*` sin textos, nombres de fichero ni
colores (FR-042).
