# Quickstart: validar la derivación al negocio

**Feature**: `005-handoff-to-business` | **Plan**: [plan.md](plan.md)

Guía para comprobar de principio a fin que la derivación funciona. Los detalles de cada
respuesta están en [contracts/handoff-flow.md](contracts/handoff-flow.md), los avisos al negocio
en [contracts/business-alerts.md](contracts/business-alerts.md) y las páginas en
[contracts/admin-and-web.md](contracts/admin-and-web.md).

## Requisitos

- Arranque local de CLAUDE.md (`pnpm install`, `docker compose up -d db`, `.env`,
  `pnpm db:migrate`) con `ANTHROPIC_API_KEY` y `EMERGENCY_CONTACT_PHONE`.
- Un negocio activo con horario semanal, contacto de derivación y al menos una pregunta sin dato
  registrado a mano (p. ej., algo que no esté en servicios ni FAQ).
- Para el email: un SMTP de pruebas (p. ej. Mailpit en Docker: `docker run -p 1025:1025 -p
  8025:8025 axllent/mailpit`) y en `.env`:

  ```env
  SMTP_URL=smtp://localhost:1025
  SMTP_FROM=asistente@ejemplo.com
  PUBLIC_BASE_URL=http://localhost:3000
  ```

- Para WhatsApp (opcional, escenario 7): instancia con las variables `WHATSAPP_*`, un segundo
  número de WhatsApp que haga de negocio y las tres plantillas aprobadas
  (`pnpm handoff:templates` imprime su definición).

## Pruebas automáticas

```bash
pnpm test                                   # unit + contract + integration
pnpm test handoff                           # solo lo de esta feature
pnpm test:eval --reporter=verbose           # SC-001/003/006/007 con el modelo real (coste)
pnpm lint && pnpm typecheck
```

Esperado: todo en verde; en `eval`, quejas derivadas ≥ 95 %, comentarios negativos atendidos
≥ 90 %, oferta en el 100 % de las consultas sin dato y ningún resumen con datos que el cliente no
dio.

## Escenario 1 — Configurar los avisos (FR-020)

1. `/admin/handoffs` sin destinos → aviso normal "No hay ninguna vía…"; el negocio se puede
   activar igualmente.
2. Guarda solo el email → la vía email aparece "Disponible" y el aviso cambia a "solo llegan por
   email…".
3. Guarda un teléfono no válido → error en el campo; nada cambia.

## Escenario 2 — Pedir una persona en el chat web (US1, US3, US4)

1. En "Probar el bot" (o en el chat web de una página permitida) pregunta un precio y después
   escribe "quiero hablar con una persona".
2. Esperado: el bot pide nombre y teléfono en una sola pregunta. Contesta con un teléfono mal
   escrito → lo pide otra vez; contesta bien → confirmación "He avisado a {negocio}…".
3. En el playground, la información técnica muestra el aviso simulado con nombre, teléfono y un
   motivo que menciona el precio. En el chat web, el aviso llega a Mailpit
   (`http://localhost:8025`) con los enlaces "Le atiendo" y "Terminado".
4. Escribe dos mensajes seguidos → el bot no contesta; el chat muestra la franja fija; llega un
   único email de reenvío con los dos textos (en el playground, un único reenvío simulado).
5. Abre el enlace "Terminado" del email → página de confirmación (nada cambia todavía); pulsa el
   botón → "Anotado…". Vuelve a pulsarlo → "ya había terminado".
6. En el chat, la franja desaparece en ≤ 60 s sin mensaje del bot. Escribe una pregunta → el bot
   contesta sin saludar de nuevo.

## Escenario 3 — Consulta sin dato y oferta (US2)

1. Pregunta el dato no registrado → "no dispongo de esa información" + "¿Quieres que le pase tu
   consulta…?" y **sin** bloque de contacto.
2. Responde "no, gracias" → sin aviso; el bot sigue normal.
3. Repite y responde "sí" → pide datos (web) y deriva; el motivo del aviso recoge la pregunta.

## Escenario 4 — Queja (US6)

1. Escribe "quiero poner una reclamación, el trabajo me lo hicieron mal" → el bot no explica ni
   justifica nada; deriva (pidiendo datos en la web); el aviso dice "queja o reclamación" y el
   motivo empieza por "Queja:".
2. En otra conversación escribe "qué caro" → respuesta normal, sin derivación.

## Escenario 5 — Fuera de horario y recordatorio (US5, FR-019)

Con un reloj de pruebas (tests de integración) o poniendo un cierre puntual hoy:

1. Deriva con el negocio cerrado → la confirmación dice "a partir de {día} a las {hora}" con la
   primera franja tras el cierre; el aviso sale en el momento.
2. Sin confirmar, deja pasar 2 horas **de horario** → llega un recordatorio al negocio y el cliente
   recibe un único mensaje con el contacto directo. No se repite.
3. (Solo con reloj de pruebas) Deriva el viernes por la noche con apertura el lunes, sin confirmar
   ni escribir más → a las 24 h la conversación vuelve al bot sin mensaje al cliente y el negocio
   recibe el recordatorio en ese momento; el lunes no llega nada más. Si después pulsa un botón o
   enlace, la respuesta dice que la conversación ya volvió al asistente y le da el teléfono.

## Escenario 6 — Panel y fallos (FR-012, FR-016a)

1. `/admin/handoffs` lista la derivación activa (nombre, teléfono, canal, tipo, inicio,
   confirmada) sin el motivo; "Terminar" la cierra y el cliente vuelve al bot.
2. Para Mailpit (sin WhatsApp) y pide una persona → el bot **no** confirma; da el contacto de
   derivación y no hay derivación en el panel; el registro muestra `handoff_not_started` con
   `delivery_failed`.

## Escenario 7 — WhatsApp (opcional)

1. Configura el WhatsApp de avisos con el segundo número. Desde un tercer número, escribe al bot
   "quiero hablar con alguien".
2. Esperado: el bot usa el nombre de perfil y el número (no pide datos) y confirma; el segundo
   número recibe `derivacion_aviso` con los dos botones.
3. Pulsa "Le atiendo" → acuse "Anotado…"; en el panel aparece confirmada. Escribe texto libre
   desde el número del negocio → recibe la ayuda y no cambia nada.
4. Con dos derivaciones activas, "Terminado" en el aviso de una solo termina esa (SC-010).

## Escenario 8 — Registros y privacidad (FR-022, FR-023)

```bash
# Tras los escenarios anteriores, en la salida del servidor:
# ni nombres, ni teléfonos, ni emails, ni una palabra del motivo o de los mensajes
```

Busca el nombre y el teléfono usados y una palabra del motivo: no deben aparecer. Solo eventos
`handoff_*` con `handoffId`, `via` y seudónimo. Borra la conversación por retención (test de
integración con reloj a +30 días) → desaparecen `handoff`, `handoff_notice` y los datos de
contacto.
