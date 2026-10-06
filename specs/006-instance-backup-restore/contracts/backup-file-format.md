# Contrato: formato de fichero `CBAK` v1

Formato de las copias (research R1, R3). Lo escribe y lo lee solo el núcleo, pero es un contrato
estable: todo núcleo futuro MUST leer la v1 para poder restaurar copias hechas con versiones
anteriores (FR-017). Cambiarlo exige `formatVersion: 2` y mantener el lector de la v1.

## Estructura

```text
offset  tamaño   contenido
0       8        firma ASCII "CBAK\0\0\0\1"   (v1)
8       4        H = longitud de la cabecera, uint32 big-endian (≤ 64 KiB)
12      H        cabecera: JSON UTF-8 (ver abajo), en claro
12+H    …        bloques, uno tras otro, hasta el que lleva la marca de último
```

Cada bloque:

```text
4        L = longitud del texto cifrado, uint32 big-endian (1 ≤ L ≤ 65 536)
L        texto cifrado (AES-256-GCM)
16       etiqueta GCM
```

- Texto en claro de cada bloque: hasta 65 536 bytes del **flujo gzip** del volcado. Todos los
  bloques salvo el último llevan exactamente 65 536 bytes.
- Nonce (12 bytes): contador del bloque, empezando en 0, en 11 bytes big-endian + 1 byte con `0x01`
  si es el último bloque y `0x00` si no.
- AAD: SHA-256 de los bytes exactos de la cabecera (los H bytes).
- Clave del fichero: `HKDF-SHA256(ikm = BACKUP_KEY (32 bytes), salt = cabecera.salt, info =
  "chatbot-backup/v1/data", 32 bytes)`.
- `keyId`: primeros 8 bytes de `HKDF-SHA256(ikm = BACKUP_KEY, salt = vacío, info =
  "chatbot-backup/v1/key-id", 32 bytes)`, en hex.

Lectura válida si y solo si: firma correcta, cabecera JSON conforme al esquema, cada bloque se
autentica en orden, hay exactamente un bloque con marca de último, es el final del fichero y el
gzip y el volcado se leen enteros. Cualquier otra cosa → `corrupted` (o `not_a_backup` /
`unsupported_format` / `wrong_key` según [data-model.md](../data-model.md#informe-de-restauración-y-de-comprobación-restorereport-verifyreport)).

## Cabecera (JSON, en claro, autenticada por los bloques)

```json
{
  "format": "cbak",
  "formatVersion": 1,
  "instanceId": "demo-01",
  "schema": { "index": 4, "tag": "0004_handoff", "hash": "9f2c…" },
  "coreVersion": "0.6.0",
  "createdAt": "2026-09-29T10:15:00.000Z",
  "reason": "manual",
  "tables": [
    { "schema": "public", "name": "business", "rows": 1 },
    { "schema": "public", "name": "service", "rows": 14 },
    { "schema": "public", "name": "conversation", "rows": 212 },
    { "schema": "drizzle", "name": "__drizzle_migrations", "rows": 5 }
  ],
  "salt": "base64 de 16 bytes",
  "keyId": "3fa1c09e7b22d415"
}
```

La cabecera MUST NOT contener textos, teléfonos, emails, nombres de personas ni del negocio. Se
valida con un esquema Zod estricto (sin campos desconocidos).

## Volcado (texto en claro, antes de gzip)

Secuencia de registros por líneas, en UTF-8:

```text
{"t":"begin","schema":{"index":4,"tag":"0004_handoff","hash":"9f2c…"}}
{"t":"table","schema":"public","name":"business","columns":["id","status","name",…],"rows":1}
<filas en formato COPY texto, una por línea>
\.
{"t":"table", …}
…
\.
{"t":"sequences","values":[{"schema":"public","name":"faq_id_seq","value":42,"called":true}, …]}
{"t":"end","tables":23}
```

- Las filas son la salida literal de `COPY "schema"."tabla" (columnas…) TO STDOUT` (formato
  `text`), que escapa saltos de línea y barras invertidas, así que la línea `\.` no puede aparecer
  como dato.
- El orden de las tablas en el volcado es alfabético; la restauración calcula el orden de carga
  por dependencias sobre el esquema reconstruido (R6).
- Las columnas se listan explícitamente para no depender del orden físico.
- `end.tables` y los `rows` de cada tabla MUST coincidir con la cabecera.
