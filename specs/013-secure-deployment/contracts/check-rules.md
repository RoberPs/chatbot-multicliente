# Contrato: reglas de despliegue en `instance:check` e `instance:db`

Amplía [007 contracts/check-result.md](../../007-instance-provisioning/contracts/check-result.md)
y [007 contracts/instance-commands.md](../../007-instance-provisioning/contracts/instance-commands.md).
Forma de la salida, códigos de salida (0 apto, 1 no apto) y salida `--json` sin cambios.

## Definiciones

- **Host local**: `localhost`, `127.0.0.0/8`, `::1` (cualquier forma) o socket local. El resto es
  **remoto**, también las IP privadas.
- **TLS verificado**: la URL lleva un único `sslmode`, vale exactamente `verify-full` y, si el host
  es remoto, no es una IP literal (con una IP, `pg` no comprueba el nombre del certificado). Las
  variables `PG*` del entorno no cuentan.

## Reglas de `instance:check`

| Código | Variable | Condición | Producción | Pruebas |
|---|---|---|---|---|
| `missing` | `PUBLIC_BASE_URL` | ausente o vacía | error | — |
| `trust_proxy_empty` | `TRUST_PROXY` | `PUBLIC_BASE_URL` empieza por `https:` y `TRUST_PROXY` ausente, vacío o `false` | **error** (antes advertencia) | advertencia (antes nada) |
| `database_tls_required` | `DATABASE_URL` | host remoto sin TLS verificado | error | advertencia |
| `database_tls_required` | `BACKUP_VERIFY_URL` | presente, host remoto sin TLS verificado | error | advertencia |
| `database_tls_required` | `INSTANCE_DB_ADMIN_URL` | presente, host remoto sin TLS verificado | error | advertencia |
| `database_tls_ip_host` | las tres URL de base de datos | host remoto que es una IP literal, con `sslmode=verify-full` | error | advertencia |
| `database_url_invalid` | `BACKUP_VERIFY_URL` · `INSTANCE_DB_ADMIN_URL` | presente pero no interpretable | error | error |
| `database_localhost` | `DATABASE_URL` | host local | advertencia (sin cambios) | — |

- Una URL de host local nunca da `database_tls_required`.
- Una `DATABASE_URL` no interpretable da el error del esquema del arranque, como hoy, y no da
  `database_tls_required`.
- Sin `BACKUP_VERIFY_URL` no se repite el hallazgo de `DATABASE_URL`.
- `sslrootcert` no se exige ni se comprueba aquí: su ruta es la del contenedor.

### Textos

| Código | `message` (JSON y órdenes) | `detail` (tras `VARIABLE:`) | `action` |
|---|---|---|---|
| `trust_proxy_empty` | `TRUST_PROXY está vacío y PUBLIC_BASE_URL es https: la instancia no termina TLS, así que hay un proxy delante y sin TRUST_PROXY todos los clientes parecen venir de la misma dirección.` | `está vacío con PUBLIC_BASE_URL en https: hay un proxy delante y la instancia no lo sabe.` | `Indica el número de saltos del proxy (1 si hay uno) o sus IP/CIDR, y comprueba la dirección que ve la instancia (sección 2.5 de la guía).` |
| `database_tls_required` | `<VAR> apunta a un servidor remoto sin TLS verificado: hace falta sslmode=verify-full en la propia URL (las variables PG* del entorno no cuentan).` | `apunta a un servidor remoto sin sslmode=verify-full en la URL.` | `Añade sslmode=verify-full a la URL y, si la autoridad del certificado no es pública, sslrootcert=<ruta del certificado en el contenedor> (sección 2.5).` |
| `database_tls_ip_host` | `<VAR> apunta a una IP con sslmode=verify-full: con una IP no se comprueba que el certificado sea de ese servidor.` | `apunta a una IP: con una IP no se comprueba que el certificado sea de ese servidor.` | `Usa en la URL el nombre del servidor que figura en su certificado (sección 2.5).` |
| `database_url_invalid` | `<VAR> no es una URL de PostgreSQL válida.` | `no es una URL de PostgreSQL válida.` | `Usa el formato postgres://usuario@servidor:puerto/base?sslmode=verify-full.` |

Ningún texto lleva la URL, el host, el usuario, la contraseña, la base ni la ruta de `sslrootcert`
(SC-002).

### Ejemplo (producción, texto)

```text
Validación de cliente-x (perfil production, comparado con 3 instancias)

ERRORES (2)
  ✗ TRUST_PROXY: está vacío con PUBLIC_BASE_URL en https: hay un proxy delante y la instancia no lo sabe.
      → Indica el número de saltos del proxy (1 si hay uno) o sus IP/CIDR, y comprueba la dirección que ve la instancia (sección 2.5 de la guía).
  ✗ DATABASE_URL: apunta a un servidor remoto sin sslmode=verify-full en la URL.
      → Añade sslmode=verify-full a la URL y, si la autoridad del certificado no es pública, sslrootcert=<ruta del certificado en el contenedor> (sección 2.5).

NO APTO para desplegar.
```

La salida `--json` lleva los mismos `code` y `variable` en `errors`.

## `instance:db`

| Situación | Resultado |
|---|---|
| URL de administración remota sin TLS verificado | No abre el inventario ni conecta; error `admin_url_tls_required`; salida 1. Igual en cualquier perfil y sin opción para saltárselo |
| URL de administración no válida | Como hoy |
| `--print-sql` | No lee ninguna URL; sin cambios en ese punto |
| `DATABASE_URL` generada | Lleva el `sslmode` de la URL de administración; con `--print-sql` y `--host` remoto, `sslmode=verify-full` por defecto |
| `--sslrootcert <ruta>` (nueva) | Añade `sslrootcert=<ruta>` a la `DATABASE_URL` generada; la ruta es la del contenedor. No se muestra |
| Conexión de prueba con el usuario nuevo | Usa el `sslmode` y el `sslrootcert` de la URL de administración |

Texto de `admin_url_tls_required`:

```text
INSTANCE_DB_ADMIN_URL apunta a un servidor remoto sin TLS verificado: por esa conexión viaja la credencial de administración.
→ Añade sslmode=verify-full (y sslrootcert=<ruta> si la autoridad no es pública), o usa --print-sql --host <servidor> --port <puerto> y aplica el SQL tú mismo.
```

Con una IP remota y `verify-full`, error `admin_url_ip_host` (salida 1, sin conectar):

```text
INSTANCE_DB_ADMIN_URL apunta a una IP: con una IP no se comprueba que el certificado sea de ese servidor, y por esa conexión viaja la credencial de administración.
→ Usa el nombre del servidor que figura en su certificado, o usa --print-sql --host <servidor> --port <puerto> y aplica el SQL tú mismo.
```

El texto es el mismo tanto si la URL viene de la variable como si se pidió en la terminal.

`pnpm instance:db <id> [--print-sql] [--host <servidor>] [--port <puerto>] [--sslrootcert <ruta>] [--env <fichero>] [--inventory <ruta>]`
