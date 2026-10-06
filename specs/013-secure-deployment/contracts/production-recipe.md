# Contrato: receta de producción (§2.5 de `docs/operacion-multicliente.md`)

FR-019 a FR-023 y SC-006. Research R10. Es el índice de lo que debe contener la guía: cada paso
con su ejemplo y su **comprobación**. Los ejemplos usan nginx, `docker run` y Trivy como
herramientas sustituibles, sin proveedor de hosting ni nombres de cliente o sector (FR-021).

| # | Paso | Ejemplo | Comprobación |
|---|---|---|---|
| 1 | `instance:check` APTO con el entorno definitivo | `pnpm instance:check <fichero>` | Código de salida 0 |
| 2 | Fichero de entorno con dueño el operador y modo 0600, pasado con `--env-file` | `chown operador: cliente-x.env && chmod 600 cliente-x.env` | `stat -c '%U %a' cliente-x.env` da `operador 600` |
| 3 | Volumen de copias con dueño UID 1000 y modo 0700 | `install -d -o 1000 -g 1000 -m 700 /srv/chatbot/cliente-x/backups` | `stat -c '%u %a' …` da `1000 700` |
| 4 | Certificado de la autoridad de PostgreSQL (si no es pública) montado en solo lectura, y `sslmode=verify-full&sslrootcert=/etc/chatbot/db-ca.crt` en `DATABASE_URL` y en `BACKUP_VERIFY_URL` | `-v /srv/chatbot/db-ca.crt:/etc/chatbot/db-ca.crt:ro` | `instance:check` sin `database_tls_required`; la instancia arranca (si el certificado no vale, sale el mensaje de [database-tls.md](database-tls.md)) |
| 5 | Contenedor endurecido | `docker run -d --name cliente-x --read-only --tmpfs /tmp --cap-drop=ALL --security-opt no-new-privileges -p 127.0.0.1:3000:3000 --env-file cliente-x.env -v /srv/chatbot/cliente-x/backups:/var/lib/chatbot/backups … chatbot:X.Y.Z` | `docker inspect` muestra `ReadonlyRootfs=true`, `CapDrop=[ALL]` y `no-new-privileges`; el panel y una copia manual (`db:backup`) funcionan |
| 6 | Puerto 3000 solo en `127.0.0.1` o en una red interna | `-p 127.0.0.1:3000:3000` (o red interna sin `-p`) | `ss -ltn` muestra `127.0.0.1:3000`, no `0.0.0.0:3000`; desde otra máquina, `curl http://<ip>:3000/health` no conecta |
| 7 | Proxy inverso con TLS que **sustituye** la dirección de origen | nginx: `proxy_set_header X-Forwarded-For $remote_addr;` y `TRUST_PROXY=1` (los saltos reales) | Desde una máquina externa, 31 peticiones a `https://…/health` en menos de un minuto, cada una con un `X-Forwarded-For` falso distinto (`for i in $(seq 31); do curl -s -o /dev/null -w '%{http_code}\n' -H "X-Forwarded-For: 10.9.8.$i" https://…/health; done`): la última da 429, así que la instancia cuenta la dirección real y no la falsa. Desde otra máquina, en ese mismo minuto, sigue dando 200 |
| 8 | Servidor de verificación de copias separado del de producción, con un único usuario de verificación sin acceso a las bases de las instancias | `BACKUP_VERIFY_URL=postgres://verificador@verificacion:5432/postgres?sslmode=verify-full…`, usuario con `CREATEDB` | `db:verify` restaurable; `psql` con el usuario verificador a `chatbot_<id>` de producción es rechazado |
| 9 | Estado de salud del contenedor | (incluido en la imagen) | `docker inspect -f '{{.State.Health.Status}}' cliente-x` da `healthy` en menos de 2 min |
| 10 | Qué hacer si está `unhealthy` | — | La guía explica `docker inspect --format '{{json .State.Health}}'`, `pnpm instance:versions --only <id>` (`not_ready`, `degraded`, esquema distinto) y que Docker **no** reinicia solo: reiniciar a mano o con el orquestador, y antes revisar la BD |
| 11 | Integración continua | pasos: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm audit --prod`, `osv-scanner scan --lockfile pnpm-lock.yaml`, `gitleaks detect --source . -v`, `semgrep scan --config auto src/`, `docker build`, `trivy image --severity HIGH,CRITICAL --ignore-unfixed chatbot:X.Y.Z` | Bloquea la publicación: auditoría o osv con alta o crítica en producción; cualquier hallazgo de gitleaks sin revisar; semgrep `ERROR`; Trivy alta o crítica con corrección. Criterio de la §11.4 |
| 12 | Actualizar el digest de la imagen base | `docker buildx imagetools inspect node:22-slim` | La prueba de fijado pasa; dos construcciones con el mismo `NODE_IMAGE` parten de la misma base (`docker image inspect` → `RootFS` de la base igual) |

## Otras secciones que cambian

- **§2.3**: `instance:db` se niega a conectar con un servidor remoto sin `verify-full`; opción
  `--sslrootcert`; `verify-full` por defecto con `--print-sql --host` remoto.
- **§2.4**, tabla de variables:
  - `TRUST_PROXY`: obligatorio con `PUBLIC_BASE_URL` https;
  - `DATABASE_URL`, `BACKUP_VERIFY_URL` e `INSTANCE_DB_ADMIN_URL`: `sslmode=verify-full` con host
    remoto;
  - `BACKUP_VERIFY_URL`: fila nueva.
- **§5**: aviso. Desde la versión que incluye la 013, instancias que antes daban APTO con
  advertencias pueden dar NO APTO (`trust_proxy_empty`, `database_tls_required`). Antes de cada
  tanda, se pasa cada entorno por `instance:check` y se corrige. Además, cómo se actualiza el
  digest (paso 12).
- **§8**: `db:verify` limpia las bases temporales huérfanas y explica qué significa su línea.
