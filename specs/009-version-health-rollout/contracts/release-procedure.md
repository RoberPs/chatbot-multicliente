# Contrato: procedimiento de publicación escalonada

Contenido normativo que sustituye a la sección 5 («Actualizar el núcleo») de
[docs/operacion-multicliente.md](../../../docs/operacion-multicliente.md) (FR-016 – FR-019). Cada
etapa tiene **comprobación** (orden o pantalla), **resultado esperado** y **criterio** para
continuar o parar. La guía final puede reformular el texto, pero no perder ninguna fila de este
contrato. Decisiones en [research.md](../research.md) R4, R5 y R10.

## Etapas

### 0. Antes de la primera vez (una vez por instancia)

| Comprobación | Esperado | Si no |
|---|---|---|
| `pnpm instance:health-secret <id>` (instancias anteriores a la 009) y despliegue del entorno | La instancia responde `/health` completo | No publicar a esa instancia hasta tenerlo: no se podrá comprobar su versión |
| `pnpm instance:sync <id> <entorno>` y `pnpm instance:check <entorno>` | `apto`, con `HEALTH_SECRET` presente y no repetido | Corregir lo que indique |
| `pnpm instance:versions` | Todas las instancias en `Correcto` y «Coincide: sí» | Resolver antes de empezar (una instancia ya degradada no es un buen punto de partida) |
| Si un monitor o balanceador consulta `/health`, revisar su intervalo | Cada 10 s o más (límite: 30 por minuto y por IP) | Ampliar el intervalo: con menos, recibe `429` y da la instancia por caída |

### 1. Comprobaciones previas (en tu equipo)

| Comprobación | Esperado | Criterio |
|---|---|---|
| Subir `version` en `package.json` (semántica) y commit | Un solo número nuevo | — |
| `pnpm lint && pnpm typecheck && pnpm test` | Verde | **Parar** si falla |
| `pnpm test:eval` y `EVAL_CHANNEL=web pnpm test:eval` | Sin regresiones en los criterios | **Parar** si hay regresión |
| Revisar las migraciones nuevas: solo añadir, ficheros publicados intactos | Cumple las reglas de la 006 | **Parar** si se editó una migración publicada |
| Etiqueta Git `vX.Y.Z` y `docker build --build-arg CORE_VERSION=X.Y.Z -t chatbot:X.Y.Z .` | La construcción termina; si `CORE_VERSION` ≠ `package.json`, falla | **Parar** si falla. Nunca `latest` |
| `docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' chatbot:X.Y.Z` | Imprime `X.Y.Z`, igual que la etiqueta `-t` | **Parar** si difiere: la etiqueta no la controla el `Dockerfile` |

### 2. Instancia de pruebas

| Comprobación | Esperado | Criterio |
|---|---|---|
| Desplegar `chatbot:X.Y.Z` en la instancia de pruebas (datos ficticios, entorno como producción) | Arranca; si había migraciones, se hizo la copia `premigration` | **Parar** si `migration_blocked` / `migration_failed` en los registros (ver «Vuelta atrás») |
| `pnpm instance:versions --only <pruebas>` | `Correcto`, núcleo = `X.Y.Z`, esquema = el esperado | **Parar** en cualquier otra fila |
| Panel: pie «Núcleo X.Y.Z · Esquema …» y «Probar el bot» con 3 preguntas conocidas | Versión correcta; respuestas coherentes con la configuración | **Parar** si no |
| Repetir la validación de copias (sección 8) con la `premigration`, si hubo migraciones | Verificación correcta | **Parar** si falla |

### 3. Tandas de clientes

Tandas pequeñas (una o dos instancias) en orden de menos a más crítica. Para cada instancia de la
tanda:

1. Desplegar `chatbot:X.Y.Z` en esa instancia (un solo cambio: la etiqueta).
2. **Comprobación tras actualizar** (menos de 2 minutos, SC-005):
   - `pnpm instance:versions --only <id>`
   - Panel de la instancia: pie con la versión y esquema esperados, y sin avisos nuevos.

| Resultado de `instance:versions` | Significado | Criterio |
|---|---|---|
| `Correcto`, núcleo = `X.Y.Z`, «Coincide» «NO» (por la anotación vieja) | Actualizada bien; falta anotar | Continuar; anotar en el cierre |
| `Correcto` con otra versión | Se desplegó otra etiqueta | **Parar la tanda**; corregir el despliegue |
| `Degradado` | BD o esquema distinto del esperado | **Parar la tanda**; ver «Vuelta atrás» |
| `No lista` | Arrancando o parándose | Esperar 1 minuto y repetir; si persiste, **parar la tanda** |
| `No responde` | Aún migrando (mientras migra no escucha), no arrancó (p. ej. `migration_blocked`) o red | Esperar a que termine la migración y repetir; si persiste o los registros muestran `migration_blocked`/`migration_failed`, **parar la tanda** |
| `Identidad distinta` | URL del inventario apunta a otra instancia | **Parar la tanda**; corregir la URL (`instance:update`) antes de seguir |
| `Secreto rechazado` / `Solo estado` / `Sin información de versión` | No se puede verificar («Secreto rechazado» también sale si la instancia aún no tiene desplegado su `HEALTH_SECRET`) | **Parar la tanda**: sin verificación no se continúa |

La tanda siguiente solo empieza cuando todas las instancias de la actual están `Correcto` con la
versión nueva.

### 4. Vuelta atrás

| Situación | Acción | Comprobación posterior |
|---|---|---|
| La migración **no se aplicó** (`migration_blocked`, o falló antes de cambiar el esquema; el error nombra «esquema sin cambios») | Arreglar la causa (p. ej. `BACKUP_DIR`, disco) y reiniciar; o volver a desplegar `chatbot:<anterior>` | `instance:versions --only <id>`: `Correcto` y versión anterior |
| La migración **se aplicó** y la versión nueva falla, y la anterior es compatible hacia atrás (migración solo añadir) | Volver a desplegar `chatbot:<anterior>` | `instance:versions`: puede salir `Degradado` por esquema distinto; el panel muestra ambas versiones. Si el negocio sigue atendido y es compatible, mantener y programar la corrección |
| La migración **se aplicó** y **no es compatible** (`migration_failed`, o `Degradado` por esquema por delante con la instancia caída) | **Parar** la instancia; con la **imagen anterior**, `node dist/src/cli/restore.js <fichero premigration>` (el error lo nombra) | `instance:versions`: `Correcto`, versión anterior, esquema anterior; repetir la validación de copias |

Tras volver atrás, **no** continuar con las tandas siguientes. Detener la publicación hasta publicar
una versión corregida (nuevo número de versión, no se reutiliza uno ya desplegado).

### 5. Cierre

| Comprobación | Esperado |
|---|---|
| `pnpm instance:versions` con todas las instancias | Todas `Correcto` en `X.Y.Z` |
| `pnpm instance:versions --annotate` (revisar la lista y confirmar) | El inventario recoge `X.Y.Z`; una segunda ejecución da «Coincide: sí» y código 0 |
| Si hubo migraciones: repetir la guía de validación de copias (sección 8) con una copia posterior a la actualización de cada instancia | Verificación correcta |
| Anotar en el registro de la publicación fecha, versión, tandas y incidencias | — |

## Qué debe reflejar la guía de operación (FR-020)

- Sección 5 reescrita con las etapas de arriba; sección 2.2 y 2.4: `HEALTH_SECRET` en el entorno
  generado y en la validación; tabla de variables con `HEALTH_SECRET`.
- Sección 9.1: fila de la 009 con fecha; 9.2: P6 marcada como **Hecha**, el resto del orden
  renumerado; propuesta P6 marcada como hecha.
- README: estado de la feature 009 y las órdenes nuevas (avisando antes al usuario).

## Validación del procedimiento (SC-006)

Ensayo con una persona que no ha participado: dos instancias de ensayo (una de pruebas y una
«cliente»), publicar una versión con migración, provocar un fallo simulado (apagar la BD o desplegar
con `BACKUP_DIR` inválido) y volver atrás solo con la guía. Pasos y criterios en
[quickstart.md](../quickstart.md) §5.
