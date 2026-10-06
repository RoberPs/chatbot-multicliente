# Quickstart: validar la feature 009

Guía para comprobar de punta a punta la versión visible y la actualización escalonada. Detalle de
formatos en [contracts/](contracts/) y de datos en [data-model.md](data-model.md).

## Prerrequisitos

```bash
pnpm install
docker compose up -d db
cp .env.example .env && pnpm operator:hash-password   # si aún no tienes .env
# Añade a .env un HEALTH_SECRET propio (64 hex, distinto de SESSION_SECRET y BACKUP_KEY):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
pnpm db:migrate && pnpm dev                          # http://localhost:3000/admin
```

## 1. Estado público y completo (US1)

```bash
# Sin credencial: solo el estado
curl -i http://localhost:3000/health
#   200  {"status":"ok"}

# Con el secreto: versiones e identificador
curl -i -H "Authorization: Bearer $HEALTH_SECRET" http://localhost:3000/health
#   200  {"status":"ok","instanceId":…,"coreVersion":"0.1.0","schema":{"applied":{…},"expected":{…}}}

# Secreto incorrecto
curl -i -H "Authorization: Bearer 0000" http://localhost:3000/health
#   401  {"error":"unauthorized"}
```

Con `HEALTH_SECRET` vacío en `.env`, una petición sin cabecera da el nivel público y una con
cualquier `Authorization: Bearer …` da el mismo `401`: no se revela si la instancia tiene secreto.

Esperado: `coreVersion` = `version` de `package.json`; `schema.applied` = `schema.expected` = la última
migración de `src/db/migrations`; ningún otro campo.

**Panel**: inicia sesión en `/admin` y comprueba en el pie de cualquier pantalla «Núcleo 0.1.0 ·
Esquema 0005_config_transfer».

## 2. Degradado y no listo (US1, SC-004)

```bash
docker compose stop db
curl -i -H "Authorization: Bearer $HEALTH_SECRET" http://localhost:3000/health
#   503  {"status":"degraded",…,"schema":{"applied":null,…}}   (sin causa, sin direcciones)
curl -i http://localhost:3000/health            # 503 {"status":"degraded"}
docker compose start db
```

Esquema distinto: con la instancia parada, aplica en la BD una migración adicional de prueba (o usa
una imagen más antigua contra una BD más nueva) y comprueba `503 degraded` con `applied.tag: null` o
índices distintos. Esto lo cubre `tests/integration/health/`.

## 3. Versión de todo el parque (US2)

Con un inventario y entornos de ensayo (ver `instance:new` en la guía de operación) y dos o tres
instancias locales en puertos distintos:

```bash
export INSTANCE_INVENTORY=… INSTANCE_INVENTORY_KEY=…
pnpm instance:versions --allow-insecure          # tabla; localhost por http solo con la bandera
pnpm instance:versions --allow-insecure --json   # formato máquina
echo $?                                          # 0 todo coincide y correcto; 1 hay algo que revisar
```

Casos a provocar y resultado esperado en la fila:

| Provocar | Fila |
|---|---|
| Parar una instancia | `No responde`; las demás se ven igual |
| Anotar otra versión en el inventario (`instance:update <id> --image 9.9.9`) | `Coincide: NO` |
| Poner en el inventario la URL de otra instancia | `Identidad distinta`; sin versión |
| Instancia sin `/health` (imagen anterior) | `Sin información de versión` |
| Entorno sin `HEALTH_SECRET` | `Solo estado` |
| Secreto cambiado en la instancia | `Secreto rechazado` |
| Instancia sin `HEALTH_SECRET` y entorno con él | `Secreto rechazado` |

`pnpm instance:versions --allow-insecure --annotate` muestra los cambios y pregunta antes de
escribir; sin `--annotate` el fichero del inventario no cambia (compara su fecha de modificación).

Tiempo: con 10 instancias (3 apagadas) la orden termina en menos de 1 minuto (SC-002).

## 4. Alta con secreto de salud (FR-009b)

```bash
pnpm instance:new --id ensayo-01 …          # el entorno generado incluye HEALTH_SECRET
pnpm instance:check <entorno>               # apto; si lo quitas: error HEALTH_SECRET missing
pnpm instance:health-secret <id>            # instancia anterior: añade el secreto sin mostrarlo
pnpm instance:sync <id> <entorno>           # guarda su huella, no el valor
```

Comprueba además que copiar el `HEALTH_SECRET` de una instancia a otra hace que `instance:check`
de la segunda diga que el secreto está repetido.

## 5. Procedimiento de publicación (US3, SC-006)

Ensayo con una persona que no ha participado en la feature, usando solo la sección 5 de
`docs/operacion-multicliente.md`:

1. Instancia «pruebas» y instancia «cliente» de ensayo, ambas en la versión `0.1.0`.
2. Subir `package.json` a `0.1.1` con una migración inocua (añadir columna en una rama de ensayo),
   construir `chatbot:0.1.1` con `--build-arg CORE_VERSION=0.1.1` (comprobar que con `0.1.2` la
   construcción **falla**) y comprobar con `docker inspect` que la etiqueta OCI
   `org.opencontainers.image.version` es `0.1.1`.
3. Publicar en «pruebas», comprobar con `instance:versions --only` y el panel, y repetir la
   validación de copias.
4. Publicar en «cliente» provocando un fallo (p. ej. `BACKUP_DIR` inválido ⇒ `migration_blocked`):
   la persona debe detener la tanda, leer el motivo y recuperar con la guía.
5. Volver atrás (etiqueta anterior; y, con una migración incompatible simulada, restaurar la
   `premigration` con la imagen anterior).
6. Cierre: todo `Correcto` y `--annotate` deja el inventario con la versión final.

Criterio de aprobación: completa el ensayo sin consultar al desarrollador y cada paso tuvo una
orden o pantalla y un criterio de continuar/parar en la guía.

## 6. Suite automática

```bash
pnpm lint && pnpm typecheck
pnpm test                      # unit + contract + integration (Testcontainers)
pnpm test health               # solo la feature (patrón)
```

La feature no cambia la cadena de respuesta, así que `pnpm test:eval` no es necesaria; lo que sí
debe seguir en verde es toda la suite existente (008 incluida: la cobertura de columnas no se ve
afectada porque no hay migración).
