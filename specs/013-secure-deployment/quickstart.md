# Quickstart: validar el despliegue seguro

**Feature**: 013-secure-deployment · Recorrido de validación, de principio a fin. Las reglas
exactas están en [contracts/](contracts/) y el porqué en [research.md](research.md).

## Requisitos

- Repositorio en la rama de la feature, con `pnpm install` hecho.
- Docker en marcha (Engine 25 o posterior para `--start-interval`).
- `docker compose up -d db` para la BD local.
- Inventario de pruebas (`INSTANCE_INVENTORY`, `INSTANCE_INVENTORY_KEY`) con una instancia en
  producción y otra con `--status testing`, como en el quickstart de la 007.

## 1. Pruebas automáticas

```bash
pnpm lint && pnpm typecheck
pnpm test:unit        # reglas, URL, nombres de verificación, sonda, fijado de imagen y pnpm, .gitignore
pnpm test:integration # TLS con PostgreSQL real; limpieza de huérfanas
```

**Resultado esperado**: todo en verde. Ninguna salida capturada en las pruebas contiene una URL,
un host remoto, un usuario, una contraseña ni una ruta de certificado (SC-002).

## 2. `instance:check` (US1)

Parte de un entorno de producción APTO (`prod.env`) y cambia una cosa cada vez:

| Cambio en `prod.env` | Resultado esperado |
|---|---|
| `TRUST_PROXY=` | NO APTO, error `trust_proxy_empty` en `TRUST_PROXY` |
| sin `PUBLIC_BASE_URL` | NO APTO, `missing` en `PUBLIC_BASE_URL` |
| `DATABASE_URL=postgres://u:p@db.interna:5432/x` | NO APTO, `database_tls_required` en `DATABASE_URL`; la salida no contiene `db.interna` ni `u` |
| lo mismo con `?sslmode=require` | igual |
| `…?sslmode=verify-full` | sin ese error |
| `DATABASE_URL=postgres://u:p@127.0.0.1:5432/x` | sin error de TLS; advertencia `database_localhost` |
| `BACKUP_VERIFY_URL=postgres://u:p@10.0.0.5/postgres` | error propio en `BACKUP_VERIFY_URL` |
| `INSTANCE_DB_ADMIN_URL=postgres://a:b@10.0.0.5/postgres` | error propio en `INSTANCE_DB_ADMIN_URL` |

```bash
pnpm instance:check prod.env; echo "salida $?"   # 1 en cada fallo, 0 con todo correcto
pnpm instance:check prod.env --json               # mismos code/variable que el texto
```

Repite los fallos de `TRUST_PROXY` y TLS con la instancia de pruebas. Esperado: salen como
**advertencias** y el resultado puede ser APTO (SC-007).

## 3. `instance:db` (FR-007)

```bash
INSTANCE_DB_ADMIN_URL='postgres://admin:x@10.0.0.5:5432/postgres' pnpm instance:db cliente-x
```

**Esperado**: error `admin_url_tls_required` y salida 1. No se intenta conectar (vuelve al
instante, aunque `10.0.0.5` no exista), el inventario y el fichero de entorno no cambian, y la
salida no contiene la URL.

```bash
pnpm instance:db cliente-x --print-sql --host db.interna --sslrootcert /etc/chatbot/db-ca.crt
```

**Esperado**: imprime el SQL; la `DATABASE_URL` escrita lleva `sslmode=verify-full` y
`sslrootcert=/etc/chatbot/db-ca.crt` (compruébalo abriendo el fichero; no se muestra en la
salida).

## 4. Conexión con `verify-full` (FR-008)

Lo cubre la integración. A mano, con un PostgreSQL con TLS y certificado propio:

1. `DATABASE_URL=…?sslmode=verify-full&sslrootcert=<ca>` y `pnpm dev`. **Esperado**: arranca;
   `/health` responde `ok`.
2. Pon en la URL un nombre que no esté en el certificado (o `sslrootcert` con otra autoridad).
   **Esperado**: no arranca y muestra
   `DATABASE_URL: el certificado del servidor no es válido para ese nombre…`, sin el nombre.
   Con una IP no sirve: `pg` no pasa la IP a TLS y compara el certificado con `localhost`
   (encontrado al implementar; la guía pide usar siempre el nombre).
3. Pon `sslrootcert=/no/existe.crt`. **Esperado**: `DATABASE_URL: no se puede leer el
   certificado de la autoridad…`, sin la ruta.
4. Con la URL buena, ejecuta `pnpm db:backup` y `pnpm db:verify <copia>`. **Esperado**: las dos
   funcionan.

## 5. Bases huérfanas de `db:verify` (US2)

```bash
# Simula verificaciones interrumpidas en el servidor de verificación (aquí, la BD local):
docker compose exec db psql -U chatbot -c "create database verify_20260101000000_0123456789abcdef"
docker compose exec db psql -U chatbot -c "create database verify_0123456789abcdef"
docker compose exec db psql -U chatbot -c "create database verify_otra_cosa"
pnpm db:backup && pnpm db:verify <copia>
```

**Esperado**:

- la salida dice `Bases temporales huérfanas: 2 borradas.`;
- `verify_otra_cosa` sigue existiendo (`\l`);
- con `--json`, `"orphans":{"listed":true,"removed":2,"failed":0}`;
- ningún nombre de base en la salida.

Otros casos:

- **Base en uso**: abre `psql` contra una huérfana del formato anterior y ejecuta `db:verify`.
  **Esperado**: no se borra ni se cuenta.
- **Otro usuario no entra**: durante una verificación larga (copia grande), intenta
  `psql -U usuario_sin_privilegios -d verify_…`. **Esperado**: `permission denied for database`.

## 6. Imagen (US3)

```bash
docker build --build-arg CORE_VERSION=$(node -p "require('./package.json').version") -t chatbot:prueba .
docker image inspect chatbot:prueba --format '{{json .Config.Healthcheck}}'
```

**Esperado**: el `Healthcheck` muestra `node dist/src/cli/healthcheck.js`, 120 s de gracia, 30 s
de intervalo y 3 reintentos.

- **Sana**: arráncala con la BD disponible y consulta
  `docker inspect -f '{{.State.Health.Status}}'` cada pocos segundos. **Esperado**: `starting` y
  después `healthy` en menos de 2 minutos (SC-004).
- **Enferma**: para la BD (`docker compose stop db`). **Esperado**: `unhealthy` en menos de
  3 minutos; `/health` responde `degraded`.
- **Reproducible**: vuelve a construir otro día (o con `--no-cache`) y compara
  `docker image inspect -f '{{json .RootFS.Layers}}'`. **Esperado**: las capas de la base son las
  mismas (SC-005).
- **Scripts no autorizados**: en una rama de prueba, añade una dependencia con `postinstall` (por
  ejemplo, un paquete local con `"postinstall": "node -e \"require('fs').writeFileSync('HECHO','')\""`)
  y ejecuta `pnpm install`. **Esperado**: el fichero `HECHO` no se crea y pnpm avisa de que se ha
  ignorado el script. Después, descarta la rama.
- **Claves ignoradas**: `touch x.pem x.key x.p12 && git status --ignored --short`. **Esperado**:
  aparecen como `!!` (ignorados). Después, `rm x.pem x.key x.p12`.

## 7. Receta de producción (US4, SC-006)

Una persona que no haya trabajado en la feature sigue la §2.5 de la guía en una máquina limpia
con la imagen del paso 6. **Esperado**:

- cada comprobación de [contracts/production-recipe.md](contracts/production-recipe.md) se cumple,
  en especial que el puerto 3000 no responde desde fuera y que la prueba de `X-Forwarded-For`
  falso da 429 en la petición 31;
- no ha tenido que preguntar nada; anota cualquier duda como fallo de la receta.

## 8. Cierre

Antes de dar la feature por terminada, avisa al usuario y actualiza:

- `README.md` (estado de la 013);
- `docs/operacion-multicliente.md`: §9.1 con la fecha, §9.2, P9 marcada como hecha, y las §2.3,
  §2.4, §2.5, §5 y §8.
