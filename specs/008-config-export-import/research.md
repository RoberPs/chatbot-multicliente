# Research: Exportar e importar la configuración del negocio

**Feature**: 008-config-export-import | **Fecha**: 2026-09-30

Decisiones técnicas del plan. Cada una: decisión, motivo y alternativas descartadas. No quedan
incógnitas abiertas.

---

## R1. Formato del fichero: JSON canónico con sobre y versión

**Decisión**: un único fichero JSON en UTF-8 sin BOM, con sangría de 2 espacios, claves en un
orden fijo y salto de línea final. El sobre lleva `format: "business-config"`, `formatVersion`
(entero; esta feature define la **1**), `exportedAt` (ISO 8601 UTC), `source.instanceId`
(`INSTANCE_ID` o `null`), `source.schema` (etiqueta de la última migración del núcleo de origen,
p. ej. `0005_config_transfer`), `includesAlertDestinations` e `info` (estado del negocio y del chat
web, solo informativo). Después, una clave por sección (FR-002). Formato completo en
[contracts/config-file-format.md](contracts/config-file-format.md).

Los valores van **en la forma del dominio**, no en la del formulario: importes en céntimos,
plazos en minutos, horas `HH:MM`, fechas `AAAA-MM-DD`, días ISO (1 = lunes), teléfonos en E.164.
Nombre de descarga: `configuracion-<instancia|instancia>-<AAAAMMDD-HHMM>.json` (hora UTC).

**Motivo**: JSON se lee y se compara con cualquier editor o `diff`, Node lo analiza sin
dependencias y Zod lo valida con los mismos esquemas primitivos del dominio. El orden fijo de
claves hace que dos exportaciones de la misma configuración sean idénticas salvo `exportedAt`
(útil para SC-002 y para revisar cambios con `git diff` fuera del repositorio).

**Alternativas descartadas**: YAML (dependencia nueva y ambigüedades de tipos: `no`, `09:00`);
un ZIP con un fichero por sección (menos legible y sin ventaja con < 5 MB); reutilizar el
formato de copia de la 006 (binario cifrado, con toda la BD).

## R2. Referencias sin identificadores internos (FR-006)

**Decisión**: ningún UUID de la instancia sale en el fichero. Los recursos citan sus servicios
**por nombre** (`services: ["Nombre del servicio"]`); el nombre de servicio y de recurso ya es
único sin distinguir mayúsculas (índices `lower(name)`). Al importar, la referencia se resuelve
con la misma normalización (`trim` + minúsculas) y una referencia a un servicio que no está en el
fichero es un error de validación (`resources[i].services[j]`).

**Motivo**: los nombres son la clave natural que ya garantiza la BD; el fichero sigue siendo
legible y editable a mano.

**Alternativas descartadas**: claves locales del fichero (`"ref": "s1"`), que obligan a mantener
dos identificadores y hacen el fichero menos legible; los UUID de origen, que acoplan instancias.

## R3. Validación: esquema estricto del fichero con los primitivos del dominio (FR-007 – FR-010)

**Decisión**: `src/config-transfer/schema.ts` define el esquema Zod de la versión 1 con
`z.strictObject` en todos los niveles (un campo desconocido es error, FR-010) y **reutiliza los
primitivos** de `src/knowledge/schemas/common.ts` y compañía: `trimmedText`, `optionalText`,
`optionalHttpsUrl`, `phone`/`email`, `timezone`, `currency`, `localTime`, `isoDate`,
`weeklySlotsSchema` (fin > inicio y sin solapes), `refineDateRange`, los límites de
`serviceSchema`/`policiesSchema`/`faqSchema`, el `parseOrigin` y los topes de
`webchat/schemas.ts` y `handoffAlertsSchema`. Para no duplicar reglas, se extraen de esos módulos
los esquemas de campo que hoy están embebidos en el esquema del formulario (p. ej. el origen
normalizado del chat web, la duración 1–1440, el tope ≥ 1), sin cambiar su comportamiento en el
panel. Reglas entre elementos: nombres de servicio y de recurso únicos, preguntas con texto no
vacío, medios de derivación sin repetir, formas de pago sin repetir, referencias recurso→servicio
resueltas, `monthlyCap ≥ dailyCap`, `minAdvance ≤ maxAdvance`.

Diferencias deliberadas con el formulario, documentadas en el contrato:

- **Duplicados**: el formulario de políticas descarta en silencio las formas de pago repetidas;
  el fichero las **rechaza**, para no perder datos en silencio (misma idea que FR-010).
- **Nombre del negocio vacío**: se admite `""` solo porque es el valor inicial de una instancia
  recién migrada (la exportación de un negocio en preparación sin datos debe poder importarse,
  US1-4). El resto de campos del negocio siguen las reglas del panel.
- **Importes**: el fichero trae `priceCents` entero ≥ 0 (no el decimal del formulario); con
  `on_request`, `priceCents` debe ser `null`.

Todos los errores se recogen de una vez (Zod no se detiene en el primero) y se traducen a
`{ section, item, field, message }`, donde `item` es el nombre o la pregunta del elemento o, si no
lo tiene, su posición (`n.º 3`). Mensajes en español, los mismos del panel cuando la regla es la
misma.

**Motivo**: FR-007 exige "las mismas reglas que el panel"; reutilizar los primitivos lo
garantiza y un cambio futuro de regla llega a los dos sitios. El esquema estricto evita perder
datos en silencio.

**Alternativas descartadas**: convertir el fichero a la forma del formulario y pasarlo por los
esquemas del panel (errores con rutas del formulario, preprocesos que aceptan cosas que el
fichero no debe aceptar, y descartes silenciosos); validar solo con las restricciones de la BD
(errores de uno en uno y sin mensaje comprensible).

## R4. Versiones del formato y compatibilidad (FR-009)

**Decisión**: `CURRENT_FORMAT_VERSION = 1` y una cadena de "actualizadores" `vN → vN+1` (vacía en
esta feature). Al leer: `formatVersion > CURRENT` → rechazo `future_version` con el esquema de
origen en el mensaje ("actualiza esta instancia a un núcleo con la migración `…` o posterior");
versión soportada < CURRENT → se aplica la cadena y el resultado se valida con el esquema actual;
versión fuera de la lista soportada → `unsupported_version`. Regla para specs futuras, recogida en
el contrato: **toda migración que añada o cambie configuración del negocio sube `formatVersion` y
añade su actualizador** con el valor por defecto de lo nuevo; la vista previa muestra ese valor
como cambio (caso límite de la spec).

Un test de cobertura compara las columnas de las tablas de configuración de `src/db/schema.ts`
con las que cubre el formato (lista explícita de columnas excluidas: `id`, `updated_at`,
`sort_order`, `status`, `enabled`…): una columna nueva sin tratar hace fallar el test.

**Motivo**: la versión del formato es independiente de la del esquema (muchas migraciones no
tocan la configuración); el test evita que una columna nueva se quede fuera de la exportación sin
que nadie lo note.

**Alternativas descartadas**: usar la versión del esquema como versión del formato (rechazaría
ficheros por migraciones que no afectan a la configuración).

## R5. Subida del fichero: `@fastify/multipart` solo en la ruta de importación

**Decisión**: añadir la dependencia oficial `@fastify/multipart` y registrarla **solo** en el
contexto encapsulado de `POST /admin/config/import`, con `attachFieldsToBody: 'keyValues'` y
límites `files: 1`, `fileSize: 5 MiB`, `fields: 2`, `fieldSize: 1 KiB`, `parts: 3`, y `bodyLimit`
de ruta de 6 MiB. Un fichero que supera el tamaño se corta en la lectura y se responde 413 con el
máximo en el mensaje, sin analizarlo (FR-010, caso límite). El token CSRF va en el campo `_csrf`
del formulario (y en la cabecera `x-csrf-token` cuando htmx envía el formulario), y lo comprueba
el mismo `csrfOnPost` del panel, que corre en `preHandler`, después de leer el cuerpo.

El resto del panel sigue aceptando solo `application/x-www-form-urlencoded` con 256 KiB.

**Motivo**: un `<input type="file">` en un formulario normal envía `multipart/form-data`; es la
única forma de subir un fichero sin JavaScript y sin codificarlo a mano. El plugin es del equipo
de Fastify y se limita a una ruta.

**Alternativas descartadas**: pegar el JSON en un textarea (mala experiencia con ficheros grandes
y cuerpos urlencoded de hasta 3× el tamaño); leer el fichero con JavaScript y enviarlo como texto
(el panel funciona sin JS por diseño); escribir un analizador multipart propio.

## R6. Vista previa: aplicar y revertir en una transacción ("ensayo")

**Decisión**: la vista previa **ejecuta la misma función de reemplazo** que la confirmación
dentro de una transacción con el bloqueo del negocio y la **revierte siempre** al terminar:
`previewWrite(db, fn)` en `src/knowledge/services/guarded-write.ts` hace `lockBusiness → estado
antes → fn → estado después (con las vías de aviso de la instancia) → computeWarnings →
ROLLBACK` y devuelve antes, después, avisos y si la regla de avisos críticos rechazaría el cambio.
El diff por secciones (R8) se calcula entre el documento de la configuración actual y el que
resulta del ensayo, leídos en esa misma transacción.

**Motivo**: la vista previa predice exactamente lo que hará la confirmación —mismo código,
mismas restricciones de la BD, mismo `computeWarnings`— sin mantener un segundo constructor de
`KnowledgeState` en memoria que tendría que imitar a la BD. FR-014 se cumple porque la transacción
nunca se confirma (test: huella de la BD idéntica antes y después). El bloqueo dura lo que el
ensayo (< 1 s con el tamaño de SC-007) y no afecta al bot, que lee sin bloquear.

**Alternativas descartadas**: construir el estado resultante en memoria (duplica la lógica de
carga y puede divergir de la BD); guardar la importación en tablas "borrador" (mucho más
esquema para una operación puntual).

## R7. Aplicación todo o nada con la escritura protegida (FR-015 – FR-022)

**Decisión**: la confirmación usa `runTrackedWrite` (la escritura protegida de la 001: bloqueo del
negocio → aplicar → recalcular avisos → revertir si un negocio activo queda con un aviso
crítico). Dentro de la misma transacción, en este orden:

1. Recalcular la **huella de la configuración actual** (R9) y compararla con la de la vista previa
   que confirmó el operador; si difiere → `ConfigChangedError` (FR-019).
2. Comprobar el **chat web**: si está activado en el destino y el fichero lo dejaría sin webs
   permitidas o sin enlace de privacidad → `WebChatWouldBreakError` (el panel tampoco deja
   guardar eso con el chat activado; R3).
3. Guardar la **configuración anterior** (exportación con destinos de avisos) en la fila única de
   `config_pre_import` (FR-022).
4. **Reemplazar** la configuración (`replaceConfig`), sin tocar `business.status` ni
   `web_chat_settings.enabled` (FR-017), y los destinos de avisos solo si el fichero los trae y el
   operador lo eligió (FR-021).

Cualquier error —incluida una caída de la conexión— revierte todo, también el paso 3, así que una
importación rechazada no sustituye la copia anterior (FR-022).

Estrategia de reemplazo (`replaceConfig`), con inserciones en lote:

- **Servicios y recursos**: se emparejan por nombre normalizado; los emparejados se actualizan
  **conservando su UUID** (enlaces del panel abiertos y trazas de "Probar el bot" siguen
  apuntando al mismo elemento), los que no están en el fichero se borran y los nuevos se insertan.
  `sort_order` = posición en el fichero. Enlaces recurso–servicio, horarios y ausencias de los
  recursos se sustituyen enteros.
- **Preguntas frecuentes**: se emparejan por pregunta normalizada (en orden si hay repetidas); el
  resto como los servicios.
- **Horario, cierres, horario y medios de derivación**: se sustituyen enteros (no tienen
  identidad propia útil).
- **Filas únicas** (`business`, `policies`, `tone`, `handoff_contact`, `web_chat_settings`,
  `handoff_alerts`): `UPDATE` de sus columnas de configuración; `policies`, `tone` y
  `handoff_contact` se borran si el fichero trae `null`.

`updated_at` solo cambia en las filas escritas; el bot lee el snapshot sin caché y usa la
configuración importada desde la siguiente respuesta (FR-020), sin tocar conversaciones ni
derivaciones en curso (FR-017, caso límite).

**Motivo**: reutiliza la regla FR-032 tal cual y cumple FR-015 con una única transacción de
PostgreSQL.

**Alternativas descartadas**: borrar e insertar todo (cambia todos los UUID y todas las marcas de
tiempo aunque nada cambie; SC-002 dejaría de ser "sin cambios" en la BD); aplicar por secciones
en varias transacciones (incumple FR-015).

## R8. Diff por secciones (FR-011, FR-020)

**Decisión**: `diffConfig(actual, nuevo)` es una función pura sobre dos documentos del formato
(R1) y devuelve, por sección, `added`, `modified` (con `{ field, before, after }` por campo que
cambia), `removed` y `reordered`. Claves de emparejamiento: servicios y recursos por nombre
normalizado; preguntas por pregunta normalizada; cierres y ausencias por fechas y horas (el
motivo es un campo); medios de derivación por tipo y valor; franjas semanales comparadas por día
("lun: 09:00–14:00 → 09:00–13:30"); filas únicas campo a campo. Marcas destacadas:
`timezoneChanged`, `currencyChanged`, `sameInstance` (mismo `INSTANCE_ID`, si los dos lo tienen)
y, si el chat web del destino está activado, `webChat.removedOrigins` y cambios de topes.
El documento "nuevo" es el que resulta del ensayo (R6), no el fichero tal cual, así que ya incluye
las excepciones de FR-017 y FR-021. El resultado de la aplicación (FR-020) es el mismo diff más los
avisos vigentes.

**Motivo**: función pura y probada con tablas; comparar documentos del mismo formato evita
comparar filas con identificadores distintos.

## R9. Detección de cambios entre vista previa y confirmación (FR-019)

**Decisión**: la **huella de la configuración** es SHA-256 del documento canónico de la
configuración actual **con** destinos de avisos, estado del negocio y activación del chat web
(todo lo que puede cambiar el resultado de la importación). La vista previa la calcula dentro de
su transacción y la pone en un campo oculto del formulario de confirmación; la confirmación la
recalcula tras el bloqueo y, si no coincide, rechaza con 409 y pide una vista previa nueva.

**Motivo**: `max(updated_at)` no detecta borrados (borrar una pregunta no aumenta el máximo) ni
cubre `web_chat_settings` y `handoff_alerts`; la huella del documento sí, y ya existe el
serializador canónico.

## R10. Fichero pendiente entre la subida y la confirmación

**Decisión**: el documento validado se guarda **en memoria del proceso** (`PendingImports`) con
un identificador aleatorio de 128 bits, la época de la sesión del operador y caducidad de 30 min;
como máximo 5 pendientes (el más antiguo se descarta). La vista previa, la confirmación y la
cancelación lo buscan por ese identificador; si no existe o caducó, se pide subir el fichero de
nuevo. Tras aplicar, el resultado se guarda en la misma entrada (para mostrarlo tras la
redirección) y la entrada ya no admite otra confirmación. Al caducar o cancelar se registra
`config_import_cancelled`.

**Motivo**: cada instancia es un único proceso con un único operador; un reinicio entre la
vista previa y la confirmación solo obliga a subir el fichero otra vez. Evita tablas temporales
con datos que no son configuración.

**Alternativas descartadas**: devolver el fichero en un campo oculto (hasta 5 MB en cada página);
tabla `pending_import` (persistencia innecesaria y limpieza aparte).

## R11. Configuración anterior a la importación (FR-022)

**Decisión**: tabla nueva `config_pre_import` de una sola fila (migración `0005_config_transfer`,
solo añadir) con el fichero exportado (`content text`, el JSON canónico tal cual se descargará),
la hora de la importación a la que precede y el `INSTANCE_ID` de origen del fichero importado. Se
sustituye con `INSERT … ON CONFLICT (id) DO UPDATE` en la transacción de la importación. El panel
la ofrece en `GET /admin/config/pre-import` y en la página de resultado. No forma parte de la
exportación, del snapshot ni de los avisos; entra en las copias de la 006 como cualquier tabla
(el volcador recorre todas).

**Motivo**: la copia tiene que sobrevivir a reinicios y existir aunque el operador no la
descargue en el momento.

## R12. Registros de exportación e importación (FR-024)

**Decisión**: catálogo cerrado de eventos en `src/config-transfer/log.ts`, emitidos con el logger
de Fastify (`channel: 'config'`): `config_exported`, `config_import_previewed`,
`config_import_applied`, `config_import_rejected` (con `stage` y `reason`) y
`config_import_cancelled`. Solo llevan números (recuentos por sección), códigos, booleanos y el
`INSTANCE_ID` de origen (validado con `INSTANCE_ID_PATTERN`); ningún campo de texto libre, así que
no pueden llevar nombres, teléfonos, correos ni textos de la configuración. Catálogo en
[contracts/transfer-log.md](contracts/transfer-log.md).

**Motivo**: mismo enfoque que el registro del bot (002) y de las copias (006); un test recorre los
eventos emitidos en los tests de contrato y busca los valores de la configuración de prueba.

## R13. Rendimiento (SC-007)

**Decisión**: una lectura del estado (la consulta única de `loadKnowledgeState`, más
`web_chat_settings` y `handoff_alerts`) y escrituras en lote (`INSERT … VALUES` de varias filas
por tabla, `DELETE … WHERE id NOT IN (…)`) dentro de una transacción. Con 200 servicios,
50 recursos (con ~10 franjas y ~20 servicios cada uno) y 200 preguntas son ~2 000 filas: decenas
de sentencias en total. Objetivo < 1 s por operación en local; SC-007 pide < 5 s y lo comprueba un
test de integración con ese tamaño.
