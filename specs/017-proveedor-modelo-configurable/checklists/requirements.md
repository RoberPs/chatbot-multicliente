# Specification Quality Checklist: Proveedor del modelo configurable por instancia

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-13
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

### Iteración 1 (2026-10-13)

Quedaron **dos** marcas [NEEDS CLARIFICATION], las dos deliberadas: decisiones de operación sin
valor por defecto defendible, que el usuario pidió expresamente decidir.

- **FR-030** — veredicto de la comprobación previa cuando se pide validar la credencial con llamada
  real y no hay red.
- **FR-036** — destino de un proveedor que no alcanza el criterio de la evaluación.

### Iteración 2 (2026-10-13) — ambas resueltas

- **FR-030 / FR-030a**: validación concluyente y negativa → **no apto**. Validación no concluyente
  (sin red, proveedor caído, fallo que no es un rechazo) → **apto con aviso**, distinguible del caso
  en que la validación no se pidió. Razón: `instance:check` sigue siendo local por naturaleza y la
  red es una ayuda, nunca un requisito para desplegar; el fallo que esta feature cierra ya se
  bloquea sin red (FR-028). Añadidos los escenarios US2.5 y US2.6.
- **FR-036 / FR-036a**: esfuerzo propio por proveedor, escrito y razonado, y reevaluación; si tras
  el ajuste sigue sin alcanzar el criterio, el proveedor **no se declara elegible** en esta versión.
  El esfuerzo por defecto de cada proveedor queda escrito junto al resultado que lo justifica.
  Actualizados los escenarios de US5 y la asunción sobre el mando de esfuerzo.

### Iteración 3 (2026-10-13) — `/speckit-clarify`, 5 preguntas

Ningún ítem cambia de estado: 16/16 seguían y siguen en verde. Lo que cambia es el contenido.
El barrido encontró cinco huecos con impacto real; el usuario pidió aplicar las recomendaciones sin
preguntar una a una.

1. **La spec cerraba solo la mitad del Problema 3.** FR-028 detecta credenciales de otro proveedor y
   FR-029 deja la llamada real como opcional, así que una credencial **del proveedor correcto pero
   rechazada** (revocada, caducada, sin saldo) reproducía el fallo original intacto. Añadidos
   FR-005a, FR-005b y FR-005c: comprobación al arrancar **no fatal**, degradado declarado con aviso
   crítico y reintento periódico, y arranque normal si no concluye. Escenarios US2.7 y US2.8, dos
   casos límite y SC-010.
2. **La severidad del aviso de consumo no medido estaba sin decidir** (se perdió al redactar).
   FR-025a: crítico solo con el tope activado y el negocio activo, y explícitamente **alarma, no
   bloqueo** —no revierte escrituras del operador, porque nace de una respuesta del bot—.
3. **Contradicción propia detectada**: FR-025 exigía registrar el consumo no medido y FR-037 negaba
   toda migración, lo que era imposible de cumplir a la vez. Resuelto en FR-025b y FR-037: hay una
   migración de solo añadir, y **no** sube `formatVersion` porque el registro de consumo no es
   configuración del negocio. Corregidos también el apartado «Lo que esta feature NO hace» y la
   asunción correspondiente.
4. **Las pruebas podían quedar inejecutables sin tres credenciales reales.** FR-038 y SC-011: la
   suite entera corre sin red y sin credenciales, con respuestas preparadas por proveedor; las
   credenciales reales solo las pide la evaluación, que ya vive fuera de la suite.
5. **«El panel no presenta ese cero como un ahorro» no era verificable.** FR-024 reescrito: «sin
   dato» distinguible de cero, nota genérica que no nombra al proveedor, y totales que no lo suman
   como cero. Escenario US3.2 y SC-012.

Nota de honestidad sobre el primer ítem del checklist: FR-025b nombra una migración de base de
datos, que roza el detalle de implementación. Se mantiene porque es una restricción de producto del
proyecto (migraciones de solo añadir, nunca editadas) y porque sin ella FR-025 no sería verificable.

### Iteración 4 (2026-10-13) — remediaciones del `/speckit-analyze`

Ningún ítem cambia de estado: 16/16 seguían y siguen en verde. El análisis no encontró violaciones
de la constitución ni problemas críticos, pero sí tres huecos reales de cobertura y siete ajustes.
Los diez se aplicaron.

Cambios en la spec:

- **FR-031** precisa que aplica a los **dos** sitios que validan credencial —comprobación previa y
  arranque—, incluidos los reintentos. Antes se escribió pensando solo en el primero.
- **El caso límite del reintento** deja de ser cualitativo: **5 minutos**, con su razón.
- **FR-032** avisa de que su número no es el de la regla de reversión por aviso crítico que usan
  otras specs del proyecto, porque FR-025a habla precisamente de esa regla.
- **FR-025a** nombra esa regla por lo que hace en lugar de por su número.

Cambios en las tareas (de 81 a **90**):

- **FR-020 no tenía ninguna tarea de implementación**, y era el hueco con más riesgo: los SDK nuevos
  traen su propia política de reintentos y el responder comparte un único presupuesto entre los dos
  intentos. Añadidos T034a (plazo, aborto y reintento del SDK desactivado) y T029a (su test).
- **FR-019 no tenía tarea y R9 era la única decisión de investigación sin referencias.** Añadido
  T034b, con el motivo de R9 en el comentario para que nadie añada la caché explícita de Gemini de
  buena fe.
- **FR-034 no tenía test**, y la feature añade a una herramienta local justo lo que podría tentar a
  escribir en disco. Añadido T045a.
- **No había ninguna tarea de despliegue**, al contrario que en la 016. Añadida la **fase 9**
  (T082–T086), que incluye la casilla pendiente de la 014: que la preferencia de tema del panel
  sobreviva a la actualización.
- **T053 mezclaba** una comprobación manual con red y un test automático, en una fase que prohíbe la
  red en los tests. Partida: la comprobación manual se queda en T053 y el test vive en T046.
- **Trazabilidad completa**: los **46 FR y los 12 SC** están ahora citados en al menos una tarea, y
  las 16 decisiones de investigación (R1–R16) también.

### Iteración 5 (2026-10-13) — hueco de diseño en FR-024, decidido por el usuario

Ningún ítem cambia de estado: 16/16 en verde. Salió al explicar qué significaba el «comportamiento
idéntico» del punto de control (T024), no al cruzar identificadores, y por eso el `/speckit-analyze`
no lo vio: no era una incoherencia entre los artefactos —los tres decían lo mismo— sino entre los
artefactos y el código que ya existe.

**El hueco**: FR-024 exige distinguir «cero medido» de «no informado», y R15 encargaba al panel
deducirlo de las filas registradas. Pero `cache_write_tokens` y `cache_read_tokens` son
`integer NOT NULL` desde la migración 0006, así que los dos estados aterrizaban como `0`,
indistinguibles. **FR-024 y R15 no eran implementables con el modelo de datos escrito.**

**Decisión del usuario: opción A.** La migración 0009 quita el `NOT NULL` de esas dos columnas.
Es una relajación, no una reescritura —no edita nada publicado, no toca ninguna fila, no pierde
datos— y queda como la única excepción de la feature a la convención de solo añadir. Se descartaron
añadir columnas-bandera (aditivo puro pero más piezas que mantener coherentes) y deducir la
capacidad del nombre del modelo (sin migración, pero mete una tabla de capacidades en la capa de
presentación, que es casi lo que FR-006 y FR-008 prohíben).

**Dos trampas que la decisión destapó**, las dos ya escritas en las tareas:

- El cálculo del coste del medidor suma los cuatro conceptos. Con un `NULL` en medio la suma da
  `NULL`, `cost_pico` queda nulo con `currency` no nulo, se viola `model_usage_cost_currency`, la
  inserción falla y el medidor —que nunca lanza— se come el error: **se perdería todo el registro de
  consumo de Gemini y OpenAI en silencio**. T022a lo cierra, T022b lo prueba.
- El `CHECK` de tokens existente **no** hay que tocarlo: con el valor nulo la expresión da nulo y un
  `CHECK` acepta todo lo que no sea falso. Anotado en T021a para que nadie lo «arregle».

**Y la confusión de raíz, ahora explícita en los cinco documentos**: `null` significa «este
proveedor no informa de este concepto» y sale de la tabla de capacidades; **no** significa «este
campo venía ausente en esta respuesta». Anthropic omite el campo de escritura de caché cuando una
respuesta no escribió nada, y el adaptador hace `?? 0`, que debe seguir igual. La lectura literal
—`?? null`— habría hecho que una instancia de Anthropic mostrase «sin dato» donde hoy muestra `0`,
afirmando en el panel algo falso sobre el proveedor. T030a prueba las dos direcciones.

También se corrigió la redacción de T024 y de la cabecera de la fase 2: el «comportamiento
idéntico» era demasiado absoluto y contradecía a T019. Lo exigible es que **nada observable cambie
para una instancia de Anthropic**, lo cual se sostiene porque los estados nuevos solo son
alcanzables con los proveedores que aún no existen.

Tareas: de 90 a **94** (T021a, T022a, T022b, T030a).

### Decisiones cerradas con valor razonable (sin preguntar)

Escritas en **Assumptions** y en los FR correspondientes:

- Proveedor ausente en el entorno equivale a Anthropic, para no tocar los entornos ya desplegados
  (FR-003).
- La tabla de precios conserva el nombre de modelo como clave: **sin migración y sin subir la
  versión del formato de configuración** (FR-037). El cambio de proveedor en una instancia viva
  dispara el aviso de «modelo sin precio» que ya existe, que es el comportamiento correcto.
- La validación de la **forma** de la credencial, sin red, es la primera defensa y la que cierra el
  agujero real (FR-028); la llamada real es un extra opcional.
- Las causas de fallo del dominio no crecen por proveedor: cada adaptador traduce a las cuatro que
  ya existen (FR-016).

### Alcance diferido al plan

La verificación de los parámetros equivalentes reales de cada proveedor (razonamiento interno,
mando de esfuerzo, salida estructurada, caché de contexto, señal de rechazo e información de
consumo) se deja a la investigación de `/speckit-plan`. La spec fija **qué** comportamiento es
obligatorio, no **cómo** lo consigue cada proveedor.

Dos asunciones son las que más riesgo cargan y conviene confirmar temprano en el plan:

1. que las credenciales de los tres proveedores son distinguibles por su forma, sin red (si no,
   FR-028 pierde alcance);
2. que los tres admiten obligar o inducir una salida estructurada con garantía suficiente.
