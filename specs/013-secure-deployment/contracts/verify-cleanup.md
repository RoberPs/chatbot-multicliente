# Contrato: bases temporales de `db:verify`

Amplía [006 contracts/backup-commands.md](../../006-instance-backup-restore/contracts/backup-commands.md)
y [006 contracts/backup-log.md](../../006-instance-backup-restore/contracts/backup-log.md).
Research R5; modelo en [data-model.md §3–4](../data-model.md).

## Secuencia

1. Lee y comprueba la copia (sin cambios).
2. Conecta con la base de mantenimiento de `BACKUP_VERIFY_URL` (o `DATABASE_URL`).
3. **Limpieza de huérfanas**:
   1. lista las bases `verify_%` con su número de conexiones;
   2. elige las que cumplen el patrón exacto, no tienen conexiones y tienen una marca de hace más
      de 6 h, o tienen el formato anterior;
   3. `DROP DATABASE` sin `FORCE`, una por una.

   Un fallo aquí no detiene la verificación.
4. `CREATE DATABASE verify_<yyyymmddhhmmss UTC>_<16 hex>`.
5. `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM PUBLIC`. Si falla, se borra la base y el
   resultado es `verify_db_unavailable`.
6. Conecta con la temporal, carga la copia y compara los recuentos (sin cambios).
7. `finally`: `DROP DATABASE … WITH (FORCE)` de la propia temporal (sin cambios).

## Qué no se toca nunca

- Una base cuyo nombre no cumple exactamente uno de los dos patrones. Por ejemplo:
  `verify_abc`, `verify_<16 hex>_x`, `verify_20261340000000_<16 hex>` (fecha imposible),
  `chatbot_<id>`, `postgres`.
- Una base con conexiones abiertas en el momento del listado o del borrado.
- Una base del formato nuevo con menos de 6 h o con una marca en el futuro.

## Resultado del borrado

| Resultado del `DROP` | Cuenta como |
|---|---|
| correcto | `removed` |
| `55006` (alguien se ha conectado) | nada: se respeta |
| `42501` u otro error | `failed` |
| no se pudo listar (paso 3.1) | `listed: false`, sin contar nada |

## Salida

Texto. Se añade una línea antes de la de la base temporal, solo si hay algo que contar:

```text
  Bases temporales huérfanas: 2 borradas.
  Bases temporales huérfanas: 1 borrada, 1 sin poder borrar (permisos del usuario de BACKUP_VERIFY_URL).
  Bases temporales huérfanas: no se ha podido comprobar el servidor; puede quedar alguna.
```

La línea sale también cuando la copia **no** es restaurable. El código de salida sigue
dependiendo solo de si la copia es restaurable: 0 sí, 1 no, 2 configuración.

JSON (`--json`), campo nuevo en el informe:

```json
{ "orphans": { "listed": true, "removed": 1, "failed": 1 } }
```

Registro (`verify_completed`): los mismos tres campos, `orphansListed`, `orphansRemoved` y
`orphansFailed`.

Ningún nombre de base ni dato del negocio en la salida ni en el registro.
