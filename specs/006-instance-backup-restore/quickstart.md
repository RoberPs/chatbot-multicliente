# Quickstart: copias de seguridad y restauración

**Feature**: `006-instance-backup-restore` | **Contratos**: [backup-commands.md](contracts/backup-commands.md) · [backup-file-format.md](contracts/backup-file-format.md) · [backup-log.md](contracts/backup-log.md)

Dos partes: la **guía de validación del operador** (FR-022, SC-007: menos de 15 minutos la primera
vez), que se repite de forma periódica, y los **escenarios de comprobación de la feature** para el
desarrollo.

---

## Parte A. Guía de validación del operador

### Cuándo repetirla

- Al dar de alta una instancia (cierre del alta, docs/operacion-multicliente.md §2.6).
- **Una vez al mes** por instancia, con la copia diaria más reciente.
- Tras cada actualización del núcleo con migraciones, con la copia `premigration`.
- Tras cambiar `BACKUP_KEY`.

Anota en el inventario la fecha, el fichero y el resultado de `db:verify --json`.

### Antes de empezar (una vez por instancia)

1. `BACKUP_KEY` generada con `openssl rand -hex 32` y guardada en el gestor de secretos, **no** en
   `BACKUP_DIR`. Si se pierde, sus copias no se pueden recuperar.
2. `BACKUP_DIR` en un volumen persistente distinto del contenedor. Si está en la misma máquina que
   la BD, activa las instantáneas o la réplica del proveedor, o sincroniza el directorio fuera:
   perder la máquina haría perder las copias.
3. Una instancia de pruebas (la tuya de staging, o `docker compose up -d db` + `pnpm dev` en tu
   equipo) con un usuario de PostgreSQL con `CREATEDB` para `db:verify`, **sin** variables
   `WHATSAPP_*` ni `SMTP_*`: tras restaurar tendrá los destinos de avisos del negocio real y no
   debe poder escribirles.

### Pasos

1. **Copiar** (en la instancia real):

   ```bash
   node dist/src/cli/backup.js          # en local: pnpm db:backup
   ```

   Esperado: nombre `<instancia>__<esquema>__<fecha>__manual.cbak`, tamaño y recuentos por tabla.
   Apunta los recuentos de `business`, `service` y `faq`.

2. **Llevar el fichero** a la instancia de pruebas (por el medio que uses para sacar copias de la
   máquina). La clave de la instancia real se configura en la de pruebas solo durante la prueba,
   en `BACKUP_KEYS_PREVIOUS`, nunca como `BACKUP_KEY`.

3. **Comprobar** (en la instancia de pruebas):

   ```bash
   pnpm db:verify <fichero>
   ```

   Esperado: `RESTAURABLE`, misma instancia, esquema y recuentos que en el paso 1, y "Base de
   datos temporal eliminada".

4. **Restaurar en la instancia de pruebas** (parada):

   ```bash
   # parar pnpm dev
   pnpm db:restore <fichero> --from-instance <instancia-real>
   # escribir el INSTANCE_ID de la instancia de pruebas para confirmar
   pnpm dev
   ```

   Esperado: "Restaurada", recuentos iguales; al arrancar, migraciones pendientes (si las hay) con
   su copia previa y conversaciones caducadas borradas.

5. **Confirmar en el panel** de pruebas (`/admin`): nombre del negocio, servicios, precios,
   horarios y FAQ iguales a los de la instancia real; mismo estado (activo o en preparación); los
   avisos que muestre el panel son los del estado restaurado.

6. **Limpiar**: quita `BACKUP_KEYS_PREVIOUS` de la instancia de pruebas y restaura en ella sus datos
   ficticios (o `docker compose down -v`), porque ahora contiene datos reales de clientes finales.

---

## Parte B. Escenarios de comprobación de la feature (desarrollo)

Prerrequisitos: `pnpm install`, `docker compose up -d db`, `.env` con `INSTANCE_ID=dev-01`,
`BACKUP_DIR` apuntando a una carpeta local vacía y `BACKUP_KEY` generada. Datos de ejemplo cargados
desde `tests/fixtures/` (o registrados en el panel) y alguna conversación en "Probar el bot".

| # | Escenario | Cómo | Resultado esperado | Spec |
|---|-----------|------|--------------------|------|
| 1 | Copia bajo demanda | `pnpm db:backup` | Un `.cbak`; `pnpm db:backups` lo lista como válido; el fichero no contiene el nombre del negocio en claro (`grep -c "<nombre>" <fichero>` = 0) | US1-1, SC-004 |
| 2 | Copia con el bot atendiendo | `pnpm dev` + "Probar el bot" enviando mensajes + `pnpm db:backup` | Copia correcta; el bot responde sin pausa | US1-2, SC-001 |
| 3 | Sin clave / directorio no escribible | vaciar `BACKUP_KEY`; luego carpeta de solo lectura | Código 1 con `key_missing` / `dir_not_writable`; ningún `.cbak` nuevo | US1-3, US1-4 |
| 4 | Restaurar | copia → cambiar el nombre del negocio y borrar un servicio en el panel → parar → `pnpm db:restore <f>` → `pnpm dev` | Panel y `pnpm kb:snapshot` como en la copia | US2-1, SC-002 |
| 5 | Restaurar con la instancia en marcha | `pnpm dev` en marcha + `pnpm db:restore <f>` | `instance_running`; nada cambia | FR-008 |
| 6 | Copia dañada / clave incorrecta / otra instancia | cambiar un byte del fichero; cambiar `BACKUP_KEY`; cambiar `INSTANCE_ID` | `corrupted` / `wrong_key` / `other_instance`; la BD igual | US2-5, US2-6 |
| 7 | Copia previa a migración | con datos, añadir una migración de prueba en una rama y `pnpm db:migrate` | Primero `…__premigration.cbak` con el esquema anterior, después la migración | US3-1 |
| 8 | Arranque bloqueado | lo mismo sin `BACKUP_KEY` | `migration_blocked`; `drizzle.__drizzle_migrations` sin cambios; el servidor no escucha | US3-4, SC-003 |
| 9 | Retención | `BACKUP_RETENTION_DAYS=1` y copias con fecha de cabecera antigua (helper de tests) + `pnpm db:backups --prune` | Se borran las caducadas, se conserva la última válida, un fichero ajeno sigue ahí | US4 |
| 10 | Comprobación | `pnpm db:verify <f>` con uno válido y uno dañado | `RESTAURABLE` / `NO RESTAURABLE`; sin BD `verify_*` al terminar | US5 |
| 11 | Copia diaria | `BACKUP_DAILY_TIME` a un minuto después de ahora con `pnpm dev` en marcha | Una `…__daily.cbak`; reiniciar no crea otra el mismo día | US6 |

Pruebas automáticas:

```bash
pnpm test:unit backup          # formato, cifrado, nombres, retención, programación, configuración
pnpm test:integration backup   # ciclo completo con Testcontainers (incluye escenarios 1–11)
pnpm test sector-neutrality    # src/backup sin nombres de sector ni cliente
```
