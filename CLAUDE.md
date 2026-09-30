# CLAUDE.md

Chatbot para atender a los clientes de pequeños negocios por WhatsApp y chat web, con la misma cadena de respuesta en todos los canales; cada cliente tiene su propia instancia, construida sobre un núcleo común y su configuración.

## Stack y decisiones vigentes
- TypeScript 5 (strict), Node.js 22, pnpm 9, Fastify 5; panel de operador renderizado en servidor con Eta + htmx.
- PostgreSQL 16 con Drizzle ORM y drizzle-kit: **una BD por instancia**, sin `tenant_id`.
- Validación solo con esquemas Zod en el dominio; teléfonos en E.164 con libphonenumber-js.
- Autenticación del operador: credencial Argon2id en variables de entorno, sesión con cookie firmada, CSRF y límite de intentos en el login.
- Los avisos se calculan con `computeWarnings(state)` cada vez; nunca se guardan.
- Cada escritura va en una transacción: aplicar → recalcular avisos → revertir si un negocio activo queda con un aviso crítico (FR-032).
- El bot lee `KnowledgeReader.getSnapshot()` en cada respuesta, **sin caché**.
- Tests con Vitest: unitarios, de contrato (`fastify.inject`) e integración (Testcontainers).

## Arranque y pruebas en local
```bash
pnpm install
docker compose up -d db
cp .env.example .env && pnpm operator:hash-password
pnpm db:migrate && pnpm dev        # http://localhost:3000/admin
pnpm kb:snapshot                   # vista del bot en JSON
pnpm bot:chat                      # hablar con el bot en la terminal (modelo real)
pnpm test                          # o test:unit / test:integration / test <patrón>
pnpm test:eval                     # evaluación con el modelo real (coste; fuera de pnpm test)
pnpm db:backup                     # copia cifrada en BACKUP_DIR (INSTANCE_ID, BACKUP_DIR, BACKUP_KEY)
pnpm db:restore <fichero>          # restaurar con la instancia parada
pnpm db:verify <fichero>           # restaurar en una BD temporal y comprobar
pnpm db:backups [--prune]          # listar copias y aplicar la retención
# Alta de instancias (fuera del repo; INSTANCE_INVENTORY = ruta del inventario, INSTANCE_INVENTORY_KEY = su clave)
pnpm instance:new --id <id> …      # entorno con secretos nuevos + alta en el inventario (terminal)
pnpm instance:db <id>              # BD y usuario propios (INSTANCE_DB_ADMIN_URL o --print-sql)
pnpm instance:check <entorno>      # apto/no apto antes de desplegar [--json]
pnpm instance:list                 # inventario; también register, sync, update, verified, retire
pnpm lint && pnpm typecheck
```

## Convenciones
- Todo cambio empieza con una spec (`/speckit-specify` → plan → tasks → implement), y cada spec dice si es de núcleo o de extensión.
- En `src/` no puede haber nombres ni lógica de un sector o cliente; solo pueden aparecer en `tests/fixtures/`.
- El dominio (`src/knowledge`, `src/conversation`, `src/webchat`) no depende de HTTP; los adaptadores de canal viven en `src/channels` y el panel en `src/admin`.
- Horarios en hora local (`time` + día ISO, donde 1 = lunes) y zona horaria IANA; nada se pasa a UTC.
- Importes en céntimos; duraciones y antelaciones en minutos.
- Migraciones de solo añadir; las ya publicadas no se editan nunca (la restauración de copias las reaplica y compara su hash).
- Specs, comentarios y mensajes, en español.
- Actualiza `README.md` cada vez que una feature cambie de estado, y avisa antes al usuario.

Las reglas de producto viven en .specify/memory/constitution.md y el estado del producto en README.md
