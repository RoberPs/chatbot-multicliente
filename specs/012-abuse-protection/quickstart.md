# Quickstart: validar la protección frente a abuso y saturación

**Feature**: 012-abuse-protection. Guía de comprobación de extremo a extremo; el detalle está en
[data-model.md](data-model.md) y en [contracts/](contracts/).

## Requisitos

- Entorno local de siempre (`docker compose up -d db`, `.env` con bot y, para US1/US2 por WhatsApp,
  las variables `WHATSAPP_*` de una app de pruebas de Meta).
- Docker para las pruebas de integración (Testcontainers).

```bash
pnpm install
pnpm db:migrate            # aplica 0008_abuse_protection
pnpm test                  # unit + contract + integration
pnpm lint && pnpm typecheck
```

## Escenarios

### 1. Tope obligatorio y que falla cerrado (US1)

```bash
pnpm test protection       # tabla de casos de protectionState / canCallModel / canTranscribe
pnpm test spend-cap        # 010 sigue en verde
```

A mano, con `NODE_ENV=production` y los secretos válidos (ver escenario 8):

1. Sin tope: la banda roja aparece en todas las pantallas; «Activar» el negocio se rechaza con el
   aviso `SPEND_CAP_REQUIRED`.
2. Con el negocio ya activo (actívalo antes en desarrollo y cambia a producción): el chat web dice
   «no disponible» con el contacto; `pnpm bot:chat` no llama al modelo.
3. Activa el tope con precio para `LLM_MODEL`: el chat responde con normalidad.
4. Intenta desactivar el tope o borrar el precio del modelo: 422 con el mensaje de producción.
5. `curl -H "Authorization: Bearer $HEALTH_SECRET" localhost:3000/health` → `spendCap: "blocked"`
   en el paso 1 y `"normal"` en el 3; `pnpm instance:versions` muestra `bloqueado` / `normal`.

Resultado esperado de integración: con el gasto ilegible (consulta que falla o tarda > 2 s) ninguna
llamada al modelo doble y `protection_read_failed` en el registro (SC-001).

### 2. Audios y tope diario de WhatsApp (US1)

- Integración: con el tope alcanzado, un audio no llama a `fetchAudio` ni a `stt.transcribe` y el
  cliente recibe R-CAP (SC-002); bajo el tope, `model_usage` gana una fila `transcription` con
  `audio_ms` y su coste.
- Integración con reloj falso: tras `whatsapp_daily_cap` respuestas con modelo, la siguiente es
  R-CAP; a las 00:00 locales del negocio vuelve el modelo; respuestas con el registro de consumo
  fallido cuentan igual.

### 3. Derivaciones acotadas (US2)

```bash
pnpm test handoff-limits
```

- 100 mensajes seguidos con una derivación activa → como mucho un reenvío por intervalo y ningún
  mensaje perdido (los que no salen quedan pendientes o `held`, visibles en el panel) (SC-003).
- Con `daily_max` alcanzado, una petición de persona recibe R-HANDOFF-FAIL con contacto y el panel
  cuenta 1 en «peticiones sin aviso».
- Batería de SC-011: ningún aviso (email ni variables de plantilla) contiene una dirección con
  protocolo ni sin `[.]`.

### 4. Rutas públicas y base de datos (US3)

```bash
pnpm test public-routes    # 429 sin consultas a la BD; clave /64; imagen con versión falsa sin leer bytes
pnpm test saturation       # integración: 10 000 peticiones públicas y el panel y el webhook < 2 s (SC-004)
```

A mano: `for i in $(seq 1 80); do curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/chat/frame; done | sort | uniq -c`
→ 60 respuestas 200 y 20 respuestas 429.

### 5. Login durante un ataque (US4)

```bash
pnpm test login            # retardo creciente, cola de 2 + 50, cookie de navegador conocido
```

Integración: 200 fallos desde 50 direcciones simuladas; el operador entra con la credencial correcta
en < 30 s desde un navegador nuevo y al instante con la cookie de navegador conocido (SC-005).

### 6. Proveedores lentos y lotes que fallan (US5)

- Graph API simulada que no responde: `sendText` termina en ≤ 30 s; `fetchAudio` en el plazo de la
  transcripción; el procesador sigue atendiendo web (SC-006).
- SMTP que no responde: la vía email falla en 15 s.
- Un lote que falla siempre: reintentos a los 5 s, 30 s, 2 min y 10 min (reloj falso), R-ERR una vez
  al quinto, ningún aviso ni respuesta repetidos.
- Fallo justo después de avisar al negocio: el reintento envía solo la confirmación.

### 7. Importación acotada (US6)

```bash
pnpm test config-transfer
pnpm test import-performance   # fichero de 5 MB con listas en su máximo: validar + vista previa < 5 s (SC-007)
```

Ficheros con 301 servicios → error «Hay 301 servicios; el máximo es 300» sin aplicar nada; con
1 000 errores → 50 en pantalla y «Y 950 errores más».

### 8. Enlaces, registros y arranque (US7, US8)

```bash
pnpm test link-rule        # SC-008: displayLinks ⊆ linkCandidates; links.js = displayLinks
pnpm test logging          # SC-009: errores con datos personales → solo type y code; sin hub.verify_token
pnpm test secret-rules     # SC-010: cada secreto débil, de ejemplo, repetido o ausente
```

A mano:

```bash
NODE_ENV=production SESSION_SECRET=$(printf 'a%.0s' {1..64}) pnpm dev
# → no arranca: "- SESSION_SECRET: es trivial (un carácter repetido o una secuencia)"
pnpm instance:check .env   # mismo veredicto que el arranque
curl "localhost:3000/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=XYZ&hub.challenge=1"
# → en el registro: url "/webhooks/whatsapp?hub.mode&hub.verify_token&hub.challenge"
```

## Cierre

- `pnpm test:eval` no es necesario: el prompt no cambia; las rutas sin modelo se prueban con dobles.
- Antes de cerrar: README (estado de la 012) y `docs/operacion-multicliente.md` (9.1, 9.2, P8 hecha,
  §4.1, §5 y la sección de límites de derivación), avisando antes al usuario.
