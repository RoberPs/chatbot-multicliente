# Contrato: estado del tope en `/health` e `instance:versions`

**Feature**: 010-usage-cost-cap · FR-023a, FR-023b · research R11. Amplía
[009 health-endpoint](../../009-version-health-rollout/contracts/health-endpoint.md) e
[009 instance-versions-command](../../009-version-health-rollout/contracts/instance-versions-command.md).

## `GET /health`

**Sin credencial**: sin cambios — `{ "status": … }` (US3-12).

**Con `Authorization: Bearer <HEALTH_SECRET>`**: un campo más al final.

```json
{
  "status": "ok",
  "instanceId": "…",
  "coreVersion": "0.2.0",
  "schema": { "applied": { "index": 6, "tag": "0006_usage" }, "expected": { "index": 6, "tag": "0006_usage" } },
  "spendCap": "warning"
}
```

| `spendCap` | Significado |
|---|---|
| `"none"` | tope desactivado |
| `"normal"` | activo y por debajo del 80 % |
| `"warning"` | ≥ 80 % y < 100 % |
| `"reached"` | ≥ 100 % |
| `null` | no se pudo leer: instancia `not_ready`, BD sin responder o esquema distinto del esperado |

- Calculado en el momento dentro del mismo sondeo `READ ONLY` y del mismo tope de 2 s; **no**
  cambia `status` ni el código HTTP.
- Sin importes, precios, moneda ni porcentajes.

## `pnpm instance:versions`

Columna nueva **Tope** al final de la tabla:

| Valor del informe | Celda |
|---|---|
| `none` | `sin tope` |
| `normal` | `normal` |
| `warning` | `≥80 %` |
| `reached` | `alcanzado` |
| `null`, ausente o desconocido (instancia anterior a la 010, no responde, sin secreto) | `—` |

`--json`: cada fila gana `"spendCap": "none" | "normal" | "warning" | "reached" | null`.

El estado del tope **no** cambia la clasificación de la fila (`ok`, `degraded`, …), ni el código de
salida, ni lo que escribe `--annotate`.
