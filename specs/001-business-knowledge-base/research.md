# Research: Base de conocimiento del negocio

**Feature**: `001-business-knowledge-base` | **Fecha**: 2026-09-24 | **Plan**: [plan.md](plan.md)

El repositorio no contiene código todavía: esta es la primera feature del núcleo, así que
las decisiones de stack que se toman aquí son las que heredarán las specs posteriores
(conversación por WhatsApp, disponibilidad, gestión de citas). Cada decisión se evalúa contra
la constitución (en especial II, IV, V y la restricción de aislamiento entre instancias).

---

## R1. Lenguaje y runtime

- **Decision**: TypeScript 5.x (modo `strict`) sobre Node.js 22 LTS.
- **Rationale**: el producto es I/O intensivo (webhooks de WhatsApp, llamadas a LLM, base de
  datos) y Node lo resuelve bien con un solo proceso. El ecosistema tiene SDK maduros para la
  WhatsApp Cloud API y para proveedores de LLM, que usarán las specs siguientes. Un único
  lenguaje para dominio, panel y bot simplifica el núcleo común (Principio I).
- **Alternatives considered**:
  - *Python 3.12 + FastAPI*: igual de válido para el bot; se descarta para no partir en dos
    lenguajes el panel (plantillas) y el dominio, y por tener tipado estático menos estricto
    en tiempo de compilación.
  - *Go*: excelente despliegue, pero más fricción para plantillas de formularios y para las
    integraciones con LLM.

## R2. Tipo de proyecto y panel web de administración

- **Decision**: un único servicio web (monolito modular) con Fastify 5. El panel se renderiza
  en servidor con plantillas Eta (`@fastify/view`) y usa htmx para enviar formularios y
  pintar los errores de validación junto al campo sin recargar la página.
- **Rationale**: FR-023a pide formularios por tipo de dato, validación al guardar con error en
  el propio campo y lista de avisos. Es un CRUD de un solo usuario (el operador): una SPA
  añade un segundo proyecto, un build de frontend y una API pública sin aportar nada. El
  renderizado en servidor mantiene una única fuente de validación.
- **Alternatives considered**:
  - *SPA (React/Vite) + API REST*: dos proyectos y duplicación de validación; innecesario
    para un único operador.
  - *Panel autogenerado (AdminJS, Directus)*: rápido de montar, pero las reglas de negocio
    (avisos, bloqueo por aviso crítico en negocio activo, FR-032) quedan fuera del modelo del
    framework y acaban en hooks difíciles de probar.

## R3. Almacenamiento y aislamiento entre instancias

- **Decision**: PostgreSQL 16, **una base de datos por instancia**. La instancia recibe su
  cadena de conexión por variable de entorno (`DATABASE_URL`). Acceso con Drizzle ORM y
  migraciones versionadas con `drizzle-kit`.
- **Rationale**: la constitución exige que datos y configuración de una instancia no sean
  accesibles desde otra, y FR-022 lo repite. Con una BD por instancia el aislamiento es
  físico: no existe columna `tenant_id` que se pueda olvidar en una consulta. Las mismas
  migraciones del núcleo se aplican a todas las instancias (Principio I). Postgres aporta
  transacciones, que son la base de FR-032 (ver R6), y tipos `date`/`time` nativos.
- **Alternatives considered**:
  - *BD compartida con `tenant_id` + Row Level Security*: menos bases que operar, pero el
    aislamiento pasa a depender de políticas correctas en cada tabla; se descarta frente a un
    requisito constitucional.
  - *SQLite por instancia*: muy simple, pero complica la concurrencia cuando el bot (specs
    futuras) escriba citas a la vez que el operador edita, y el backup/HA en contenedores.
  - *Prisma*: válido; se prefiere Drizzle por ser SQL explícito, sin motor binario y con
    tipos inferidos del esquema.

## R4. Validación de datos

- **Decision**: esquemas Zod en la capa de dominio como única fuente de validación. El panel
  los usa al guardar y traduce los `ZodError` a errores por campo. Reglas de formato:
  - Teléfono: `libphonenumber-js`; se acepta formato internacional o nacional con la región
    por defecto de la instancia (`DEFAULT_PHONE_REGION`, p. ej. `ES`), y se guarda
    normalizado en E.164.
  - Email: validador de Zod (`z.string().email()`), guardado en minúsculas.
  - Zona horaria: identificador IANA presente en `Intl.supportedValuesOf('timeZone')`.
- **Rationale**: FR-002, FR-006, FR-008 y FR-016 son reglas puras; tenerlas en un solo sitio
  permite probarlas con tests unitarios y reutilizarlas desde cualquier futuro punto de
  entrada. La región por defecto es configuración de instancia, no código (Principio II).
- **Alternatives considered**: validación solo con restricciones SQL (mensajes pobres, no
  sirven para señalar el campo en el formulario); validación en el cliente (duplicada).

## R5. Avisos: calculados, no almacenados

- **Decision**: los avisos se calculan con una función pura
  `computeWarnings(kb: KnowledgeState): Warning[]` sobre el estado actual. No se guardan en
  tabla. El panel los calcula al renderizar la lista; el guardado los recalcula para aplicar
  FR-032; la activación los recalcula para FR-031.
- **Rationale**: FR-027 exige que un aviso desaparezca en cuanto se corrige el dato. Si se
  calculan siempre a partir del estado, no hay avisos obsoletos que sincronizar. El volumen
  (decenas de servicios y recursos) hace el cálculo trivial (< 5 ms). Cada aviso lleva un
  código estable (catálogo en [contracts/warnings.md](contracts/warnings.md)), lo que hace
  verificable SC-004 con un test por código.
- **Alternatives considered**: tabla de avisos mantenida por triggers o eventos de dominio:
  más código y riesgo de desincronización sin ningún beneficio a esta escala.

## R6. Bloqueo de cambios que dejan un negocio activo sin salida a una persona (FR-032)

- **Decision**: toda escritura del panel se ejecuta en una transacción con el patrón
  *aplicar → recalcular avisos → confirmar o revertir*: se aplica el cambio, se carga el
  estado resultante dentro de la misma transacción, y si el negocio está activo y hay algún
  aviso crítico, se revierte y se devuelve el error indicando el aviso que lo provoca. La
  activación usa el mismo cálculo (FR-031). Las escrituras se serializan con
  `SELECT … FOR UPDATE` sobre la fila del negocio.
- **Rationale**: valida contra el estado resultante real, sin duplicar en cada formulario la
  lógica de "¿este cambio produciría un crítico?". Hoy solo existe un aviso crítico
  (`HANDOFF_UNREACHABLE`), pero el mecanismo es genérico si se añaden más. Protege el
  Principio V: nunca hay un negocio activo sin salida a una persona.
- **Alternatives considered**: validación previa específica por formulario (frágil, se olvida
  al añadir campos); restricción SQL (no expresa la regla con datos repartidos en varias
  tablas y no produce un mensaje útil).

## R7. Frescura de los datos para el bot (FR-020, FR-021, SC-003)

- **Decision**: el núcleo expone un puerto de lectura `KnowledgeReader.getSnapshot()` que
  devuelve la vista del bot (solo elementos activos, contacto de derivación efectivo,
  servicios reservables efectivos). **Se lee de la BD en cada respuesta del bot, sin caché.**
  Las conversaciones abiertas no guardan copia de los datos del negocio.
- **Rationale**: FR-021 exige que cualquier respuesta generada después de guardar use el dato
  nuevo, incluso en conversaciones abiertas. Sin caché, la garantía es trivial y verificable.
  El snapshot son unas pocas consultas sobre tablas pequeñas (objetivo p95 < 50 ms), un coste
  despreciable frente a la latencia de un LLM. Si más adelante hiciera falta caché, se
  invalidaría en la misma transacción de escritura (instancia de un solo proceso).
- **Alternatives considered**: caché en memoria con TTL (viola FR-021 durante el TTL);
  compilar la configuración en un fichero o prompt en cada guardado (añade un paso de
  publicación, más superficie de error).

## R8. Modelo temporal: horarios, cierres y ausencias

- **Decision**:
  - Las franjas semanales se guardan como hora local de pared (`time`, precisión de minutos)
    más día de la semana ISO (1 = lunes … 7 = domingo). La zona horaria IANA se guarda en el
    negocio y se aplica al interpretar las horas; no se convierte nada a UTC al guardar.
  - Las franjas no cruzan medianoche (FR-006: fin estrictamente posterior al inicio). Las
    franjas de un mismo día y propietario no pueden solaparse: se rechazan como dato inválido.
  - Cierres y ausencias: `start_date` y `end_date` (`date`, inclusivas) y opcionalmente
    `start_time`/`end_time`. Sin horas = días completos; con horas = ese rango en cada día
    del periodo. Se permiten solapes entre cierres; su efecto es la unión (edge case de la spec).
  - Las funciones puras `isOpenAt` y `effectiveIntervals(day)` se entregan en esta feature
    para fijar las reglas de prevalencia (FR-005, FR-012). El cálculo de huecos para citas
    pertenece a la spec de disponibilidad.
- **Rationale**: los horarios de un negocio son de pared y deben seguir los cambios de hora
  (DST) sin corrección manual. Guardar en UTC rompería "abrimos a las 9:00" dos veces al año.
- **Alternatives considered**: reglas iCalendar (RRULE): expresivas pero excesivas para un
  horario semanal y difíciles de editar en un formulario.

## R9. Importes, duración y antelaciones

- **Decision**:
  - Importe en céntimos (`integer`, ≥ 0) y moneda ISO 4217 en el negocio (por defecto `EUR`).
  - Duración en minutos (`integer`, > 0, nullable: la ausencia de duración es un estado
    permitido que genera aviso).
  - Antelación mínima y máxima guardadas ambas en minutos; el formulario permite introducirlas
    en minutos, horas o días. Así la comparación de FR-016 es directa.
- **Rationale**: sin errores de coma flotante; una sola unidad para comparar.

## R10. Autenticación del operador

- **Decision**: el panel exige sesión. Credencial del operador configurada por instancia
  (usuario y hash Argon2id en variables de entorno o secreto), sesión con cookie firmada
  `HttpOnly`, `Secure`, `SameSite=Strict` (`@fastify/secure-session`), protección CSRF en los
  formularios (`@fastify/csrf-protection`) y límite de intentos de login
  (`@fastify/rate-limit`). No existe ningún rol ni ruta para el negocio (FR-023).
- **Rationale**: la spec asume "el mecanismo estándar de administración de la instancia" y un
  único operador. Esto es lo mínimo seguro y no requiere tabla de usuarios. Si el operador
  gestiona muchas instancias, un SSO común se tratará en una spec de núcleo independiente.
- **Alternatives considered**: tabla de usuarios con roles (innecesaria para un único
  operador); autenticación básica HTTP (sin cierre de sesión ni CSRF razonables).

## R11. Pruebas

- **Decision**: Vitest para todo.
  - **Unitarias**: esquemas de validación, `computeWarnings` (un caso por código del
    catálogo), reglas temporales, construcción del snapshot.
  - **Integración**: repositorios y servicios contra PostgreSQL real con Testcontainers
    (transacción de FR-032, cascadas al borrar, activación).
  - **Contrato**: rutas del panel con `fastify.inject` (códigos, errores por campo, CSRF,
    acceso sin sesión) y forma del `KnowledgeSnapshot`.
  - **Neutralidad sectorial (SC-005)**: fixtures de tres negocios (clínica, peluquería,
    taller) cargados con el mismo modelo; y un test que busca nombres de sectores/clientes en
    `src/` para verificar el criterio del Principio I.
- **Rationale**: los Principios IV y V exigen pruebas en las features de conversación; esta
  feature no conversa, pero sí fija las garantías de datos en que se apoyan (solo lo activo
  llega al bot, siempre hay contacto de derivación en un negocio activo), y esas garantías
  se prueban aquí.

## R12. Despliegue

- **Decision**: una imagen de contenedor del núcleo, idéntica para todos los clientes. Cada
  instancia es un contenedor más su base de datos, parametrizado por variables de entorno.
  Las migraciones se ejecutan al arrancar (`drizzle-kit migrate`). Alta de un negocio o cambio
  de datos = operaciones en el panel, sin desplegar (SC-002).
- **Rationale**: cumple la restricción "una instancia por cliente construida a partir del
  núcleo común más su configuración".

---

## Resumen de NEEDS CLARIFICATION resueltos

| Tema | Resolución |
|------|------------|
| Lenguaje/versión | TypeScript 5.x, Node.js 22 LTS (R1) |
| Dependencias principales | Fastify 5, Eta + htmx, Drizzle ORM, Zod, libphonenumber-js (R2, R3, R4) |
| Almacenamiento | PostgreSQL 16, una BD por instancia (R3) |
| Testing | Vitest + Testcontainers + `fastify.inject` (R11) |
| Plataforma | Contenedor Linux por instancia (R12) |
| Tipo de proyecto | Servicio web único con panel renderizado en servidor (R2) |
| Rendimiento | Snapshot p95 < 50 ms; guardado en panel p95 < 300 ms (R7) |
| Frescura para el bot | Lectura sin caché por respuesta (R7) |
| Autenticación del operador | Sesión con credencial por instancia, CSRF, rate limit (R10) |
