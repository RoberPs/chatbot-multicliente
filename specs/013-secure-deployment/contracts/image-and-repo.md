# Contrato: imagen y repositorio

FR-013 a FR-018. Research R6 a R8.

## Dockerfile

```dockerfile
ARG NODE_IMAGE=node:22-slim@sha256:<digest del índice, 64 hex>

FROM ${NODE_IMAGE} AS build
…
COPY package.json pnpm-lock.yaml .npmrc ./
…
FROM ${NODE_IMAGE}
…
USER node
EXPOSE 3000
HEALTHCHECK --start-period=120s --start-interval=5s --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "dist/src/cli/healthcheck.js"]
CMD ["node", "dist/src/server.js"]
```

Invariantes que comprueba la prueba estática:

- toda línea `FROM` usa `${NODE_IMAGE}` o una referencia `nombre:etiqueta@sha256:<64 hex>`;
- `NODE_IMAGE` conserva la etiqueta legible (`node:22-slim`);
- hay exactamente un `HEALTHCHECK` y apunta a `dist/src/cli/healthcheck.js`;
- el `HEALTHCHECK` no usa `curl` ni `wget`.

**Actualizar el digest** (va en la guía):

```bash
docker buildx imagetools inspect node:22-slim --format '{{json .Manifest.Digest}}'
```

Se cambia `NODE_IMAGE`, se construye, se pasan las pruebas y se publica como versión nueva del
núcleo (§5 de la guía).

## Sonda de salud (`dist/src/cli/healthcheck.js`)

| Respuesta de `GET http://127.0.0.1:$PORT/health` (sin `Authorization`, plazo 4 s) | Código de salida |
|---|---|
| 200 con cuerpo `{"status":"ok"}` | 0 (sana) |
| 503 `not_ready` o `degraded`, 429, otro código, cuerpo distinto, JSON no válido | 1 |
| conexión rechazada, error de red o plazo agotado | 1 |

- No escribe nada en la salida.
- `PORT` toma el valor de la variable de entorno del contenedor; sin ella, 3000.

Estados que ve la plataforma:

| Situación | Estado |
|---|---|
| Migrando, dentro de los 120 s de gracia | `starting` (los fallos no cuentan) |
| Primera respuesta `ok` | `healthy` (≈ 5 s después de empezar a escuchar) |
| Sin BD o con esquema distinto, 3 sondeos seguidos | `unhealthy` (≤ 95 s) |
| Cerrando (`not_ready`) | fallos; normalmente el contenedor termina antes de llegar a `unhealthy` |

Docker no reinicia un contenedor `unhealthy` por sí solo. La receta dice qué hacer.

## `package.json`

```json
{
  "packageManager": "pnpm@9.15.0+sha512.<128 hex>",
  "pnpm": { "onlyBuiltDependencies": ["argon2", "esbuild"] }
}
```

## `.npmrc`

```ini
save-exact=true
```

## `.gitignore`

Se añaden, en un bloque comentado:

```gitignore
# Certificados y claves privadas (013): nunca en el repositorio
*.pem
*.key
*.p12
```

Ningún fichero rastreado hoy coincide con esos patrones (comprobado: `git ls-files` vacío).
