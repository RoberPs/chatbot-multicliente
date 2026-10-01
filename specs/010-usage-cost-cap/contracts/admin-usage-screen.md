# Contrato: pantalla "Consumo" y avisos del panel

**Feature**: 010-usage-cost-cap · FR-007 – FR-014, FR-019 – FR-021 · research R4, R12, R13

Todas las rutas van bajo `/admin`, con sesión de operador y CSRF como el resto del panel
(`src/admin/routes/usage.ts`). Formularios POST tradicionales con mejora htmx; errores de
validación → 422 con el formulario y mensajes por campo (`submitForm` / `formErrorResponse`).

## Rutas

| Método y ruta | Qué hace | Respuestas |
|---|---|---|
| `GET /admin/usage` | consumo de hoy y del mes en curso + precios + ajustes | 200 |
| `GET /admin/usage?month=AAAA-MM` | un mes conservado: por canal y por día (FR-009) | 200; mes fuera de los conservados o mal formado → 200 con el mes en curso y aviso "Mes no disponible" |
| `POST /admin/usage/prices` | alta o cambio del precio de un modelo (`model`, `input`, `output`, `cacheWrite`, `cacheRead`) | 303 a `/admin/usage` con "Guardado"; 422 con errores |
| `POST /admin/usage/prices/delete` | borrar el precio de `model` | 303; 404 si no existe |
| `POST /admin/usage/settings` | `currency`, `capEnabled`, `monthlyCap` | 303; 422 con errores (FR-013, FR-014) |

Errores con nombre de modelo: `capEnabled` → "No se puede activar el tope: el modelo
«{LLM_MODEL}» no tiene precio." `currency` → "Para cambiar la moneda, borra antes los precios: están
en {moneda actual}."

## Contenido de `GET /admin/usage`

1. **Aviso de estimación** (FR-011): "Coste estimado con los precios configurados aquí. No es la
   factura del proveedor. Importes redondeados a 4 decimales."
2. **Hoy** y **Este mes** (fechas en la hora local del negocio, FR-008): tabla con una fila por
   canal —WhatsApp, Chat web, Probar el bot— y las filas **Clientes finales** (WhatsApp + web) e
   **Instancia** (todo). Columnas: respuestas con modelo, resúmenes, tokens de entrada, de salida,
   de escritura en caché, de lectura de caché, coste estimado. Un canal sin consumo aparece con
   ceros.
3. **Sin precio** (FR-012, US2-4): si el periodo tiene registros sin precio, aviso "Consumo sin
   precio del modelo «X»: sus tokens se muestran pero no tienen coste." El coste de esas filas se
   muestra como «sin precio», nunca 0, y la suma muestra el coste de lo valorado + «(hay consumo sin
   precio)».
4. **Tope mensual**: estado (sin tope / normal / ≥ 80 % / alcanzado), gasto del mes, tope y
   porcentaje; formulario de ajustes.
5. **Precios por modelo**: tabla editable en la moneda de coste (por millón de tokens); el modelo
   actual (`LLM_MODEL`) marcado; si no tiene precio, botón para añadirlo con el nombre ya puesto.
6. **Meses anteriores**: selector con los meses conservados que tienen consumo (FR-006, FR-009).
   Con `?month`, el resumen del mes por canal y una tabla por día.
7. **Sin bot** (sin `ANTHROPIC_API_KEY`): las tablas vacías con "Esta instancia no tiene bot: no
   hay consumo." Precios y ajustes siguen editables.

Ningún dato de esta pantalla identifica conversaciones ni clientes.

## Aviso en todas las pantallas (`layout.eta`)

Calculado en cada petición en `renderPage` (R12); como mucho uno, el más grave:

| Condición | Clase | Texto |
|---|---|---|
| nivel `reached` | crítico | "Tope de gasto alcanzado ({p} %): el bot responde solo con el contacto del negocio en WhatsApp y en el chat web. [Consumo]" |
| tope activo y `LLM_MODEL` sin precio | crítico | "El modelo «{m}» no tiene precio: su consumo no cuenta para el tope. [Consumo]" |
| nivel `warning` | aviso | "Gasto del mes al {p} % del tope. [Consumo]" |

No suman al contador de avisos ni bloquean activar el negocio. Si la consulta falla, no se pinta.

## "Probar el bot" (FR-019)

Con el nivel `reached`, encima del formulario: "Los clientes finales están recibiendo solo el
contacto del negocio porque se ha alcanzado el tope de gasto. Lo que pruebes aquí sigue usando el
modelo y suma al gasto."

## Navegación

Entrada nueva **Consumo** (`/admin/usage`) tras "Chat web".
