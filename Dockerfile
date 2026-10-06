# Imagen única del núcleo: la misma para todos los clientes; cada instancia se
# configura con variables de entorno y su propia base de datos (research R12).
#
# Versión (009, R4): CORE_VERSION es obligatoria y debe ser la de package.json; si no, la
# construcción falla. La etiqueta de la imagen es esa misma versión, nunca «latest»:
#   docker build --build-arg CORE_VERSION=X.Y.Z -t chatbot:X.Y.Z .
# y antes de desplegar se comprueba que coincide con la etiqueta OCI:
#   docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' chatbot:X.Y.Z

# Imagen base fijada por digest (013, FR-015): la misma base en las dos etapas y en cada
# construcción. Es el digest del índice multiplataforma (sirve en amd64 y arm64). Para
# actualizarlo (sección 5 de docs/operacion-multicliente.md):
#   docker buildx imagetools inspect node:22-slim     # campo «Digest»
# se cambia aquí, se construye, se pasan las pruebas y se publica como versión nueva del núcleo.
ARG NODE_IMAGE=node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS build
ARG CORE_VERSION
WORKDIR /app
# Corepack comprueba el hash de pnpm de `packageManager` al descargarlo (013, FR-016).
RUN corepack enable
# .npmrc: versiones exactas; package.json limita los scripts de instalación a argon2 y esbuild.
COPY package.json pnpm-lock.yaml .npmrc ./
COPY scripts ./scripts
RUN node scripts/check-version.mjs "$CORE_VERSION"
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${NODE_IMAGE}
ARG CORE_VERSION
LABEL org.opencontainers.image.version=$CORE_VERSION
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Copias de seguridad (006): BACKUP_DIR debe apuntar a un volumen persistente escribible por el
# usuario node, montado aquí o en otra ruta. Sin volumen, las copias se pierden con el contenedor.
# La clave (BACKUP_KEY) nunca se guarda en este directorio.
RUN mkdir -p /var/lib/chatbot/backups && chown node:node /var/lib/chatbot/backups \
  && chmod 700 /var/lib/chatbot/backups
VOLUME ["/var/lib/chatbot/backups"]
USER node
EXPOSE 3000
# Salud (013, FR-013/FR-014): la sonda pide la vista pública de /health (sin secreto, así no sale
# en `docker inspect`) y la instancia está sana solo con {"status":"ok"}. 120 s de gracia para
# las migraciones con copia previa; `--start-interval` necesita Docker Engine 25 o posterior (uno
# anterior lo ignora y sondea cada 30 s). Docker NO reinicia solo un contenedor `unhealthy`: la
# sección 2.5 de la guía dice qué hacer.
HEALTHCHECK --start-period=120s --start-interval=5s --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "dist/src/cli/healthcheck.js"]
# Al arrancar aplica las migraciones pendientes y sirve el panel.
CMD ["node", "dist/src/server.js"]
