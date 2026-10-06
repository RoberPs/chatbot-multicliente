# Quickstart: validar consumo y tope de gasto

**Feature**: 010-usage-cost-cap

Guía de validación de extremo a extremo. Comportamiento esperado en los contratos:
[usage-recording](contracts/usage-recording.md), [spend-cap-conversation](contracts/spend-cap-conversation.md),
[admin-usage-screen](contracts/admin-usage-screen.md), [health-spend-cap](contracts/health-spend-cap.md).

## Requisitos

- Entorno de la [guía del proyecto](../../CLAUDE.md#arranque-y-pruebas-en-local): Docker con la BD,
  `.env` con `ANTHROPIC_API_KEY` y `HEALTH_SECRET`, negocio de prueba activo.
- `pnpm db:migrate` aplica `0006_usage`.

## 1. Pruebas automáticas

```bash
pnpm test:unit          # costPico, unidades, niveles del tope, validaciones, R-CAP, tabla de versions
pnpm test:contract      # /admin/usage, avisos del layout, /health con spendCap, chat web "no disponible"
pnpm test:integration   # registro por canal, tope en WhatsApp/web, derivación, mes nuevo, retención, rendimiento
pnpm lint && pnpm typecheck
```

Esperado: todo verde. La suite de integración incluye la medida de SC-006 (mediana con y sin
medición, diferencia < 100 ms).

## 2. Medición (US1)

1. `pnpm dev` y abre `/admin/usage`: tablas a cero; aviso de estimación visible.
2. En **Probar el bot**, haz una pregunta. Recarga **Consumo**: una respuesta en "Probar el bot", con
   tokens de entrada y salida > 0 y coste «sin precio» + aviso que nombra `LLM_MODEL`.
3. Comprueba que no hay textos ni identificadores:
   ```bash
   docker compose exec db psql -U chatbot -d chatbot -c "select * from model_usage order by at desc limit 5"
   ```
   Esperado: solo momento, día, canal, uso, modelo, llamadas, tokens, coste y moneda.

## 3. Precios y coste (US2)

1. En **Consumo → Precios**, añade el precio de `LLM_MODEL` (p. ej. 3 / 15 / 3,75 / 0,30).
2. Haz otra pregunta en "Probar el bot". La fila nueva tiene coste; la anterior sigue «sin precio».
3. Cambia el precio y pregunta otra vez: el coste de las respuestas anteriores no cambia.
4. Comprueba a mano un coste: `Σ tokens × precio / 10⁶` coincide con el mostrado (4 decimales).

## 4. Tope de gasto (US3)

1. Intenta activar el tope con el precio de `LLM_MODEL` borrado → error que nombra el modelo.
2. Con precio, activa un tope un poco por encima del gasto actual. Pregunta en "Probar el bot" hasta
   pasarlo: aparece el aviso de ≥ 80 % y después el de tope alcanzado en **todas** las pantallas.
3. Abre el chat web de prueba (`/chat/...` desde un origen permitido): estado "no disponible" con el
   contacto del negocio.
4. Por WhatsApp (o el doble de la suite de integración): un mensaje recibe "Ahora mismo no puedo
   atenderte por este chat." + contacto, y el registro muestra `reply_sent` con `template: "R-CAP"`
   y ningún registro de consumo nuevo. "Quiero hablar con una persona" inicia la derivación; el
   aviso al negocio lleva el extracto literal (`handoff_summary_fallback`, `reason: "spend_cap"`).
5. El registro de actividad tiene **un** `spend_cap_reached` con el mes.
6. "Probar el bot" sigue respondiendo con el modelo y muestra el recordatorio.
7. Sube el tope por encima del gasto: el siguiente mensaje de cliente se responde con el modelo.

## 5. Salud e inventario (US3-11, US3-12)

```bash
curl -s http://localhost:3000/health                                   # {"status":"ok"} sin spendCap
curl -s -H "Authorization: Bearer $HEALTH_SECRET" http://localhost:3000/health   # … "spendCap":"reached"
pnpm instance:versions --allow-insecure                                # columna Tope: «alcanzado»
pnpm instance:versions --allow-insecure --json                         # "spendCap": "reached"
```

Esperado: el código de salida y el estado de la fila no dependen del tope; una instancia anterior a
la 010 muestra «—».

## 6. Límites con otras features

- **Exportar** la configuración (`/admin/config`): el fichero no contiene precios, moneda ni tope.
- **Copia y verificación**: `pnpm db:backup` y `pnpm db:verify <fichero>` terminan bien; tras
  restaurar, el gasto del mes es el de los registros restaurados.
