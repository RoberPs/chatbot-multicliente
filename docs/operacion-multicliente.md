# Operación multicliente: cómo se reutiliza el chatbot con seguridad

Guía para el desarrollador y operador del producto. Explica qué es común y qué es de cada cliente,
cómo se da de alta un cliente nuevo, cómo se actualiza el núcleo sin romper a nadie y qué specs
faltan para que todo esto deje de hacerse a mano.

Documentos de referencia: [constitución](../.specify/memory/constitution.md) (reglas de producto) y
[README](../README.md) (estado, variables de entorno y comandos).

---

## 1. Modelo mental

El producto no se "configura en local y se sube". **Lo único que viaja de tu máquina a producción es
el código**, y es el mismo para todos los clientes. La información de cada negocio vive en la base de
datos de su instancia y se registra en el panel `/admin` de esa instancia, ya en producción.

| Pieza | Qué contiene | ¿Común o por cliente? |
|---|---|---|
| **Imagen Docker del núcleo** (`Dockerfile`) | Todo `src/`, compilado | Común: una sola imagen, etiquetada por versión |
| **Variables de entorno** | BD, credencial del operador, `SESSION_SECRET`, clave de Anthropic, WhatsApp, `PUBLIC_BASE_URL`… | Por cliente |
| **Base de datos PostgreSQL** | Datos del negocio, servicios, precios, horarios, FAQ, configuración del chat web, conversaciones | Por cliente (una BD por instancia, sin `tenant_id`) |
| **Extensiones** | Comportamiento que la configuración no cubre | Por cliente, con spec propia (Principio III) |

```text
                 ┌──────────────── tu máquina ────────────────┐
                 │ specs → código → pnpm test → docker build  │
                 └───────────────────────┬────────────────────┘
                                         │ imagen chatbot:X.Y.Z (igual para todos)
          ┌──────────────────────────────┼──────────────────────────────┐
          ▼                              ▼                              ▼
  instancia cliente A            instancia cliente B            instancia de pruebas (tuya)
  .env A + BD A                  .env B + BD B                  .env P + BD P (datos ficticios)
  a.tudominio.com/admin          b.tudominio.com/admin          staging.tudominio.com/admin
```

### Papeles

- **Desarrollador (tú)**: mejora el núcleo en local, siempre empezando por una spec, y publica
  versiones de la imagen.
- **Operador (tú)**: registra y mantiene la información de cada negocio en su panel. Según el
  Principio VI, el cliente **no** edita su propia configuración: te pide los cambios y los aplicas
  tú, sin desplegar nada.
- **Cliente (el negocio)**: recibe el fragmento del chat web para su web y/o conecta su número de
  WhatsApp. Paga el servicio y, según lo que acordéis, el consumo de la API.

### Para qué sirve tu localhost

- Desarrollar y probar el núcleo con los negocios de ejemplo de `tests/fixtures/` (los únicos
  sitios donde puede haber nombres de sector).
- `pnpm bot:chat`, "Probar el bot" y `pnpm test:eval` para comprobar calidad antes de publicar.
- **No** se usa para preparar datos reales de clientes: hoy no existe forma de trasladar la
  configuración de una BD a otra (ver la propuesta de spec [P2](#p2-exportar-e-importar-la-configuración-del-negocio)).

---

## 2. Alta de un cliente nuevo

Hoy se hace a mano. La spec [P1](#p1-aprovisionamiento-de-instancias) propone automatizarlo.

### 2.1 Antes de tocar nada

- [ ] Contrato de encargo del tratamiento (RGPD, art. 28) firmado con el cliente, que mencione a
      los subencargados: Anthropic, Meta (si usa WhatsApp) y OpenAI (si se activan los audios).
- [ ] Enlace a la política de privacidad del cliente (el chat web no se activa sin él).
- [ ] Decidido quién paga la API de Anthropic (ver [sección 4](#4-coste-de-la-api)).
- [ ] Subdominio elegido, por ejemplo `nombrecliente.tudominio.com`, con certificado TLS.

### 2.2 Recursos de la instancia

1. **Base de datos nueva y vacía**, dedicada al cliente, con un usuario de PostgreSQL que solo
   tenga permisos sobre esa BD:

   ```sql
   CREATE ROLE cliente_x LOGIN PASSWORD '<aleatoria, larga>';
   CREATE DATABASE chatbot_cliente_x OWNER cliente_x;
   REVOKE CONNECT ON DATABASE chatbot_cliente_x FROM PUBLIC;
   ```

2. **Secretos nuevos**, nunca copiados de otra instancia:

   ```bash
   openssl rand -hex 32            # SESSION_SECRET
   pnpm operator:hash-password     # OPERATOR_PASSWORD_HASH (contraseña ≥ 12 caracteres, distinta por cliente)
   openssl rand -hex 24            # WHATSAPP_VERIFY_TOKEN, si usa WhatsApp
   ```

3. **Clave de Anthropic propia** del cliente, en un workspace propio con límite de gasto.

4. **WhatsApp** (opcional): número y app de Meta del cliente; las cinco variables `WHATSAPP_*` o
   ninguna.

### 2.3 Fichero de entorno

Parte **siempre** de `.env.example`, nunca del `.env` de otro cliente.

| Variable | Valor para el cliente |
|---|---|
| `DATABASE_URL` | La BD y el usuario creados en 2.2 |
| `OPERATOR_USER` · `OPERATOR_PASSWORD_HASH` | Credencial propia de esta instancia |
| `SESSION_SECRET` | Recién generado |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | Número de saltos del proxy (`1` si hay uno); nunca `true` |
| `PUBLIC_BASE_URL` | `https://nombrecliente.tudominio.com` |
| `DEFAULT_TIMEZONE` · `DEFAULT_PHONE_REGION` · `DEFAULT_CURRENCY` | Los del negocio |
| `EMERGENCY_CONTACT_PHONE` | Teléfono E.164 del negocio |
| `ANTHROPIC_API_KEY` | La clave de su workspace |
| `LLM_MODEL` · `LLM_EFFORT` | Los valores por defecto salvo motivo documentado |
| `WHATSAPP_*` | Las cinco, o ninguna |
| `AUDIO_TRANSCRIPTION` · `STT_*` | `off` salvo que esté contratado y cubierto por el contrato. Antes de activarlo en el primer cliente, completa la evaluación de audios pendiente (tarea T083 de la 002: grabaciones y `pnpm test:eval audio`) |
| `INSTANCE_ID` | Identificador único de la instancia (minúsculas, cifras y guiones), p. ej. `cliente-x`. Va dentro de cada copia |
| `BACKUP_DIR` | Ruta absoluta del volumen persistente de copias, p. ej. `/var/lib/chatbot/backups` |
| `BACKUP_KEY` | `openssl rand -hex 32`, **distinta** de `SESSION_SECRET` y de la de otras instancias; guárdala también **fuera** de `BACKUP_DIR` |
| `BACKUP_RETENTION_DAYS` · `BACKUP_DAILY_TIME` | `7` y `03:00` (hora local del negocio) salvo acuerdo distinto; retención de 1 a 30 días |

En `production` la instancia **no arranca** sin `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY`. El
contenedor necesita un **volumen persistente** montado en `BACKUP_DIR` y escribible por el usuario
`node` (la imagen declara `/var/lib/chatbot/backups`). Si ese volumen está en la misma máquina que
la BD, activa las instantáneas o la réplica del proveedor, o sincroniza el directorio fuera:
perder la máquina haría perder las copias.

Guarda este fichero en un gestor de secretos (o en las variables cifradas de tu plataforma), no en
el repositorio. Sin `BACKUP_KEY` las copias de la instancia no se pueden restaurar.

### 2.4 Despliegue

1. Arranca un contenedor con la **misma imagen etiquetada** que el resto (`chatbot:X.Y.Z`) y el
   entorno del cliente. Al arrancar aplica las migraciones y crea el negocio vacío en
   "En preparación".
2. Comprueba que `https://nombrecliente.tudominio.com/admin` pide login y que la cookie es `Secure`.

### 2.5 Configuración del negocio (en el panel de producción)

1. Rellena datos del negocio, horarios, servicios, precios y preguntas frecuentes.
2. Resuelve los avisos críticos: el sistema no deja activar un negocio que los tenga (FR-032).
3. Prueba en "Probar el bot" las preguntas típicas del sector y alguna trampa (precio no
   registrado, "quiero hablar con una persona").
4. Pasa el negocio a activo.
5. Chat web: webs permitidas, enlace de privacidad, topes diarios y mensuales acordes a lo
   contratado, y activar. Entrega al cliente el fragmento `<script>`.
6. WhatsApp: registra en Meta el webhook `https://…/webhooks/whatsapp` con el `WHATSAPP_VERIFY_TOKEN`
   y envía un mensaje de prueba.

### 2.6 Cierre del alta

- [ ] Copia de seguridad inicial: `node dist/src/cli/backup.js` en el contenedor.
- [ ] Copia comprobada con la [guía de validación de copias](#8-copias-de-seguridad-guía-de-validación)
      (`pnpm db:verify` desde tu instancia de pruebas) y resultado anotado.
- [ ] Anotada la instancia en tu inventario: cliente, subdominio, versión de la imagen, workspace
      de Anthropic, `INSTANCE_ID`, dónde está guardada su `BACKUP_KEY`, fecha de alta.
- [ ] El cliente sabe cómo pedirte cambios (canal y plazo).

---

## 3. Aislamiento entre clientes

El código no tiene `tenant_id`: **el aislamiento depende por completo de cómo se despliega.** Estas
reglas no son opcionales.

1. **Una BD por cliente, con usuario propio.** Si dos instancias apuntaran a la misma BD, cada una
   vería los datos y conversaciones de la otra.
2. **Secretos únicos por instancia.** Un `SESSION_SECRET` repetido permitiría reutilizar una sesión
   del panel de un cliente en otro con la misma credencial.
3. **Credencial de operador distinta por instancia.** Si se filtra una, solo cae un panel.
4. **Nunca clonar BD** de localhost ni de otro cliente para empezar uno nuevo.
5. **Clave de Anthropic por cliente** (ver sección 4).
6. **Núcleo sin lógica de cliente.** Nada de `if cliente === …` en `src/`. Lo vigila
   `pnpm test sector-neutrality`; no se desactiva.
7. **Extensiones aisladas.** Una extensión de un cliente no puede afectar a otras instancias, y
   retirarla deja la instancia con el comportamiento del núcleo (Principio III).
8. **Logs sin datos personales.** Los registros técnicos ya no guardan textos, números, tokens ni
   IP; no añadas nada que rompa esa regla al depurar un cliente concreto.

---

## 4. Coste de la API

Dos modelos posibles; elige uno por cliente y déjalo por escrito en el contrato.

| Modelo | Cómo funciona | Ventajas | Inconvenientes |
|---|---|---|---|
| **Clave tuya, workspace por cliente** | Creas en la consola de Anthropic un workspace por cliente, con su clave y su límite de gasto, y repercutes el coste | Controlas el modelo y el gasto; facturación clara por cliente | Adelantas tú el pago |
| **Clave del cliente** | El cliente crea su cuenta y te da la clave | El cliente paga directamente a Anthropic | Dependes de que mantenga su cuenta al día; si se queda sin saldo, el bot deja de responder |

En los dos casos:

- Nunca uses la misma clave para varios clientes: no sabrías cuánto consume cada uno, no podrías
  cortar a uno sin afectar a los demás y una filtración expondría a todos.
- Ajusta los topes del chat web (200 al día y 3 000 al mes por defecto) a lo contratado.
- Hoy el panel no muestra el coste en tokens por instancia; lo propone la spec
  [P4](#p4-consumo-y-coste-por-instancia).

---

## 5. Actualizar el núcleo

Una versión nueva de la imagen llega a **todos** los clientes y las migraciones se aplican solas al
arrancar. Por eso:

1. `pnpm lint && pnpm typecheck && pnpm test` en verde.
2. `pnpm test:eval` (y `EVAL_CHANNEL=web pnpm test:eval`) sin regresiones en los criterios.
3. Construye y etiqueta la imagen con versión semántica: `chatbot:1.4.0`. Nunca desplegar `latest`.
4. Despliega primero en **tu instancia de pruebas** (datos ficticios, mismo tipo de entorno que
   producción) y repasa el panel y "Probar el bot".
5. **Copia de seguridad**: la hace la propia instancia al arrancar si tiene migraciones pendientes
   y datos (`…__premigration.cbak`). Si no puede hacerla (falta la configuración, el directorio no
   existe o no se puede escribir, disco lleno), **no migra ni arranca** y lo registra como
   `migration_blocked`; el esquema queda sin cambios. Arregla la causa y vuelve a arrancar.
6. Actualiza los clientes de uno en uno o por tandas pequeñas, comprobando cada instancia.
7. Si algo falla: vuelve a la etiqueta anterior. Si la migración ya se aplicó y no es compatible
   hacia atrás, para la instancia y restaura con la **imagen anterior** la copia `premigration`
   que nombra el error (`node dist/src/cli/restore.js <fichero>`). Después de verificar la
   actualización, repite la [guía de validación de copias](#8-copias-de-seguridad-guía-de-validación)
   con esa copia.

Reglas de las migraciones a partir de la 006 (la restauración de copias antiguas reaplica las
migraciones y comprueba su hash):

- Las migraciones son **de solo añadir** (columnas o tablas nuevas antes de dejar de usar las
  viejas).
- Los ficheros de migraciones ya publicados **no se editan nunca**: una copia hecha con ellos
  dejaría de poder restaurarse (`schema_mismatch`).

---

## 6. Cambios que pide un cliente

Antes de programar nada, en este orden (Principio II):

1. **¿Se cubre con la configuración actual?** Hazlo en su panel. Sin despliegue.
2. **¿Se cubriría ampliando la configuración de forma válida para cualquier sector?** Spec de
   **núcleo** que no mencione al cliente (solo como ejemplo ilustrativo). Lo reciben todos.
3. **¿Es realmente particular de ese cliente?** Spec de **extensión**, conectada a un punto de
   extensión del núcleo. Si ese punto no existe, primero una spec de núcleo que lo añada de forma
   genérica (ver [P5](#p5-puntos-de-extensión-del-núcleo)).

---

## 7. Baja de un cliente

1. Desactiva el chat web y retira el webhook de WhatsApp en Meta.
2. Entrega al cliente los datos que le correspondan según el contrato.
3. Para el contenedor, revoca su clave de Anthropic y elimina sus secretos.
4. Borra la BD y sus copias de seguridad en el plazo acordado, y anótalo en el inventario. Las
   copias viven en el volumen de `BACKUP_DIR` (y en sus réplicas o instantáneas, si las hay):
   borra ese volumen y las réplicas. Destruir la `BACKUP_KEY` de la instancia deja ilegibles las
   copias que quedaran en cualquier otro sitio.

---

## 8. Copias de seguridad: guía de validación

Cada instancia copia su BD en `BACKUP_DIR` con los mismos comandos (feature 006):

| Comando (local / en la imagen) | Qué hace |
|---|---|
| `pnpm db:backup` / `node dist/src/cli/backup.js` | Copia bajo demanda, cifrada, sin pausar al bot |
| `pnpm db:restore <fichero>` / `node dist/src/cli/restore.js` | Restaura con la instancia **parada**; pide escribir el `INSTANCE_ID` para confirmar |
| `pnpm db:verify <fichero>` / `node dist/src/cli/verify.js` | Restaura en una BD temporal, compara y la borra |
| `pnpm db:backups [--prune]` / `node dist/src/cli/backups.js` | Lista las copias de la instancia y aplica la retención |

Además, la instancia hace una copia diaria (`BACKUP_DAILY_TIME`, hora local del negocio) y una
previa a cada migración, y borra las de más de `BACKUP_RETENTION_DAYS` días conservando siempre la
última válida. Todos los comandos aceptan `--json` para anotar el resultado en el inventario.

Una copia que no se ha restaurado nunca no está comprobada. Esta guía se hace en menos de 15
minutos.

### Cuándo repetirla

- Al dar de alta una instancia ([cierre del alta](#26-cierre-del-alta)).
- **Una vez al mes** por instancia, con la copia diaria más reciente.
- Tras cada actualización del núcleo con migraciones, con la copia `premigration`.
- Tras cambiar `BACKUP_KEY`.

Anota en el inventario la fecha, el fichero y el resultado de `db:verify --json`.

### Antes de empezar (una vez por instancia)

1. `BACKUP_KEY` generada con `openssl rand -hex 32` y guardada en el gestor de secretos, **no** en
   `BACKUP_DIR`. Si se pierde, sus copias no se pueden recuperar.
2. `BACKUP_DIR` en un volumen persistente distinto del contenedor, con instantáneas, réplica o
   sincronización fuera de la máquina.
3. Una instancia de pruebas (la tuya de staging, o `docker compose up -d db` + `pnpm dev` en tu
   equipo) con un usuario de PostgreSQL con `CREATEDB` para `db:verify` (`BACKUP_VERIFY_URL`),
   **sin** variables `WHATSAPP_*` ni `SMTP_*`: tras restaurar tendrá los destinos de avisos del
   negocio real y no debe poder escribirles.

### Pasos

1. **Copiar** (en la instancia real): `node dist/src/cli/backup.js`. Esperado: nombre
   `<instancia>__<esquema>__<fecha>__manual.cbak`, tamaño y recuentos por tabla. Apunta los
   recuentos de `business`, `service` y `faq`.
2. **Llevar el fichero** a la instancia de pruebas por el medio que uses para sacar copias de la
   máquina. La clave de la instancia real se pone en la de pruebas solo durante la prueba, en
   `BACKUP_KEYS_PREVIOUS`, nunca como `BACKUP_KEY`.
3. **Comprobar** (en la de pruebas): `pnpm db:verify <fichero>`. Esperado: `RESTAURABLE`, misma
   instancia, esquema y recuentos que en el paso 1, y "Base de datos temporal eliminada".
4. **Restaurar en la instancia de pruebas**, parada:
   `pnpm db:restore <fichero> --from-instance <instancia-real>`, escribir el `INSTANCE_ID` de la
   de pruebas para confirmar y arrancar con `pnpm dev`. Esperado: "Restaurada" con los mismos
   recuentos; al arrancar se aplican las migraciones pendientes (con su copia previa) y se borran
   las conversaciones de más de 30 días.
5. **Confirmar en el panel** de pruebas (`/admin`): nombre del negocio, servicios, precios,
   horarios y FAQ iguales a los de la instancia real; mismo estado (activo o en preparación). Los
   avisos que muestre el panel son los del estado restaurado: la restauración no los recalcula ni
   cambia el estado del negocio o de los canales.
6. **Limpiar**: quita `BACKUP_KEYS_PREVIOUS` de la instancia de pruebas y vuelve a sus datos
   ficticios (o `docker compose down -v`), porque ahora contiene datos reales de clientes finales.

### Si algo falla

| Mensaje | Qué hacer |
|---|---|
| `wrong_key` | La copia es de otra clave: añade la anterior en `BACKUP_KEYS_PREVIOUS` |
| `other_instance` | Es de otra instancia: repite con `--from-instance <id>` si es lo que quieres |
| `schema_newer` | La copia es de un núcleo más reciente: restaura con esa versión de la imagen o posterior |
| `corrupted` | El fichero está dañado o incompleto: usa otra copia y revisa cómo se transfirió |
| `instance_running` | Para la instancia antes de restaurar |
| `verify_db_unavailable` | `BACKUP_VERIFY_URL` necesita un servidor accesible y un usuario con `CREATEDB` |

---

## 9. Propuestas de specs

Lo anterior funciona a mano con pocos clientes, pero con cada cliente nuevo aumenta el riesgo de
error humano (secretos repetidos, BD equivocada, actualizaciones sin copia). Estas specs lo cubren.
Todas son de **núcleo**: genéricas, sin nombres de cliente ni de sector.

### 9.1 Specs ya realizadas

Estado tomado del [README](../README.md) a 2026-09-30.

| Nº | Feature | Estado | Qué aporta a la operación multicliente |
|---|---|---|---|
| 001 | Base de conocimiento del negocio | Completada | Panel `/admin` por instancia, avisos calculados y bloqueo de activación con avisos críticos (FR-032) |
| 002 | Atención de dudas y precios por WhatsApp | Completada (evaluación de audios aplazada hasta que un cliente los active, T083) | Canal WhatsApp, `pnpm bot:chat` y `pnpm test:eval` para comprobar calidad antes de publicar |
| 003 | Claridad del panel del operador y enlace a mapa | Completada | Panel más claro para el operador |
| 004 | Canal web del bot de atención | Completada | Chat web incrustable, webs permitidas y topes diarios y mensuales de respuestas |
| 005 | Derivación de la conversación al negocio | Completada | Salida a una persona (Principio V): avisos al negocio por WhatsApp y/o email (`SMTP_*`) |
| 006 | Copias de seguridad y restauración por instancia | Completada | **Era la propuesta P3**: copias cifradas diarias, bajo demanda y previas a cada migración; restauración y verificación ([sección 5](#5-actualizar-el-núcleo) y [sección 8](#8-copias-de-seguridad-guía-de-validación)) |

Todas están completadas. Solo queda aplazada la evaluación de audios de la 002 (T083), que se hace
antes de activar los audios en una instancia.

### 9.2 Orden de ejecución

Una spec cada vez, en este orden (`/speckit-specify` → plan → tasks → implement). Los números
definitivos los asigna `/speckit-specify`; si no se cuela otra feature, serán 007, 008…

| Orden | Id | Propuesta | Prioridad | Depende de | Cuándo |
|---|---|---|---|---|---|
| 1 | P1 | Aprovisionamiento de instancias | Alta | 006 (variables de copia) | Antes del 2.º cliente |
| 2 | P2 | Exportar e importar la configuración del negocio | Alta | — | Antes del 2.º o 3.er cliente |
| 3 | P6 | Versión visible y actualización escalonada | Media | P1 (inventario), 006 (copia previa) | Antes de la primera actualización con 2 o más instancias |
| 4 | P4 | Consumo y coste por instancia | Media | — | Antes de facturar el consumo o de activar WhatsApp en un cliente con tráfico abierto |
| 5 | P5 | Puntos de extensión del núcleo | Baja | — | Solo cuando llegue la primera petición que no quepa en la configuración |
| — | P3 | Copias de seguridad y restauración por instancia | — | — | **Hecha** (feature 006) |

Por qué este orden:

1. **P1 primero** porque protege el aislamiento, que depende por completo del despliegue
   ([sección 3](#3-aislamiento-entre-clientes)). Desde la 006 el alta tiene todavía más piezas
   manuales (`INSTANCE_ID`, `BACKUP_DIR`, `BACKUP_KEY`) y un error ahí no se nota hasta que hace
   falta restaurar.
2. **P2 después** porque ahorra trabajo en cada alta y permite revisar la configuración en la
   instancia de pruebas antes de llevarla a producción, pero su ausencia no pone datos en riesgo.
3. **P6** en cuanto haya dos instancias en producción: saber qué versión corre cada una es lo
   que hace seguras las actualizaciones por tandas. Usa el inventario de P1.
4. **P4** cuando el consumo se facture o el riesgo de gasto crezca. Mientras tanto, el límite de
   gasto del workspace de Anthropic de cada cliente ([sección 4](#4-coste-de-la-api)) es la red de
   seguridad.
5. **P5** no se adelanta: se diseña a partir de un caso real.

### P1. Aprovisionamiento de instancias

- **Ámbito**: núcleo (herramientas de operación).
- **Problema**: el alta se hace a mano y cada paso manual puede romper el aislamiento (secretos
  copiados, BD compartida, variables incompletas). Desde la 006 hay además un identificador de
  instancia, un volumen de copias y una clave de copias que deben ser únicos y estar guardados.
- **Alcance**:
  - Comando `pnpm instance:new` que pide los datos mínimos (identificador de instancia, URL
    pública, zona horaria, región telefónica, moneda, teléfono de emergencia) y genera un fichero
    de entorno completo a partir de `.env.example`, con secretos nuevos: `SESSION_SECRET`,
    `BACKUP_KEY`, `WHATSAPP_VERIFY_TOKEN` si usa WhatsApp, y el hash de la contraseña del operador.
  - Script SQL o comando que crea la BD y un usuario con permisos solo sobre ella.
  - Comando `pnpm instance:check` que valida un fichero de entorno antes de desplegar: variables
    obligatorias (incluidas `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY`), `NODE_ENV=production`,
    `https` en `PUBLIC_BASE_URL`, WhatsApp "las cinco o ninguna", `SMTP_URL` y `SMTP_FROM` juntas,
    `BACKUP_KEY` distinta de `SESSION_SECRET`, y que ni el `INSTANCE_ID` ni ningún secreto
    coincide con los de otras instancias del inventario.
  - Inventario de instancias (fichero local fuera del repositorio) sin secretos en claro: cliente,
    subdominio, `INSTANCE_ID`, versión de la imagen, workspace de Anthropic, dónde está guardada
    la `BACKUP_KEY`, fecha de alta y fecha y resultado de la última verificación de copia.
- **Fuera de alcance**: elegir proveedor de hosting o crear la infraestructura.
- **Texto para `/speckit-specify`**:
  > Herramientas de operación para dar de alta una instancia nueva del núcleo de forma segura:
  > generar un entorno completo con secretos únicos (incluida la clave de las copias de
  > seguridad), crear una base de datos con un usuario propio, validar el entorno antes de
  > desplegar detectando identificadores y secretos repetidos entre instancias, y llevar un
  > inventario de instancias sin secretos en claro. Ámbito: núcleo.

### P2. Exportar e importar la configuración del negocio

- **Ámbito**: núcleo.
- **Problema**: la configuración solo se puede preparar en el panel de producción. No hay forma de
  prepararla en una instancia de pruebas, revisarla y llevarla a producción, ni de guardar una
  copia legible de la configuración. La restauración de la 006 (`db:restore --from-instance`) no
  sirve para esto: mueve la BD entera, conversaciones incluidas, y está pensada para recuperar la
  misma instancia o comprobar copias.
- **Alcance**:
  - Exportar desde el panel un fichero JSON versionado con la configuración del negocio (datos,
    horarios, servicios, precios, FAQ, configuración del chat web). **Sin** conversaciones ni
    datos de clientes finales.
  - Los destinos de avisos de derivación (005) se exportan solo si el operador lo marca, porque
    importarlos en una instancia de pruebas la haría escribir al negocio real.
  - Importarlo en otra instancia: validación con los esquemas Zod del dominio, vista previa de
    cambios, aplicación en una transacción que respeta FR-032 (si el negocio queda activo con un
    aviso crítico, se revierte).
  - La importación nunca activa el negocio ni los canales por sí sola.
- **Fuera de alcance**: sincronización automática entre instancias; plantillas por sector dentro
  de `src/` (seguirían en `tests/fixtures/` o fuera del repositorio).
- **Texto para `/speckit-specify`**:
  > El operador puede exportar la configuración del negocio de una instancia a un fichero y
  > importarla en otra, con validación, vista previa de cambios y aplicación transaccional que
  > respeta los avisos críticos. No incluye conversaciones ni datos de clientes finales, los
  > destinos de avisos solo se incluyen si el operador lo pide y la importación nunca activa el
  > negocio ni los canales. Ámbito: núcleo.

### P6. Versión visible y actualización escalonada

- **Ámbito**: núcleo (operación).
- **Problema**: con varias instancias no es fácil saber qué versión corre cada una ni comprobar
  que una actualización ha ido bien.
- **Ya cubierto por la 006**: la copia previa a cada migración (sin ella no migra ni arranca) y
  la norma de migraciones de solo añadir, con los ficheros publicados intocables
  ([sección 5](#5-actualizar-el-núcleo)).
- **Alcance pendiente**:
  - Versión del núcleo y versión del esquema de BD visibles en el panel y en un endpoint de salud
    (`/health`) sin datos sensibles (hoy no existe).
  - Comando que consulta el `/health` de las instancias del inventario de P1 y muestra qué versión
    corre cada una.
  - Guía de publicación que convierta la [sección 5](#5-actualizar-el-núcleo) en un procedimiento
    con comprobaciones: etiquetado semántico, instancia de pruebas, tandas, comprobación tras
    actualizar cada instancia y vuelta atrás con la copia `premigration`.
- **Texto para `/speckit-specify`**:
  > Exponer la versión del núcleo y del esquema de base de datos en el panel y en un endpoint de
  > salud sin datos sensibles, consultar desde el inventario qué versión corre cada instancia y
  > definir el procedimiento de publicación escalonada con instancia de pruebas, comprobación
  > tras cada actualización y vuelta atrás con la copia previa a la migración. Ámbito: núcleo.

### P4. Consumo y coste por instancia

- **Ámbito**: núcleo.
- **Problema**: el panel muestra respuestas por día y mes del chat web, pero no los tokens
  consumidos ni el gasto estimado, y WhatsApp no tiene un tope de gasto equivalente.
- **Alcance**:
  - Registrar por respuesta los tokens de entrada y salida y el modelo usado, **sin** guardar
    textos, en todos los canales (WhatsApp, chat web y "Probar el bot", este último aparte).
  - Vista en el panel con el consumo del día y del mes por canal y el coste estimado con precios
    configurables.
  - Tope mensual de gasto por instancia, común a todos los canales, que al alcanzarse hace que el
    bot responda con el contacto del negocio (Principio V: siempre hay salida a una persona). Las
    conversaciones derivadas (005) siguen funcionando.
- **Texto para `/speckit-specify`**:
  > Medir y mostrar en el panel el consumo del modelo por instancia y canal (tokens y coste
  > estimado, sin guardar textos) y permitir un tope mensual de gasto que, al alcanzarse, hace que
  > el bot dé el contacto del negocio en todos los canales. Ámbito: núcleo.

### P5. Puntos de extensión del núcleo

- **Ámbito**: núcleo.
- **Problema**: el Principio III exige que las personalizaciones sean extensiones conectadas a
  puntos genéricos, pero esos puntos aún no existen.
- **Cuándo**: **no** adelantarla. Esperar a la primera petición real que no quepa en la
  configuración y diseñar solo el punto que esa petición necesita.
- **Alcance esperado**:
  - Mecanismo de carga de extensiones por instancia (activadas por configuración de entorno),
    sin que la imagen común cambie de comportamiento si no hay extensiones.
  - Contrato de cada punto de extensión con tipos y tests; las extensiones no pueden saltarse la
    verificación de datos (Principio IV) ni bloquear la derivación a una persona (Principio V).
  - Test que compruebe que retirar una extensión deja la instancia con el comportamiento del
    núcleo.
- **Texto para `/speckit-specify`** (adaptar al caso real):
  > Añadir al núcleo un punto de extensión genérico para <necesidad descrita sin nombrar al
  > cliente>, con un contrato tipado, carga opcional por instancia y garantía de que ninguna
  > extensión puede saltarse la verificación de datos ni la salida a una persona. Ámbito: núcleo.

---

## 10. Resumen de reglas

1. Una imagen para todos; un entorno y una BD por cliente.
2. Secretos, credenciales y clave de Anthropic nuevos para cada cliente, nunca copiados.
3. La información del negocio se registra en el panel de su instancia; el cliente no la edita.
4. Nada específico de un cliente o sector en `src/`.
5. Antes de actualizar: tests, evaluación e instancia de pruebas; la copia previa la hace la
   instancia y, sin ella, no migra. Migraciones de solo añadir; las publicadas no se editan.
6. Cada instancia con su `INSTANCE_ID`, su `BACKUP_KEY` (guardada fuera de las copias) y un
   volumen persistente para `BACKUP_DIR`; una copia se comprueba restaurándola, cada mes.
7. Lo que no cabe en la configuración se resuelve con una spec, primero de núcleo si es genérico y
   de extensión solo si es realmente particular.
