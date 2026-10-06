# Quickstart: Claridad del panel del operador y enlace a mapa

**Feature**: `003-admin-panel-clarity` | Guía de validación (FR-016, SC-001 – SC-005)

## Requisitos previos

Los de la [guía de la 001](../001-business-knowledge-base/quickstart.md#requisitos-previos).

```bash
pnpm install
docker compose up -d db
pnpm db:migrate          # aplica 0003: columna business.map_url
pnpm dev                 # http://localhost:3000/admin
```

## Pruebas automáticas

```bash
pnpm test                # unitarias, de contrato e integración
pnpm test handoff        # solo lo de derivación
pnpm test:eval           # modelo real, con coste: incluye el caso de ubicación con enlace
pnpm lint && pnpm typecheck
```

Qué cubren: esquema de `map_url` (R7), `sameContact` y `describeHandoffChange` (R4, R5),
mensajes (R6), resúmenes (R10), snapshot con `mapUrl`, verificador con enlaces de mapas (R9),
rutas del panel con `fastify.inject` ([contracts/admin-panel.md](contracts/admin-panel.md)) y
frescura del snapshot en integración.

## Escenarios de validación manual

Parte de un negocio **en preparación** con teléfono `600 000 001` y sin contacto de derivación.
Para ver la vista del bot: `pnpm kb:snapshot`.

### 1. Contacto que usa el bot (US2, FR-005 – FR-007)

1. Abre Datos y Derivación. **Esperado**: ambas muestran "El bot pasa las conversaciones a:
   Teléfono +34600000001. Origen: teléfono del negocio…".
2. En Derivación añade `Teléfono 600 000 002` y `Email atencion@example.com`; guarda.
   **Esperado**: "Guardado. A partir de ahora el bot pasa las conversaciones al contacto de
   derivación configurado: …" con los dos medios en ese orden.
3. En Datos borra el teléfono y guarda. **Esperado**: se guarda y el mensaje dice que el
   teléfono del negocio no se usa y que el bot sigue pasando las conversaciones al contacto
   configurado.
4. En Datos cambia solo el nombre y guarda. **Esperado**: solo "Guardado".
5. Repite el paso 3 con JavaScript desactivado. **Esperado**: el mismo mensaje.

### 2. Quitar medios (US1, FR-001 – FR-004, SC-002)

1. En Derivación marca **Quitar** en el email. **Esperado**: la fila se ve tachada.
2. Recarga la página. **Esperado**: el email sigue ahí, sin marcar (US1-4).
3. Márcalo otra vez y guarda. **Esperado**: queda solo el teléfono; `pnpm kb:snapshot` muestra
   un único medio en `handoff.channels`.
4. Escribe `abc` en el valor del teléfono, márcalo como **Quitar** y guarda. **Esperado**: se
   guarda sin error de validación (la fila quitada no se valida) y el mensaje dice que el
   negocio se ha quedado sin salida a una persona y no se podrá activar hasta tenerla (FR-007).
5. Con JavaScript desactivado, añade un medio, guárdalo, márcalo como Quitar y guarda.
   **Esperado**: igual que con JavaScript.

### 3. Rechazo por FR-032 al quitar (US1-3, FR-003)

1. Registra un único medio de derivación, deja el teléfono del negocio vacío y activa el
   negocio.
2. Marca Quitar en ese medio y guarda. **Esperado**: `409`, el error general explica que el
   negocio activo se quedaría sin salida a una persona y el formulario muestra el medio
   **sin tachar**, como está guardado.
3. Registra el teléfono del negocio en Datos, vuelve a Derivación, quita el medio y guarda.
   **Esperado**: se guarda y el mensaje dice que el bot pasa las conversaciones al teléfono del
   negocio.

### 4. Pantallas de registro único y portada (US3, FR-008, FR-009, SC-004)

1. Abre Políticas, Tono y Derivación. **Esperado**: cada una explica que es un registro único
   y que guardar sustituye lo anterior; Derivación explica cómo añadir y quitar medios.
2. En la portada, con Políticas y Tono vacíos. **Esperado**: "Sin configurar" en ambas.
3. Guarda 3 formas de pago y el trato de usted. **Esperado**: "3 formas de pago · sin política
   de cancelación" y "trato de usted".
4. Con el contacto del paso 3-3. **Esperado**: Derivación muestra "usa el teléfono del negocio".

### 5. Cómo llegar y enlace a mapa (US4, FR-010 – FR-015, SC-005)

1. Abre Datos. **Esperado**: "Cómo llegar" tiene la ayuda y el ejemplo.
2. En "Enlace a mapa" prueba, guardando cada vez:
   - `maps.example.com/abc` → error junto al campo que pide el enlace completo con `https://`.
   - `http://maps.example.com/abc` → error que pide el enlace seguro.
   - `https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor` → se guarda.
   **Esperado** en los errores: nada guardado y el resto de campos conserva lo escrito.
3. **Esperado**: aparece "Abrir en una pestaña nueva" y abre el enlace.
4. `pnpm kb:snapshot`. **Esperado**: `business.mapUrl` con el enlace, junto a `address` y
   `directions`. No aparece ningún aviso nuevo, tampoco sin dirección.
5. En "Probar el bot" pregunta "¿dónde estáis?". **Esperado**: la respuesta trae la dirección,
   las indicaciones y el enlace exacto.
6. Vacía el campo y guarda. **Esperado**: `mapUrl: null` en el siguiente `kb:snapshot` y el bot
   deja de dar el enlace, sin reiniciar.

### 6. Guía de la 001 (US5, FR-016, SC-001)

Pide a alguien que no conozca el panel que siga el escenario 6 de la
[guía de la 001](../001-business-knowledge-base/quickstart.md). **Esperado**: lo completa en
menos de 5 minutos sin preguntar cómo se elimina el contacto de derivación.
