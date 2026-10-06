# Contrato: comandos del operador y arranque

Todas las operaciones son del operador, en la máquina o el contenedor de la instancia (sin panel;
Assumptions de la spec). Leen la configuración con `loadEnv()` (`.env` en local, entorno en
producción). En la imagen se ejecutan con `node dist/src/cli/<comando>.js`; en local con `pnpm`.

Convenciones comunes:

- Salida en español, legible, y con `--json` el mismo informe como un objeto JSON en una línea
  (para anotarlo en el inventario).
- Código de salida: `0` bien; `1` fallo de la operación (el informe dice el código); `2`
  configuración o argumentos no válidos.
- La salida nunca incluye la clave, textos de mensajes, teléfonos ni nombres de personas.
- Rutas: `<fichero>` puede ser un nombre (se busca en `BACKUP_DIR`) o una ruta.

---

## `pnpm db:backup`

Copia bajo demanda (US1). Motivo `manual`.

```text
pnpm db:backup [--json]
```

1. Valida configuración (`INSTANCE_ID`, `BACKUP_DIR`, `BACKUP_KEY`, `BACKUP_RETENTION_DAYS`).
2. Toma el bloqueo `backup_in_progress`; si está tomado → `busy`.
3. Comprueba el directorio, escribe `.partial`, renombra (research R8).
4. Aplica la retención.

Salida correcta (ejemplo):

```text
Copia creada: demo-01__0004_handoff__20260929T101500Z__manual.cbak
  Tamaño: 1,8 MB · Esquema: 0004_handoff · Núcleo: 0.6.0 · 2026-09-29 12:15 (Europe/Madrid)
  business 1 · business_hours 12 · service 14 · resource 3 · faq 22 · conversation 212 · message 3 410 · …
  Retención (7 días): 2 copias borradas, 5 conservadas.
```

Fallos (código de salida 1), sin fichero final creado (FR-006):

| Código | Mensaje |
|--------|---------|
| `key_missing` | Falta BACKUP_KEY. Genérala con `openssl rand -hex 32` y guárdala fuera del directorio de copias. |
| `key_invalid` | BACKUP_KEY debe ser 32 bytes aleatorios en hexadecimal. |
| `dir_missing` | El directorio de copias (BACKUP_DIR) no existe. |
| `dir_not_writable` | No se puede escribir en el directorio de copias (BACKUP_DIR). |
| `no_space` | No hay espacio suficiente en el directorio de copias. |
| `busy` | Ya hay una copia en curso en esta instancia; inténtalo cuando termine. |
| `db_error` | No se pudo leer la base de datos de la instancia. |
| `io_error` | Error al escribir la copia. |

`BACKUP_RETENTION_DAYS` fuera de 1–30 → código 2: "BACKUP_RETENTION_DAYS debe estar entre 1 y 30
días (máximo 30)" (US4-3).

---

## `pnpm db:restore`

Restauración (US2). Solo con la instancia parada.

```text
pnpm db:restore <fichero> [--from-instance <id>] [--yes] [--json]
```

- Sin `--yes`, muestra el resumen de la cabecera (instancia, esquema, fecha, recuentos) y pide
  escribir el `INSTANCE_ID` de la instancia destino para confirmar. Con `--yes` no pregunta (para
  scripts); con stdin no interactivo y sin `--yes` → código 2.
- `--from-instance <id>`: obligatorio si la cabecera es de otra instancia, y MUST coincidir con
  ella (FR-010).

Orden (research R6, R7):

1. Toma el bloqueo `instance_running`; si está tomado → `instance_running`: "La instancia está en
   marcha. Párala antes de restaurar."
2. Comprobación previa completa del fichero (sin tocar la BD).
3. Restauración en una transacción; recuento contra la cabecera; `COMMIT`.
4. Libera el bloqueo.

Salida correcta:

```text
Restaurada: demo-01__0003_map_url__20260927T010000Z__daily.cbak
  Copia de la instancia demo-01 · esquema 0003_map_url · núcleo 0.5.2 · 2026-09-27 03:00 (Europe/Madrid)
  business 1 · service 14 · … · conversation 198 · message 3 105
  Al arrancar: se aplicará 1 migración pendiente (0004_handoff), con copia previa,
  y se borrarán 6 conversaciones que ya superan los 30 días sin mensajes.
```

Mensajes de rechazo (la BD queda igual; SC-008):

| Código | Mensaje |
|--------|---------|
| `schema_newer` | La copia usa el esquema 0006_x (núcleo 0.8.0) y este núcleo llega a 0004_handoff. Restaura con el núcleo 0.8.0 o posterior. |
| `other_instance` | La copia es de la instancia «otra-02». Para restaurarla aquí, repite con `--from-instance otra-02`. |
| `wrong_key` | La copia se hizo con otra clave (id 3fa1c09e7b22d415). Añade la clave anterior en BACKUP_KEYS_PREVIOUS. |
| `corrupted` | La copia está dañada o incompleta. No se ha modificado nada. |
| `schema_mismatch` | La copia se hizo con un núcleo con migraciones distintas a las de este. No se ha modificado nada. |
| resto | los de [data-model.md](../data-model.md#informe-de-restauración-y-de-comprobación-restorereport-verifyreport) |

---

## `pnpm db:verify`

Comprobación sin tocar la instancia (US5, research R12).

```text
pnpm db:verify <fichero> [--json]
```

- Crea `verify_<16 hex>` en el servidor de `BACKUP_VERIFY_URL` (o `DATABASE_URL`), restaura con el
  mismo código que `db:restore` (sin bloqueo de instancia y aceptando cualquier `instanceId`: el
  informe lo muestra), cuenta, compara y borra la BD temporal siempre.
- Código de salida `0` si es restaurable, `1` si no.

```text
Comprobación: demo-01__0004_handoff__20260929T101500Z__manual.cbak
  RESTAURABLE · instancia demo-01 · esquema 0004_handoff · núcleo 0.6.0 · 2026-09-29 12:15 (Europe/Madrid)
  business 1 · service 14 · … (23 tablas; recuentos iguales a la copia)
  Base de datos temporal eliminada.
```

```text
Comprobación: demo-01__0004_handoff__20260929T101500Z__manual.cbak
  NO RESTAURABLE: la copia está dañada o incompleta (corrupted).
```

---

## `pnpm db:backups`

Lista las copias propias de `BACKUP_DIR` y, con `--prune`, aplica la retención (US4).

```text
pnpm db:backups [--prune] [--json]
```

Columnas: nombre, tamaño, fecha local, motivo, esquema, válida (sí/no), caduca (fecha). Los ficheros
ajenos y los `.partial` no aparecen (FR-020).

---

## `pnpm db:migrate` y arranque del servidor

Mismo comportamiento en los dos (research R9, R11). Orden del arranque del servidor:

1. `loadEnv()` (incluye la configuración de copias; en `production` es obligatoria).
2. Toma `instance_running`; si está tomado → sale con "Hay una restauración en curso o la instancia
   ya está en marcha".
3. `runMigrations(url, defaults, { backup })`:
   - BD vacía o sin pendientes → migra (o nada) sin copia.
   - Con datos y pendientes → copia `premigration`; si falla → `migration_blocked` y salida con
     código 1, sin migrar ni escuchar. Mensaje: "No se aplican las migraciones pendientes (0005_x):
     no se pudo hacer la copia previa (dir_not_writable). El esquema no ha cambiado."
   - Si una migración falla tras la copia → sale con "La migración ha fallado. Copia previa:
     <nombre>. Restáurala con el núcleo <versión anterior>."
4. `retention.purge()` de conversaciones, esperado (R11).
5. `app.listen`, procesador, retención horaria, barrido de derivaciones y programador de copias
   diarias (R10).
6. Cierre ordenado: para el programador (espera a la copia en curso) antes de cerrar la BD; libera
   `instance_running` al cerrar la conexión.
