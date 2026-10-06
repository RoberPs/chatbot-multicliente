# Quickstart: validar la exportación e importación de la configuración

**Feature**: 008-config-export-import

Guía para comprobar la feature de extremo a extremo en local con dos instancias ("pruebas" y
"producción") sobre el PostgreSQL de `docker compose`. Referencias:
[formato del fichero](contracts/config-file-format.md),
[páginas del panel](contracts/admin-config-transfer.md),
[registro](contracts/transfer-log.md), [modelo de datos](data-model.md).

## Requisitos

- Lo de `CLAUDE.md` → "Arranque y pruebas en local" hecho una vez (`.env` con hash del operador).
- `docker compose up -d db` en marcha.

## 1. Pruebas automáticas

```bash
pnpm test:unit config-transfer      # formato, validación (cada regla), diff, huella, versiones,
                                    # cobertura de columnas, serialización canónica
pnpm test:contract config            # rutas: sesión, CSRF, 413/422/404/409, exportación, registro sin datos
pnpm test:integration config         # SC-001…SC-007 con Testcontainers
pnpm lint && pnpm typecheck
```

Resultado esperado: todo en verde. Los tests de integración cubren:

| Criterio | Qué comprueba |
|----------|---------------|
| SC-001 | Exportar un negocio completo e importarlo en una BD vacía → `getSnapshot()` de las dos instancias igual salvo identificadores y marcas de tiempo |
| SC-002 | Exportar e importar en la misma instancia → vista previa "igual a la actual", sin cambios en la BD |
| SC-003 | Con clientes, conversaciones, mensajes, derivaciones y uso del chat web de todos los canales, el fichero no contiene ninguno de sus valores; sin la casilla, tampoco los destinos de avisos |
| SC-004 | Estado del negocio y activación del chat web iguales antes y después (en preparación ← activo y al revés) |
| SC-005 | Fichero inválido, versión futura, crítico en activo, cambio concurrente y fallo inyectado a mitad → huella de todas las tablas de configuración idéntica; `config_pre_import` sin cambiar |
| SC-007 | 200 servicios, 50 recursos y 200 preguntas: vista previa y aplicación < 5 s cada una |

## 2. Dos instancias en local

Crear la segunda base de datos y migrarla (bash; en PowerShell, `$env:DATABASE_URL = '…'` antes
de cada orden):

```bash
docker compose exec db createdb -U postgres chatbot_prod
DATABASE_URL=postgres://postgres:postgres@localhost:5432/chatbot_prod pnpm db:migrate
```

Arrancar las dos (dos terminales; ajusta usuario y contraseña a tu `.env`):

```bash
INSTANCE_ID=pruebas pnpm dev                                           # http://localhost:3000/admin
INSTANCE_ID=produccion PORT=3001 \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/chatbot_prod pnpm dev   # :3001
```

> `INSTANCE_ID` va junto con `BACKUP_DIR` y `BACKUP_KEY` (el arranque exige las tres o ninguna):
> define también esas dos con valores de prueba. Sin `INSTANCE_ID`, el fichero sale con
> `source.instanceId: null` y la vista previa no puede decir si es de la misma instancia.

## 3. Escenarios manuales

1. **Exportar (US1)** — En `:3000`, registra un negocio completo (datos, horario, un cierre, dos
   servicios, un recurso que preste uno, dos preguntas, políticas, tono, derivación, chat web con
   una web y enlace de privacidad, y destinos de avisos). Habla con el bot en "Probar el bot".
   *Exportar e importar* → **Exportar** sin la casilla.
   Esperado: se descarga `configuracion-pruebas-<fecha>.json`; `includesAlertDestinations: false`,
   sin `alertDestinations`, sin textos de la conversación de prueba. Repite con la casilla:
   aparece `alertDestinations`.
2. **Rechazo de ficheros inválidos (US3)** — En `:3001` sube: un `.txt` cualquiera (→ "no es
   una exportación"), el fichero con `"formatVersion": 99` (→ actualizar el núcleo de destino),
   con `"priceCents": -1` y un recurso que cita un servicio inexistente (→ lista con los dos
   errores, sección y elemento), con una clave inventada (→ campo no reconocido) y uno de más de
   5 MB (→ tamaño máximo). Esperado: la configuración y los avisos de `:3001` no cambian.
3. **Vista previa e importación (US2)** — En `:3001`, con el negocio en preparación, sube el
   fichero con destinos. Esperado: metadatos (origen `pruebas`), todo como "añadido", aviso de
   destinos de avisos con la casilla, avisos resultantes y "Se aplicará". Marca la casilla (la
   vista previa se actualiza), **Confirmar**. Esperado: resultado con los cambios y el enlace a
   la configuración anterior; el negocio sigue **En preparación** y el chat web **desactivado**;
   "Probar el bot" en `:3001` responde con los mismos horarios, servicios, precios y preguntas
   que en `:3000` (SC-001, SC-006).
4. **Misma instancia (SC-002)** — Exporta `:3001` e impórtalo en `:3001`. Esperado: "exportado de
   esta misma instancia" y "La configuración del fichero es igual a la actual".
5. **Regla de avisos críticos (FR-018)** — Activa el negocio en `:3001`. En una copia del fichero
   deja `business.phone` a `null` y `handoff` a `null`; súbela. Esperado: aviso crítico destacado
   y "Se rechazará"; forzando la confirmación (p. ej. con otra pestaña) → 409 y nada cambia.
6. **Chat web activo** — Activa el chat web de `:3001`, sube un fichero con otra web permitida y
   otros topes. Esperado: la vista previa destaca la web que dejará de poder usar el chat y los
   topes; con `allowedOrigins: []` → "Se rechazará".
7. **Cambio concurrente (FR-019)** — Genera la vista previa, cambia una pregunta en otra pestaña
   y confirma. Esperado: 409 con vista previa nueva.
8. **Deshacer (US2-9)** — Tras una importación, descarga "Configuración anterior" en
   *Exportar e importar* e impórtala. Esperado: la vista previa muestra el cambio inverso y, al
   confirmar, vuelve la configuración previa (incluidos los destinos de avisos si se marcan).
9. **Cancelar** — Sube un fichero y pulsa **Cancelar**. Esperado: "Importación cancelada; no se
   ha cambiado nada" y el enlace de la vista previa da 404.
10. **Registro (FR-024)** — En la salida de las dos instancias, los eventos `config_*` solo
    llevan recuentos, códigos y el origen; ningún nombre, teléfono, correo ni texto.
