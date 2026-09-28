# Quickstart: validar el canal web

**Feature**: `004-web-channel` | **Plan**: [plan.md](plan.md)

Guía para comprobar de principio a fin que la feature funciona. Los detalles de rutas, datos y
registros están en [contracts/](contracts/) y [data-model.md](data-model.md).

## Requisitos

- La instancia local de la 001/002 funcionando (ver [README](../../README.md)): `docker compose
  up -d db`, `.env` con `SESSION_SECRET` y `OPERATOR_PASSWORD_HASH`.
- En `.env`: `ANTHROPIC_API_KEY` y `EMERGENCY_CONTACT_PHONE` (ahora obligatoria con la clave).
  WhatsApp **no** hace falta.
- Un negocio registrado con horario, algún precio fijo, un servicio "a consultar" y contacto de
  derivación (por ejemplo, cargando uno de los negocios de `tests/fixtures/`).

```bash
pnpm install
pnpm db:migrate          # aplica 0002_channels
pnpm dev                 # http://localhost:3000/admin
```

## Pruebas automáticas

```bash
pnpm test                          # unit + contract + integration (incluye las de la 002: SC-001)
pnpm test channels                 # paridad entre canales y migración 0001 → 0002
pnpm test web-chat                 # contrato del chat público y del panel
pnpm lint && pnpm typecheck

# SC-002 con el modelo real (coste; fuera de pnpm test). Con `--reporter=verbose`, porque el
# reporter por defecto descarta la salida de los ficheros que pasan y esconde sus porcentajes.
npx vitest run --project eval --reporter=verbose
EVAL_CHANNEL=web npx vitest run --project eval --reporter=verbose
```

Resultado esperado: todo en verde; la evaluación con `web` da los mismos porcentajes que con
WhatsApp en SC-001, SC-002 y SC-005 a SC-008 de la 002. SC-009 (audio y otros tipos) se omite con
`EVAL_CHANNEL=web`, porque la web solo admite texto (FR-020).

## Escenario 1 — Probar el bot desde el panel (US1)

1. Con el negocio **activo**, abre `/admin/playground`.
2. Escribe "¿a qué hora abrís el sábado?" → en menos de 10 s (SC-003) la respuesta empieza por
   el saludo con el nombre del negocio y da las franjas del sábado. Debajo: "Saludo añadido",
   "Redactada por el modelo", "Sin contacto", "Sin rechazos" y el tiempo.
3. Pregunta otra cosa → sin saludo y tiene en cuenta lo anterior.
4. Pregunta algo sin dato registrado → la respuesta lo dice e incluye el contacto; la
   información técnica indica "Contacto añadido: el modelo ofreció el contacto".
5. Escribe "quiero hablar con una persona" → "Contacto añadido: pidió hablar con una persona".
6. Pulsa **Nueva conversación** y pregunta de nuevo → vuelve el saludo.
7. En otra pestaña cambia un precio en `/admin/services`; pregunta por él → precio nuevo.
8. Pasa el negocio a "En preparación" → la página muestra el aviso y sigue respondiendo.
9. Cierra sesión y abre `/admin/playground` → redirige al login.

## Escenario 2 — Activar el chat web (US2)

1. Abre `/admin/web-chat`: aparece **Desactivado** y el fragmento con la nota "No mostrará
   nada hasta que actives el chat".
2. Marca "Activar" sin webs ni enlace → no se guarda y explica qué falta.
3. Webs permitidas: `http://localhost:8080`; política: `https://example.com/privacidad`;
   activa y guarda. Copia el fragmento.
4. Crea una página de prueba y sírvela en otro origen:

   ```bash
   mkdir -p /tmp/negocio && cd /tmp/negocio
   printf '<!doctype html><title>Web del negocio</title><h1>Web del negocio</h1>\n%s\n' \
     '<script src="http://localhost:3000/chat/widget.js" defer></script>' > index.html
   npx --yes serve -l 8080 .
   ```

5. Abre `http://localhost:8080` → aparece el botón del chat.
6. Sirve la misma página en `-l 8081` (no permitida) → el navegador no muestra **nada** (en la
   consola: bloqueado por `frame-ancestors`). El iframe se inserta invisible y solo se muestra
   cuando el chat se anuncia, así que tampoco se ve el recuadro de marco bloqueado.

   > **Marca "Disable cache" en la pestaña Network de DevTools mientras hagas estas pruebas.**
   > `widget.js` se sirve con `Cache-Control: public, max-age=3600` y Chrome guarda la caché
   > **por sitio de primer nivel**, así que `:8080` y `:8081` tienen copias separadas: recargar
   > una no refresca la otra, y es fácil creer que el chat se comporta mal cuando lo que corre
   > es un `widget.js` antiguo.

7. Desactiva el chat en el panel y recarga `:8080` → "no disponible" con el contacto. Aquí el
   botón **sí** aparece (el frame carga y se anuncia); el mensaje se ve al pulsarlo.

## Escenario 3 — Conversar como cliente (US3)

Con el chat activado y el negocio activo, en `http://localhost:8080` en una ventana nueva:

1. Abre el chat → antes de escribir se ve el aviso de asistente automático y el enlace a la
   política de privacidad (SC-005).
2. Pregunta el horario → saludo + franjas registradas, con "escribiendo…" mientras tanto.
3. Envía tres mensajes seguidos **sin dejar más de 3 s entre uno y otro** → una sola respuesta
   que cubre los tres, con "escribiendo…" mientras tanto. Lo que cuenta es el hueco entre
   mensajes consecutivos, no el total: el bot espera 3 s de silencio desde el último (con un
   tope de 8 s desde el primero). Tecleando tres frases no se llega, así que para la prueba
   ten los tres textos preparados y pégalos, o usa mensajes de una palabra. Si dejas pasar más
   de 3 s verás dos respuestas: eso también es correcto, no es un fallo.
4. Pregunta por el servicio "a consultar" → sin cifra y con el contacto.
5. Pide hablar con una persona → contacto y su horario.
6. Recarga la página → siguen los mensajes y la siguiente respuesta no repite el saludo.
7. Abre otra pestaña de `:8080` → misma conversación; escribe en una y la respuesta aparece
   una sola vez.
8. Escribe `<b>hola</b><script>alert(1)</script>` → se ve tal cual, como texto, sin ejecutarse.
9. Intenta enviar un mensaje de más de 1 000 caracteres → no se envía y se explica el motivo.
10. Ventana privada → funciona, pero al recargar empieza conversación nueva con saludo.
11. Pasa el negocio a "En preparación" y escribe → "no disponible" con el contacto.

## Escenario 4 — Límites y topes (US4)

1. En `/admin/web-chat` pon el tope diario en `3` y el mensual en `3000`.
2. Haz 3 preguntas en el chat; la cuarta → "Ahora mismo no puedo atenderte por este chat" con
   el contacto. El panel muestra "Hoy: 3 de 3" y el aviso de tope alcanzado; la portada también.
3. Para `pnpm dev` y comprueba que `pnpm bot:chat` sigue respondiendo (WhatsApp no se ve
   afectado). **No vale con el servidor levantado**: ver el aviso del escenario 6.
4. Restaura el tope. Límite por visitante: envía 31 mensajes seguidos desde la consola del
   navegador de la página del chat (el test de integración lo automatiza) → un único aviso
   con el contacto y después silencio.
5. Límite por origen: 21 sesiones nuevas en una hora desde la misma IP (el test de contrato lo
   automatiza) → `429` con el contacto.

## Escenario 5 — Registros y privacidad (SC-008)

Con `pnpm dev` y la salida del servidor en un fichero (`pnpm dev > server.log`):

```bash
# Ni el token, ni la IP del visitante, ni cookies o cabeceras de autorización
grep -E 'Bearer|remoteAddress|x-forwarded|authorization|cookie' server.log   # sin resultados
# Ni el texto del visitante ni el de la respuesta (pon una palabra de tu pregunta)
grep -i sábado server.log                                                    # sin resultados
# Las IP solo salen en las direcciones de escucha que imprime Fastify al arrancar
grep -v 'Server listening' server.log | grep -E '127\.0\.0\.1|::1'           # sin resultados
grep '"via":"web"' server.log | head            # eventos del canal web con seudónimo
```

El seudónimo (`customer`) y el `conversationId` sí aparecen; el `channel_user_id` del visitante y
el id de su sesión, no. Al escribir el grep, cuidado con `"text"` a secas: casa con
`"kind":"text"` de `message_received`, que es el tipo del mensaje y no su contenido.

## Escenario 6 — WhatsApp sin cambios (SC-001, FR-005)

1. Con una BD que ya tenía conversaciones de la 002, `pnpm db:migrate` → siguen todas, con su
   estado (se comprueba también en `pnpm test`).
2. **Para `pnpm dev` antes de abrir `pnpm bot:chat`.** Los dos traen su propio procesador sobre
   la misma BD, y el del servidor no tiene sender de la Graph API (R1), así que descarta los
   entrantes de WhatsApp del CLI con `message_discarded{reason:"disabled"}` antes de que el CLI
   los conteste: el CLI recibe el mensaje y sale sin respuesta. No es un problema de producción,
   donde el servidor es el único procesador y tiene WhatsApp configurado.
3. `pnpm bot:chat` → mismas respuestas que antes; la ventana de 24 h y los tipos de mensaje de
   WhatsApp se comportan igual (la ventana y los tipos los cubre `pnpm test`).
