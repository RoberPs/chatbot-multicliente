# Quickstart: Aprovisionamiento de instancias

**Feature**: `007-instance-provisioning` | **Plan**: [plan.md](plan.md)

Guía de validación de extremo a extremo. Órdenes y mensajes: [contracts/instance-commands.md](contracts/instance-commands.md);
resultado de la validación: [contracts/check-result.md](contracts/check-result.md); inventario:
[contracts/inventory-format.md](contracts/inventory-format.md).

## Requisitos

- Repositorio del núcleo con `pnpm install` hecho.
- Docker (para el servidor PostgreSQL de prueba y para `pnpm test:integration`).
- Un directorio de trabajo **fuera** del repositorio, p. ej. `~/alta-prueba`.

```bash
export INSTANCE_INVENTORY=~/alta-prueba/inventory.json
# Sin INSTANCE_INVENTORY_KEY: la primera alta crea el inventario y muestra la clave una vez.
```

(En PowerShell: `$env:INSTANCE_INVENTORY = "$HOME\alta-prueba\inventory.json"`.)

## Escenario 1 — Alta completa (US2 + US3 + US1, SC-001, SC-003)

1. Generar el entorno (en una terminal, sin redirigir la salida):

   ```bash
   pnpm instance:new --id demo-01 --client "Cliente de prueba" --url https://demo-01.ejemplo.com \
     --timezone Europe/Madrid --region ES --currency EUR --emergency-phone "+34 600 000 000"
   ```

   Esperado: clave del inventario y contraseña del operador mostradas una vez; fichero
   `~/alta-prueba/envs/demo-01.env`; `pnpm instance:list` muestra `demo-01` "en alta".
   Exporta la clave mostrada: `export INSTANCE_INVENTORY_KEY=<clave>`.

2. Crear la base de datos en un servidor de pruebas:

   ```bash
   docker run -d --name pg-alta -e POSTGRES_PASSWORD=admin-local-prueba -p 55499:5432 postgres:16
   export INSTANCE_DB_ADMIN_URL=postgres://postgres:admin-local-prueba@localhost:55499/postgres
   pnpm instance:db demo-01 --env ~/alta-prueba/envs/demo-01.env
   ```

   Esperado: "Base de datos creada…"; `DATABASE_URL` rellena en el fichero; el inventario tiene
   `database` sin contraseña.

3. Validar antes de completar terceros: `pnpm instance:check ~/alta-prueba/envs/demo-01.env`.
   Esperado: **APTO** con las advertencias `pending_optional` (sin clave del modelo ni correo),
   `trust_proxy_empty` y `database_localhost` (servidor de prueba local); **sin**
   `database_superuser` (el usuario es `chatbot_demo_01`).

4. Completar `ANTHROPIC_API_KEY` con una clave de prueba de ≥ 40 caracteres, volver a validar.
   Esperado: APTO sin la advertencia de la clave (SC-003).

5. Arrancar la instancia con ese entorno para comprobar que "apto" ⇒ "arranca" (el `BACKUP_DIR`
   por defecto es de la imagen; en local, cámbialo antes a un directorio existente y vuelve a
   validar).

## Escenario 2 — Repeticiones e incoherencias (US1, SC-002)

1. Generar `demo-02` como en el escenario 1.
2. Copiar `demo-02.env` a `mala.env` y pegar en `mala.env` el `SESSION_SECRET` de `demo-01`.
   `pnpm instance:check mala.env` → **NO APTO**, `duplicate_secret` que nombra `SESSION_SECRET` y
   `demo-01`; la salida no contiene el valor (búscalo).
3. Repetir con: `BACKUP_KEY` de `demo-01` como `SESSION_SECRET` (coincidencia entre variables),
   `DATABASE_URL` de `demo-01`, `INSTANCE_ID=demo-01`, `PUBLIC_BASE_URL` sin `https`, solo
   `WHATSAPP_PHONE_NUMBER_ID`, `SMTP_URL` sin `SMTP_FROM`, `TRUST_PROXY=true`,
   `BACKUP_KEY=SESSION_SECRET`, `SESSION_SECRET=changeme…`, sin `BACKUP_DIR`. Cada caso da su
   código de [check-result.md](contracts/check-result.md) y código de salida 1.
4. `pnpm instance:check ~/alta-prueba/envs/demo-01.env --json` → una línea JSON con `"ok": true`
   y salida 0 (la propia instancia no cuenta como repetida).
5. `unset INSTANCE_INVENTORY_KEY` y validar → NO APTO con `inventory_key_missing`.

## Escenario 3 — Inventario (US4, SC-005, SC-007)

1. Registrar una instancia existente: `pnpm instance:register <otro.env> --client "Anterior"`.
2. Anotar una verificación: en esa instancia, `pnpm db:verify <copia> --json > v.json`, y
   `pnpm instance:verified <id> v.json`. Con el informe de otra instancia → `other_instance`.
3. `pnpm instance:update demo-01 --status active --image 0.1.0` y `pnpm instance:list`: `demo-01`
   aparece con `!` (activa y sin verificación correcta en 31 días).
4. `pnpm instance:retire demo-02` → pasos manuales; después `pnpm instance:new --id demo-02 …` →
   rechazado (`duplicate_instance_id`).
5. Buscar en `inventory.json` los valores de `SESSION_SECRET`, `BACKUP_KEY`, contraseñas y
   `DATABASE_URL` de todos los entornos: 0 coincidencias.

## Escenario 4 — Modo "solo instrucciones" (US3-3)

```bash
pnpm instance:new --id demo-04 …
pnpm instance:db demo-04 --env ~/alta-prueba/envs/demo-04.env --print-sql --host localhost --port 55499
```

Esperado: SQL impreso sin la contraseña en claro, sin conexión; ejecutarlo con
`docker exec -i pg-alta psql -U postgres` y comprobar que la `DATABASE_URL` escrita conecta.

## Limpieza

```bash
docker rm -f pg-alta
rm -rf ~/alta-prueba
```

## Pruebas automáticas

```bash
pnpm test:unit provisioning          # reglas, huellas, plantilla, inventario, SC-002, SC-004
pnpm test:integration provisioning   # Testcontainers: BD por instancia (SC-006), CLI, bloqueo, SC-003, SC-005
pnpm test sector-neutrality          # recorre src/provisioning y src/cli/instance.ts
pnpm lint && pnpm typecheck
```
