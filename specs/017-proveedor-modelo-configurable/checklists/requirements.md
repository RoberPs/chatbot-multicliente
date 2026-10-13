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
