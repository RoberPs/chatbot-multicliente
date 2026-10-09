# Quickstart: validar la resistencia a los cortes de la base de datos

**Feature**: 016-db-outage-resilience · **Fecha**: 2026-10-09

Guía de validación de punta a punta. Cada escenario dice qué hay que ver para dar la corrección
por buena. El detalle de comportamientos está en los contratos; aquí solo se ejecuta y se
comprueba.

---

## Requisitos previos

```bash
pnpm install
docker compose up -d db                     # PostgreSQL local
cp .env.example .env && pnpm operator:hash-password
pnpm db:migrate
```

Docker en marcha es imprescindible: las pruebas de integración levantan PostgreSQL con
Testcontainers y la del corte levanta **un contenedor propio** que para y arranca el servidor por
dentro.

---

## Escenario 1 · Las pruebas automáticas (FR-001 a FR-011)

```bash
pnpm lint && pnpm typecheck
pnpm test                                   # unitarias + contrato + integración
```

Pruebas concretas, por si se quieren mirar de una en una:

```bash
pnpm test db-outage                         # el corte real: FR-001 a FR-004, FR-014
pnpm test database-url                      # withDatabaseName con socket: FR-011
pnpm test verify-socket                     # db:verify por socket y motivos: FR-006, FR-008
pnpm test pool-listeners                    # inventario estático de conexiones: FR-005
pnpm test frame-degraded                    # la interfaz no se queda colgada: FR-009, FR-013
```

**Qué hay que ver.** Todo verde. La prueba del corte tarda más que el resto (para y arranca
PostgreSQL dos veces); está dentro de `pnpm test` a propósito.

---

## Escenario 2 · El corte a mano, con el chat web abierto (US1)

Con la instancia en marcha (`pnpm dev`) y el chat abierto en `http://localhost:3000/chat/frame`:

```bash
docker compose stop db                      # la base desaparece
```

1. Escribe un mensaje en el chat.
2. **Qué hay que ver**: en menos de 10 s, un aviso de que ahora no se te puede atender **con una
   forma de contactar** (el teléfono de emergencia de la instancia, porque la información del
   negocio no se puede leer). El indicador «escribiendo…» desaparece.
3. **Comprueba que el proceso vive**: la terminal de `pnpm dev` **no** se ha reiniciado y sigue
   atendiendo.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health
curl -s http://localhost:3000/health
```

4. **Qué hay que ver**: **200** y `{"status":"db_unavailable"}`. No 503, no silencio.

```bash
docker compose start db                     # la base vuelve
```

5. Vuelve a escribir en el chat.
6. **Qué hay que ver**: responde con normalidad en menos de 30 s, **sin que se haya reiniciado
   nada** y sin tocar el panel. La sesión del panel que tuvieras abierta sigue valiendo: entra en
   `http://localhost:3000/admin` sin volver a identificarte.

---

## Escenario 3 · El registro del corte (FR-014, SC-008)

Con la salida de `pnpm dev` delante, repite el escenario 2 y mira el registro.

**Qué hay que ver**: exactamente una anotación `db_outage_started`, una `db_outage_recovered`
—con la duración y el número de fallos agrupados— y, si el corte pasó de 5 minutos, un
`db_outage_ongoing` por cada intervalo. **Ninguna anotación por petición fallida** y ninguna con
una dirección de base de datos, un host o una credencial.

---

## Escenario 4 · La interfaz ante un fallo que no entiende (US3)

Sin parar la base de datos, provoca desde el servidor una respuesta de error al envío (por
ejemplo, con el gancho de pruebas de la ruta o parando la instancia y dejando el proxy delante).

1. **Qué hay que ver**: la interfaz deja de indicar espera y muestra el aviso con el contacto
   —el que trae la página desde que se cargó—, **sin esconder el formulario**.
2. Restablece el servicio y vuelve a escribir.
3. **Qué hay que ver**: la conversación continúa con normalidad.

---

## Escenario 5 · Comprobación de una copia (US2)

En local, con la base alcanzada por nombre de servidor:

```bash
pnpm db:backup
pnpm db:backups
pnpm db:verify <fichero>
```

**Qué hay que ver**: `RESTAURABLE` con los recuentos por tabla, igual que antes de esta
corrección (US2-3: lo que funcionaba sigue funcionando).

Con una copia estropeada o la clave cambiada:

```bash
pnpm db:verify <fichero-dañado>
```

**Qué hay que ver**: `NO RESTAURABLE` con el motivo **de la copia** (`corrupted`, `wrong_key`),
nunca uno de conexión.

Con una dirección de verificación inalcanzable (`BACKUP_VERIFY_URL` a un puerto cerrado):

**Qué hay que ver**: `no se pudo conectar con el servidor de verificación`, no «no se pudo crear
la base de datos temporal».

---

## Escenario 6 · Las dos casillas bloqueadas de la fase 9 (SC-004)

En el servidor de producción, tras desplegar la 0.1.1 en las dos instancias:

```bash
# En cada instancia
docker compose -f deploy/docker-compose.prod.yml exec instancia-1 node dist/src/cli/backup.js
docker compose -f deploy/docker-compose.prod.yml exec instancia-1 node dist/src/cli/verify.js <fichero>
```

1. **Qué hay que ver**: `RESTAURABLE` en las dos instancias. Es la casilla que quedó bloqueada en
   la fase 9 por el fallo del socket.
2. Para PostgreSQL de producción y escribe al bot por WhatsApp y por el chat web.
3. **Qué hay que ver**: las dos instancias siguen en `Up` (no `Restarting`), `/health` responde
   200 con `db_unavailable`, y por los dos canales llega el aviso con el **teléfono de
   emergencia**. Es la segunda casilla bloqueada.
4. Arranca PostgreSQL y comprueba que las dos vuelven a atender solas.

---

## Qué NO hay que ver en ningún escenario

- Una instancia en `Restarting` por un corte de la base de datos.
- Un chat indicando «escribiendo…» sin final.
- Un mensaje, aviso o anotación con una dirección de base de datos, un host, un usuario, una
  contraseña o una ruta de socket.
- Un motivo de `db:verify` que señale una capa distinta de la que falló.
