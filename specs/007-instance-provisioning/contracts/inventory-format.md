# Contrato: formato del inventario de instancias (v1)

**Feature**: `007-instance-provisioning` | FR-024 a FR-032 | Modelo: [data-model.md](../data-model.md#inventario)

## Ubicación y acceso

- Ruta: `--inventory <ruta>` › variable `INSTANCE_INVENTORY` › `~/.chatbotasesor/inventory.json`.
  Se rechaza cualquier ruta dentro del repositorio del núcleo.
- Clave: variable `INSTANCE_INVENTORY_KEY` (64 hex). Nunca en el fichero ni por argumento.
- Bloqueo de escritura: `<ruta>.lock` (creación exclusiva), espera máxima 5 s.
- Escritura: `<ruta>.tmp-<8 hex>` con modo `0600` → `fsync` → `rename` sobre `<ruta>`.
- Codificación UTF-8, JSON con sangría de 2 espacios y salto de línea final; instancias ordenadas
  por `id`; huellas en orden de alta.

## Ejemplo

Los valores son ilustrativos.

```json
{
  "format": "chatbot-inventory",
  "version": 1,
  "keyCheck": "q3Vd0x8f1Hc2mB9KpL4sYw",
  "createdAt": "2026-09-30",
  "instances": [
    {
      "id": "demo-01",
      "client": "Cliente de ejemplo",
      "status": "active",
      "publicUrl": "https://demo-01.ejemplo.com",
      "imageVersion": "0.1.0",
      "llmWorkspace": "demo-01",
      "backupKeyLocation": "Gestor de secretos, entrada demo-01/BACKUP_KEY",
      "backupDir": "/var/lib/chatbot/backups",
      "database": { "host": "db.interna", "port": 5432, "name": "chatbot_demo_01", "user": "chatbot_demo_01" },
      "dates": { "provisioned": "2026-09-30", "retired": null, "dataDeleted": null },
      "lastVerification": {
        "at": "2026-09-30T12:40:11+02:00",
        "file": "demo-01__0005_x__20260930T1015Z__manual.cbak",
        "result": "restorable"
      },
      "lastSuccessfulVerificationAt": "2026-09-30T12:40:11+02:00",
      "fingerprints": [
        { "variable": "SESSION_SECRET", "class": "secret", "value": "Zb1c…22 caracteres", "current": true, "since": "2026-09-30" },
        { "variable": "BACKUP_KEY", "class": "secret", "value": "…", "current": true, "since": "2026-09-30" },
        { "variable": "DATABASE", "class": "database", "value": "…", "current": true, "since": "2026-09-30" }
      ]
    }
  ]
}
```

## Esquema (Zod, resumido)

```text
Inventory = {
  format: literal "chatbot-inventory"
  version: literal 1
  keyCheck: base64url de 22 caracteres
  createdAt: fecha YYYY-MM-DD
  instances: Instance[]            // ids únicos
}
Instance = {
  id: INSTANCE_ID_PATTERN
  client: string 1..120
  status: "provisioning" | "active" | "testing" | "retired"
  publicUrl: string | null
  imageVersion, llmWorkspace, backupKeyLocation: string 1..200 | null
  backupDir: string | null
  database: { host: string, port: int 1..65535, name: string, user: string } | null
  dates: { provisioned: fecha, retired: fecha | null, dataDeleted: fecha | null }
  lastVerification: { at: ISO 8601 con desfase, file: string, result: "restorable" | código 006 } | null
  lastSuccessfulVerificationAt: ISO 8601 | null
  fingerprints: { variable: string, class: Clase, value: base64url 22, current: boolean, since: fecha }[]
}
```

Reglas de coherencia comprobadas al leer (si fallan, el inventario es "no válido" y ninguna orden
escribe): `status = retired` ⇔ `dates.retired ≠ null`; `dates.dataDeleted ≠ null` ⇒
`status = retired`; ningún campo de texto contiene `://…:…@` (URL con credenciales).

## Huellas

```text
huella(clase, valor) = base64url( HMAC-SHA256(clave, "chatbot-inventory/v1\0" + clase + "\0" + normalizado)[0..16] )
keyCheck             = base64url( HMAC-SHA256(clave, "chatbot-inventory/v1\0key-check")[0..16] )
```

Normalización y clases por variable: [data-model.md](../data-model.md#huella).

## Compatibilidad

- Un inventario con `version` mayor que la conocida se rechaza como no válido (no se escribe).
- Campos desconocidos: se rechaza el inventario (esquema estricto) para no perder datos al
  reescribirlo con una versión anterior de las herramientas.
