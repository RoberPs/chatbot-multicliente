# Imagen única del núcleo: la misma para todos los clientes; cada instancia se
# configura con variables de entorno y su propia base de datos (research R12).
#
# Versión (009, R4): CORE_VERSION es obligatoria y debe ser la de package.json; si no, la
# construcción falla. La etiqueta de la imagen es esa misma versión, nunca «latest»:
#   docker build --build-arg CORE_VERSION=X.Y.Z -t chatbot:X.Y.Z .
# y antes de desplegar se comprueba que coincide con la etiqueta OCI:
#   docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' chatbot:X.Y.Z

FROM node:22-slim AS build
ARG CORE_VERSION
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY scripts ./scripts
RUN node scripts/check-version.mjs "$CORE_VERSION"
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-slim
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
# Al arrancar aplica las migraciones pendientes y sirve el panel.
CMD ["node", "dist/src/server.js"]
