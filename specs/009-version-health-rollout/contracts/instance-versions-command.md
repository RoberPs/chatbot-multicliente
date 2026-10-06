# Contrato: órdenes de versión (`instance:versions` y `instance:health-secret`)

Herramientas del operador, en el equipo del operador, junto a las demás `instance:*` (007). Mismas
convenciones: inventario en `INSTANCE_INVENTORY`, clave en `INSTANCE_INVENTORY_KEY`, mensajes en
español, nunca se muestra un secreto. Decisiones en [research.md](../research.md) R2, R5 y R6.

## `pnpm instance:versions`

```text
pnpm instance:versions [--json] [--only <id>[,<id>…]] [--envs-dir <carpeta>] [--timeout <s>]
                       [--allow-insecure] [--annotate [--yes]]
```

| Opción | Efecto |
|---|---|
| `--json` | Salida en formato máquina (ver abajo) en lugar de la tabla |
| `--only` | Consulta solo esas instancias (ids del inventario) |
| `--envs-dir` | Carpeta de los entornos `<id>.env`; por defecto `<carpeta del inventario>/envs` |
| `--timeout` | Segundos por instancia (1–30, por defecto 5) |
| `--allow-insecure` | Permite `http` solo para `localhost`, `127.0.0.1` y `::1` (pruebas locales) |
| `--annotate` | Tras el informe, propone anotar en el inventario la versión observada (R6) |
| `--yes` | Con `--annotate`, no pregunta; necesario sin terminal interactiva |

### Qué hace

1. Lee el inventario con la clave (error 2 si no se puede o la clave no es la suya).
2. Selecciona las instancias que no están de baja (`retired`).
3. Para cada una, **en paralelo** (máximo 8 a la vez): lee `HEALTH_SECRET` del entorno de la
   instancia (solo en memoria), consulta `GET <publicUrl>/health` con tiempo límite, sin seguir
   redirecciones, y clasifica la fila.
4. Imprime el informe y devuelve el código de salida. No modifica nada salvo `--annotate`.

### Filas: resultado y significado

| `result` | Texto en la tabla | Cuándo | ¿Revisar? |
|---|---|---|---|
| `ok` | Correcto | Estado `ok`, identidad correcta | No, si coincide con lo anotado |
| `degraded` | Degradado | Estado `degraded`, identidad correcta | Sí |
| `not_ready` | No lista | Estado `not_ready`, identidad correcta | Sí |
| `unreachable` | No responde | Red, DNS, TLS, tiempo agotado o error de conexión | Sí |
| `invalid_response` | Respuesta no válida | No es JSON, supera 4 KiB o no cumple el contrato | Sí |
| `no_health` | Sin información de versión | `404`: instancia anterior a esta feature | Sí |
| `auth_failed` | Secreto rechazado | `401`: el secreto del entorno no es el de la instancia, o la instancia aún no tiene `HEALTH_SECRET` desplegado | Sí |
| `rate_limited` | Límite de peticiones | `429` | Sí |
| `status_only` | Solo estado | Sin secreto en el equipo del operador (`no_secret`: entorno o variable ausentes); se consulta solo el nivel sin credencial | Sí |
| `identity_mismatch` | Identidad distinta | `instanceId` recibido ≠ `id` del inventario (URL cruzada) | Sí |
| `not_queried` | No consultada | Sin URL (`no_url`) o no `https` sin `--allow-insecure` (`not_https`) | Sí |

Prioridad de clasificación: `not_queried` → `unreachable` → `no_health` → `auth_failed` →
`rate_limited` → `invalid_response` → `status_only` → `identity_mismatch` → `ok`/`degraded`/
`not_ready`.

**Versión anotada**: se toma la primera versión semántica de `imageVersion` (`chatbot:1.4.0` →
`1.4.0`). Columna «Coincide»: «sí» si es igual a la observada, «NO» si difiere (o la anotación no
tiene versión), «sin anotar» si el inventario no tiene `imageVersion`, «—» si no hay versión
observada. «Sin anotar» y «NO» obligan a revisar.

### Salida para personas (ejemplo)

```text
Instancia   Cliente        Estado            Núcleo  Esquema               Anotada  Coincide
cliente-a   Cliente A      Correcto          1.4.0   0005_config_transfer  1.4.0    sí
cliente-b   Cliente B      Correcto          1.3.0   0004_handoff          1.4.0    NO
cliente-c   Cliente C      No responde       —       —                     1.3.0    —
cliente-d   Cliente D      Identidad distinta —      —                     1.4.0    —
cliente-e   Cliente E      Sin información de versión   —  —               1.2.0    —

3 de 5 instancias requieren revisión.
```

La tabla no muestra secretos, URLs con credenciales ni el identificador recibido en una URL
cruzada. Cabecera final con el recuento; instancias sin elementos a consultar:
«No hay instancias activas en el inventario.» (código 0).

### Salida `--json`

```json
{
  "checkedAt": "2026-10-01T10:00:00Z",
  "ok": false,
  "instances": [
    {
      "id": "cliente-a", "client": "Cliente A", "result": "ok", "reason": null,
      "status": "ok", "coreVersion": "1.4.0",
      "schema": { "applied": "0005_config_transfer", "expected": "0005_config_transfer" },
      "annotated": "1.4.0", "matches": true, "review": false
    }
  ]
}
```

`ok` es `true` solo si ninguna fila exige revisión. Los campos son los de la fila de
[data-model.md](../data-model.md) §6. Nunca aparecen secretos ni datos de clientes finales (FR-014).

### Código de salida

| Código | Significado |
|---|---|
| 0 | Todas las instancias consultadas están `ok` y coinciden con lo anotado (o no hay instancias activas) |
| 1 | Hay algo que revisar (cualquier fila con `review: true`) |
| 2 | Argumentos no válidos, inventario ilegible o bloqueado, clave incorrecta, `--annotate` sin confirmación posible |

### `--annotate`

Tras el informe: lista «instancia: anotada → observada» solo para filas `ok` (identidad correcta)
cuya versión observada difiere de la anotada. Pide «¿Anotar estas versiones? (s/N)»; `--yes` omite
la pregunta; sin terminal y sin `--yes` termina con código 2 sin escribir. La escritura va bajo el
bloqueo del inventario, releyendo y validando antes, con `rename` atómico (007), y solo cambia
`imageVersion`. Si una anotación cambió entre la consulta y la escritura, esa instancia no se pisa y
se informa. Sin `--annotate` el inventario no se modifica jamás (FR-012).

## `pnpm instance:health-secret <id> [--rotate]`

Para instancias creadas antes de esta feature (y para rotar el secreto). Las instancias nuevas ya
nacen con él (`instance:new`).

1. Localiza el entorno de la instancia (`<carpeta del inventario>/envs/<id>.env` o `--env <ruta>`).
2. Si ya tiene `HEALTH_SECRET` y no se usa `--rotate`: no cambia nada («Ya tiene secreto de salud»),
   código 0.
3. Si no, genera 32 bytes aleatorios (`generateHexSecret`), comprueba que no coincide con
   `SESSION_SECRET`/`BACKUP_KEY` del propio entorno y lo escribe con la reescritura atómica de
   `env-file.ts` (sin tocar el resto del fichero).
4. **No imprime el secreto.** Indica que hay que desplegar el entorno actualizado y ejecutar
   `pnpm instance:sync <id> <entorno>` para guardar su huella en el inventario.

Código: 0 secreto escrito o ya existente; 2 entorno ilegible, instancia desconocida o entorno dentro
del repositorio sin estar ignorado por Git (misma regla `output_in_repo` que `instance:new`).

> `instance:check <entorno>` pasa a exigir `HEALTH_SECRET` (error `missing`), y detecta si su
> huella coincide con la de otra instancia del inventario con el mismo código que ya usa para el
> resto de secretos repetidos.

## Pruebas asociadas

`tests/unit/provisioning/versions.test.ts` (clasificación, comparación de versiones, tabla, `--json`,
códigos de salida) · `tests/integration/provisioning/cli-versions.test.ts` (servidores reales en
puertos locales: correcto, versión distinta, apagado, URL cruzada, sin `/health`, sin secreto,
secreto rechazado; `--annotate` con y sin `--yes`; concurrencia con 10 instancias en < 60 s,
SC-002; ausencia de secretos en toda la salida) · `tests/integration/provisioning/cli-health-secret.test.ts`.
