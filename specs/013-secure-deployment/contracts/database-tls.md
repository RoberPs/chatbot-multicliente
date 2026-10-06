# Contrato: TLS hacia PostgreSQL y mensajes de conexión

Cubre FR-008 y el lado del arranque y las órdenes de SC-002. Research R1 y R4.

## Qué se acepta en la URL

| Parámetro | Efecto |
|---|---|
| `sslmode=verify-full` | Cifra y verifica el certificado del servidor y que es válido para el nombre de la URL |
| `sslrootcert=<ruta>` | Autoridad de confianza leída de ese fichero. Sin él, las autoridades públicas de Node |
| otros `sslmode` | Se respetan al conectar (como hoy), pero `instance:check` los rechaza con host remoto |

Se aplica igual en todas las conexiones, porque todas usan `connectionString`:

- pool principal y pool público;
- sondeo de `/health`;
- cerrojo del arranque y migraciones (`db:migrate` incluido);
- copias (`db:backup` y programada), restauración (`db:restore`);
- verificación (`db:verify`), tanto en la conexión de mantenimiento como en la de carga;
- `instance:db`.

## Comprobación previa del fichero de autoridad

Antes de crear ningún cliente, si la URL lleva `sslrootcert`, se comprueba que el fichero existe y
se puede leer. El arranque y `db:migrate` lo comprueban sobre `DATABASE_URL`;
`db:backup`, `db:restore` y `db:verify` sobre su URL. Si falla:

```text
DATABASE_URL: no se puede leer el certificado de la autoridad indicado en sslrootcert.
→ Monta el fichero en el contenedor (solo lectura) y comprueba la ruta y sus permisos.
```

## Errores al conectar

Se clasifican por `code`, nunca por el texto del error.

| Motivo | Códigos | Mensaje (arranque y órdenes) |
|---|---|---|
| `tls_untrusted` | `ERR_TLS_CERT_ALTNAME_INVALID`, `SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `CERT_HAS_EXPIRED`, `CERT_NOT_YET_VALID` | `<VAR>: el certificado del servidor no es válido para ese nombre o no lo firma una autoridad de confianza.` → `Revisa el nombre del servidor en la URL y sslrootcert.` |
| `tls_unsupported` | el servidor rechaza TLS | `<VAR>: el servidor no acepta conexiones TLS.` → `Activa TLS en el servidor PostgreSQL.` |
| `unreachable` | cualquier otro fallo al conectar | `<VAR>: no se puede conectar con la base de datos.` → `Comprueba que el servidor está en marcha y accesible desde la instancia.` |

- `src/server.ts` muestra el mensaje de los errores propios del arranque (`InstanceBusyError`,
  `DatabaseConfigError` y los de las migraciones con copia previa). Para cualquier otro error,
  muestra el texto de esta tabla, nunca `error.message`.
- `db:backup`, `db:restore` y `db:verify` añaden a sus motivos de fallo `db_ca_unreadable`,
  `db_tls_untrusted` y `db_tls_unsupported`, con los textos de esta tabla. `unreachable` sigue
  siendo `db_error` (y `verify_db_unavailable` en la conexión de mantenimiento de `db:verify`),
  como hoy. En `--json` va el código.
- Códigos de salida, según la convención de cada orden:

  | Motivo | `db:backup` | `db:restore` | `db:verify` |
  |---|---|---|---|
  | `db_ca_unreadable` (antes de conectar) | 1, `{ ok: false, failure }` | 2 | 2 |
  | `db_tls_untrusted` · `db_tls_unsupported` (al conectar) | 1 | 1 | 1 (no restaurable) |
- El registro de la instancia sigue usando `serializeError` (012): tipo y código, sin mensaje.

Ningún mensaje lleva la URL, el host, el usuario, la base, la ruta del certificado ni los nombres
del certificado.

## Lo que no cambia

El arranque **no** rechaza una URL remota sin `verify-full` (Assumptions de la spec). Esa regla
vive en `instance:check` e `instance:db`.
