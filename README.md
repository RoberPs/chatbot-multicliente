# Estado del producto

Estados: especificada → planificada → en implementación → completada (o abandonada / sustituida).

| Nº  | Feature                         | Ámbito | Estado      | Rama                         | Spec                                            | Actualizado |
|-----|---------------------------------|--------|-------------|------------------------------|-------------------------------------------------|-------------|
| 001 | Base de conocimiento del negocio | Núcleo | Completada | `001-business-knowledge-base` | [spec](specs/001-business-knowledge-base/spec.md) | 2026-09-30  |
| 002 | Atención de dudas y precios por WhatsApp | Núcleo | Completada (evaluación de audios aplazada, T083) | `002-whatsapp-faq-bot` | [spec](specs/002-whatsapp-faq-bot/spec.md) · [plan](specs/002-whatsapp-faq-bot/plan.md) · [tareas](specs/002-whatsapp-faq-bot/tasks.md) | 2026-09-30  |
| 003 | Claridad del panel del operador y enlace a mapa | Núcleo | Completada | `004-web-channel` | [spec](specs/003-admin-panel-clarity/spec.md) · [plan](specs/003-admin-panel-clarity/plan.md) · [tareas](specs/003-admin-panel-clarity/tasks.md) | 2026-09-30  |
| 004 | Canal web del bot de atención | Núcleo | Completada | `004-web-channel` | [spec](specs/004-web-channel/spec.md) · [plan](specs/004-web-channel/plan.md) · [tareas](specs/004-web-channel/tasks.md) | 2026-09-28  |
| 005 | Derivación de la conversación al negocio | Núcleo | Completada | `005-handoff-to-business` | [spec](specs/005-handoff-to-business/spec.md) · [plan](specs/005-handoff-to-business/plan.md) · [tareas](specs/005-handoff-to-business/tasks.md) | 2026-09-30  |
| 006 | Copias de seguridad y restauración por instancia | Núcleo | Completada | `006-instance-backup-restore` | [spec](specs/006-instance-backup-restore/spec.md) · [plan](specs/006-instance-backup-restore/plan.md) · [tareas](specs/006-instance-backup-restore/tasks.md) | 2026-09-29  |
| 007 | Aprovisionamiento de instancias | Núcleo (operación) | Completada | `007-instance-provisioning` | [spec](specs/007-instance-provisioning/spec.md) · [plan](specs/007-instance-provisioning/plan.md) · [tareas](specs/007-instance-provisioning/tasks.md) | 2026-09-30  |
| 008 | Exportar e importar la configuración del negocio | Núcleo | Completada | `008-config-export-import` | [spec](specs/008-config-export-import/spec.md) · [plan](specs/008-config-export-import/plan.md) · [tareas](specs/008-config-export-import/tasks.md) | 2026-10-01  |
| 009 | Versión visible y actualización escalonada | Núcleo (operación) | Completada | `009-version-health-rollout` | [spec](specs/009-version-health-rollout/spec.md) · [plan](specs/009-version-health-rollout/plan.md) · [tareas](specs/009-version-health-rollout/tasks.md) | 2026-10-01  |
| 010 | Consumo y coste por instancia | Núcleo | Completada | `010-usage-cost-cap` | [spec](specs/010-usage-cost-cap/spec.md) · [plan](specs/010-usage-cost-cap/plan.md) · [tareas](specs/010-usage-cost-cap/tasks.md) | 2026-10-01  |
| 011 | Diseño del chat web | Núcleo | Completada | `011-chat-design` | [spec](specs/011-chat-design/spec.md) · [plan](specs/011-chat-design/plan.md) · [tareas](specs/011-chat-design/tasks.md) | 2026-10-05  |
| 012 | Protección frente a abuso y saturación | Núcleo | Completada | `012-abuse-protection` | [spec](specs/012-abuse-protection/spec.md) · [plan](specs/012-abuse-protection/plan.md) · [tareas](specs/012-abuse-protection/tasks.md) | 2026-10-06  |
| 013 | Requisitos de despliegue seguro | Núcleo (operación) | Completada | `013-secure-deployment` | [spec](specs/013-secure-deployment/spec.md) · [plan](specs/013-secure-deployment/plan.md) · [tareas](specs/013-secure-deployment/tasks.md) | 2026-10-06  |
| 014 | Modo oscuro del panel del operador | Núcleo | Completada | `014-dark-mode-panel` | [spec](specs/014-dark-mode-panel/spec.md) · [plan](specs/014-dark-mode-panel/plan.md) · [tareas](specs/014-dark-mode-panel/tasks.md) | 2026-10-13  |
| 016 | Resistencia a los cortes de la base de datos y verificación de copias por socket | Núcleo (corrección) | Completada | `016-db-outage-resilience` | [spec](specs/016-db-outage-resilience/spec.md) · [plan](specs/016-db-outage-resilience/plan.md) · [tareas](specs/016-db-outage-resilience/tasks.md) | 2026-10-09  |
| 017 | Proveedor del modelo configurable por instancia | Núcleo | Completada (solo `anthropic` declarado apto; ver abajo) | `017-proveedor-modelo-configurable` | [spec](specs/017-proveedor-modelo-configurable/spec.md) · [plan](specs/017-proveedor-modelo-configurable/plan.md) · [tareas](specs/017-proveedor-modelo-configurable/tasks.md) | 2026-10-14  |
| 018 | Icono del botón a tamaño completo y datos que el bot no ha guardado | Núcleo | Completada | `018-icono-boton-completo` | [spec](specs/018-icono-boton-completo/spec.md) · [plan](specs/018-icono-boton-completo/plan.md) · [tareas](specs/018-icono-boton-completo/tasks.md) | 2026-10-30  |

## Estado del despliegue

En producción desde el 2026-10-08. **Versión 0.1.4** en tres instancias sobre un VPS propio
(Ubuntu 24.04, Docker, PostgreSQL 16 por socket Unix, Caddy tras Cloudflare), cada una con su
base de datos y sus secretos.

Las **fases 0 a 10** del [plan de despliegue](docs/plan-despliegue-produccion.md) están hechas:
servidor, bases de datos, red y HTTPS, correo, pruebas de punta a punta y copias fuera del
servidor.

---

# Núcleo del chatbot: base de conocimiento, panel del operador y bot de atención

Cada cliente tiene su propia instancia (contenedor + base de datos PostgreSQL) construida a
partir de este núcleo y de su configuración. El operador registra la información del negocio
en un panel web (feature 001) y el bot atiende las dudas de horario, ubicación, servicios,
precios y preguntas frecuentes (feature 002) por tres canales con la **misma** cadena de
respuesta (feature 004):

- **WhatsApp**, con la Cloud API de Meta (opcional).
- **Chat web** incrustable en la web del negocio, para visitantes anónimos.
- **"Probar el bot"** en el panel, para que el operador vea lo que vería un cliente.

El bot lee `KnowledgeReader.getSnapshot()` de la base de datos en cada respuesta, sin caché; el
modelo (Claude) solo redacta, y el código calcula horarios, verifica las cifras y añade el
contacto del negocio cuando hace falta. Lo único que cambia entre canales es una tabla de
políticas (entrega, ventana de respuesta, negocio activo, chat activado y topes de uso).

Cuando el bot no puede resolver algo, el cliente pide hablar con una persona o escribe una queja,
la conversación se **deriva** al negocio (feature 005): el bot calla, el negocio recibe un aviso
por WhatsApp y/o email y la conversación vuelve sola al bot cuando el negocio confirma, termina o
pasan 24 h sin actividad.

Cada instancia hace **copias de seguridad cifradas** de su base de datos (feature 006): una al día
a la hora local configurada, una antes de aplicar migraciones (sin ella no migra ni arranca) y las
que pida el operador. Se restauran y se comprueban con los mismos comandos en todas las
instancias.

Las instancias se dan de alta con las **herramientas de aprovisionamiento** (feature 007), que el
operador ejecuta en su equipo: generan el entorno con secretos nuevos, crean la base de datos con
un usuario propio, validan el entorno antes de desplegar comparándolo con el resto de instancias y
llevan un inventario sin secretos en claro. No intervienen en el arranque de una instancia.

Cada instancia **declara su versión** (feature 009): `GET /health` responde su estado y, con su
secreto de salud, la versión del núcleo y del esquema; el panel la muestra al pie de cada pantalla;
`pnpm instance:versions` la consulta en todo el parque, y la guía de operación describe la
publicación por tandas con comprobación y vuelta atrás.

Una instancia ya arrancada **sobrevive a un corte de su base de datos** (feature 016): no se
reinicia, sigue respondiendo al cliente final con el teléfono de emergencia por el chat web y por
WhatsApp, informa de su estado con `db_unavailable` y **200** —que no es motivo de reinicio— y se
recupera sola cuando la base vuelve, sin intervención y sin perder las sesiones del panel. El
registro deja una anotación al empezar el corte y otra al recuperarse, no una por petición.

El panel del operador tiene **modo oscuro** (feature 014): sigue la preferencia de color del
sistema y, además, ofrece un control de tres opciones —Automático, Claro, Oscuro— en la barra
superior y en la pantalla de acceso. La elección se recuerda en una cookie de ese navegador, así
que es de cada persona: no es configuración del negocio, no viaja en el fichero de configuración
ni en las copias, y no cambia el esquema. El modo claro queda exactamente como antes y el chat web
que ven los clientes finales no cambia nada.

Cada instancia **mide el consumo del modelo** (feature 010): tokens por respuesta y por resumen de
derivación, por canal y sin guardar textos ni datos del cliente. El panel muestra el consumo y el
coste estimado con los precios que configura el operador, y un **tope mensual de gasto** opcional
hace que, al alcanzarse, el bot responda en WhatsApp y en el chat web solo con el contacto del
negocio, sin dejar de derivar a una persona.

Cada instancia **elige su proveedor de modelo** (feature 017): `anthropic`, `gemini` u `openai`,
declarado en su fichero de entorno con la credencial de ese proveedor y nada más. No hay una imagen
distinta por proveedor, y el panel, los canales y la conversación no saben quién hay detrás: lo que
varía entre los tres está escrito en una tabla de capacidades que una prueba mantiene pegada al
código. Sin `LLM_PROVIDER` la instancia es de Anthropic, así que los entornos ya desplegados no se
tocan.

La misma feature cierra un fallo que estaba abierto: una credencial que no corresponde al proveedor
declarado **ya no pasa** la comprobación previa, y si el proveedor la rechaza al arrancar, la
instancia **arranca degradada** —los clientes reciben solo el contacto del negocio—, avisa al
operador en crítico, reintenta cada 5 minutos y sale del degradado sola. Nunca es fatal: un proceso
muerto no deja salida a una persona. Y el consumo deja de dar por cero lo que el modelo no informa:
el panel distingue «sin dato» de `0` y dice cuántas respuestas no se pudieron medir.

**Qué proveedor está declarado apto, que no es lo mismo que implementado**:

| Proveedor | Estado |
|---|---|
| `anthropic` | **En producción.** Es el de las dos instancias desplegadas |
| `gemini` | Implementado, **conexión verificada** contra su API real (2026-10-14, `gemini-3.5-flash-lite`). **No declarado apto**: en el nivel gratuito los modelos `flash` grandes devuelven 503 por demanda y el `-lite` no alcanza el criterio de calidad |
| `openai` | Implementado y probado con dobles, **sin llamar a su API real** |

Gemini y OpenAI se evalúan **cuando un cliente quiera usarlos**, igual que ya se hace con el canal
de WhatsApp y con los audios: la evaluación con el modelo real cuesta dinero y su resultado caduca
con cada cambio en los adaptadores. Mientras nadie los declare en su entorno, ninguna instancia los
usa. El procedimiento está en
[docs/operacion-multicliente.md](docs/operacion-multicliente.md) §4.3.

El operador **personaliza el aspecto del chat web** (feature 011): colores, forma, posición,
tamaño, nombre, bienvenida, textos e imágenes, con vista previa en vivo. Se aplica en la
siguiente carga del chat sin tocar el fragmento pegado en la web, nunca deja el texto ilegible y
siempre conserva el aviso de asistente automático, el enlace de privacidad y la salida a una
persona.

## Requisitos

- Node.js 22 o superior y pnpm 9 (`corepack enable`)
- Docker (PostgreSQL local y tests de integración con Testcontainers)

## Puesta en marcha en local

```bash
pnpm install
docker compose up -d db                     # PostgreSQL 16; si el 5432 está ocupado: DB_PORT=55442 docker compose up -d db
cp .env.example .env                        # ajusta DATABASE_URL y pon SESSION_SECRET (openssl rand -hex 32)
pnpm operator:hash-password                 # pega el resultado en OPERATOR_PASSWORD_HASH
pnpm db:migrate                             # tablas + negocio vacío en "En preparación"
pnpm dev                                    # panel en http://localhost:3000/admin
pnpm kb:snapshot                            # lo que recibiría el bot ahora mismo, en JSON
```

Con la credencial del proveedor declarado y `EMERGENCY_CONTACT_PHONE` en `.env` ya hay bot, sin necesidad de
WhatsApp. Se puede probar de dos maneras:

- **Desde el panel**: `http://localhost:3000/admin/playground` ("Probar el bot" en la
  navegación). Cada respuesta muestra debajo su información técnica: si lleva saludo, si es una
  plantilla, por qué se añadió el contacto, cuántos borradores rechazó el verificador y cuánto
  tardó. Funciona también con el negocio "En preparación".
- **Desde la terminal**:

  ```bash
  pnpm bot:chat                               # conversación en la terminal; --as <número>, --verbose
  pnpm bot:chat --flood 35                    # envía 35 mensajes seguidos (límite por número)
  ```

Las guías de validación, con los escenarios manuales, están en
[specs/001-business-knowledge-base/quickstart.md](specs/001-business-knowledge-base/quickstart.md),
[specs/002-whatsapp-faq-bot/quickstart.md](specs/002-whatsapp-faq-bot/quickstart.md),
[specs/003-admin-panel-clarity/quickstart.md](specs/003-admin-panel-clarity/quickstart.md),
[specs/004-web-channel/quickstart.md](specs/004-web-channel/quickstart.md),
[specs/005-handoff-to-business/quickstart.md](specs/005-handoff-to-business/quickstart.md) y
[specs/006-instance-backup-restore/quickstart.md](specs/006-instance-backup-restore/quickstart.md).

## Chat web en la web del negocio

El chat público está **desactivado** en cada instancia hasta que el operador lo activa. En
`http://localhost:3000/admin/web-chat`:

1. Indica las **webs donde se mostrará** (una por línea, máximo 10): solo el esquema y el
   dominio, sin ruta, y con `https` salvo `localhost` y `127.0.0.1` para pruebas.
2. Indica el **enlace a la política de privacidad** del negocio; el chat lo muestra antes del
   primer mensaje, junto al aviso de que atiende un asistente automático y de que los mensajes
   se borran a los 30 días.
3. Ajusta los **topes** de respuestas al día y al mes (200 y 3 000 por defecto). Al alcanzar uno
   el chat deja de responder y da el contacto del negocio hasta el día o el mes siguiente; el
   panel lo avisa y muestra el uso del día y del mes.
4. Marca **"Activar el chat en estas webs"** y guarda. Sin webs permitidas o sin enlace de
   privacidad no se puede activar.
5. Copia el **fragmento** y pégalo una vez en la web del negocio, antes de `</body>`:

   ```html
   <script src="https://tu-instancia.example/chat/widget.js" defer></script>
   ```

   La URL sale de `PUBLIC_BASE_URL` si está definida y, si no, del origen con el que estés
   usando el panel. El fragmento no hay que cambiarlo al activar o desactivar el chat.

El fragmento solo añade un iframe servido por la instancia; el navegador impide incrustarlo en
webs que no estén en la lista (`frame-ancestors`). Desactivar el chat tiene efecto en la
siguiente petición: los visitantes pasan a ver "no disponible" con el contacto del negocio.

## Diseño del chat

La sección **Diseño del chat** del panel (`/admin/chat-design`, feature 011) cambia el aspecto del
chat web de la instancia. Sin diseño guardado, el chat se ve exactamente como siempre.

- **Colores**: principal, texto sobre el principal, fondo, texto y fondo de los mensajes del bot.
  Cada pareja de colores necesita un contraste de 4,5:1; el panel lo avisa mientras se edita y no
  deja guardar un diseño ilegible (tampoco sin JavaScript).
- **Forma** (recta, suave, redondeada), **posición** (abajo a la derecha o a la izquierda) y
  **tamaño** del chat abierto (pequeño, mediano, grande; en móvil nunca sale de la pantalla).
- **Textos**: nombre del chat, bienvenida, texto de ayuda del campo y botón Enviar. Se muestran
  tal cual y el asistente no los usa para responder.
- **Imágenes**: logo, avatar e icono del botón. PNG, JPEG o WebP de hasta 256 KB y 16–1024 px; se
  validan por su contenido y se guardan sin metadatos (ubicación, cámara) en la BD de la instancia.
- **Vista previa** con una conversación de ejemplo: los cambios se ven antes de guardar, sin
  crear conversaciones ni contar para los topes.
- **Restaurar el aspecto original** borra el diseño y sus imágenes, con confirmación.

Lo guardado se aplica en la siguiente carga del chat (el frame no se guarda en caché), sin cambiar
la activación ni la configuración del chat web. El diseño viaja en la exportación de la
configuración y entra en las copias de seguridad. Comprobación de punta a punta:
[specs/011-chat-design/quickstart.md](specs/011-chat-design/quickstart.md).

## Derivación al negocio

En `http://localhost:3000/admin/handoffs` se configuran los destinos de los avisos: un WhatsApp,
un email o ambos. Sin ninguno configurado el bot sigue dando el contacto de derivación de la
002 y el panel muestra el aviso normal `HANDOFF_ALERTS_NONE`, que no bloquea la activación del
negocio; con uno solo, el aviso `HANDOFF_ALERTS_SINGLE` recuerda que solo llegan por esa vía.

- La vía **WhatsApp** necesita el canal de WhatsApp ya configurado y las tres plantillas de
  utilidad aprobadas por Meta (aviso, recordatorio y reenvío de mensajes): `pnpm handoff:templates`
  imprime su definición para darlas de alta. **Meta cobra por plantilla de utilidad enviada**;
  cada derivación, reenvío y recordatorio consume una.
- La vía **email** necesita `SMTP_URL`, `SMTP_FROM` y `PUBLIC_BASE_URL` (los enlaces "Le atiendo"
  y "Terminado" del correo apuntan a esta instancia). Para probarla en local sirve un SMTP de
  pruebas como [Mailpit](https://github.com/axllent/mailpit)
  (`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`, panel en `http://localhost:8025`).

Mientras una conversación está derivada el bot no contesta: los mensajes del cliente se agrupan y
se reenvían al negocio, y el chat web muestra una franja fija en su lugar. El negocio confirma
("Le atiendo") o termina ("Terminado") con los botones de WhatsApp o los enlaces del email; el
operador también puede terminarla desde el panel o desde "Probar el bot". Sin confirmar, a las
24 h sin mensajes del cliente la conversación vuelve sola al bot; si el negocio no confirma en
2 horas de horario, recibe un recordatorio único y el cliente, el contacto directo. Si el aviso
no llega por ninguna vía, la conversación no se deriva: el bot dice que no ha podido avisar al
negocio y da el contacto de derivación, sin prometer que le contactarán. La guía de
validación manual está en
[specs/005-handoff-to-business/quickstart.md](specs/005-handoff-to-business/quickstart.md).

## Consumo y tope de gasto

La página **Consumo** del panel (`/admin/usage`, feature 010) muestra los tokens y el coste
estimado del modelo:

- **Hoy** y **Este mes** (días y meses locales del negocio), por canal —WhatsApp, Chat web y
  "Probar el bot"— con los totales de **Clientes finales** (WhatsApp + web) e **Instancia**.
  Meses anteriores por canal y por día: se conservan el mes en curso y los 12 anteriores.
- **Precios por modelo**, por millón de tokens (entrada, salida, escritura y lectura de caché), en
  la **moneda de coste** de la instancia (USD por defecto; para cambiarla hay que borrar antes los
  precios). El coste queda fijado al registrar: cambiar un precio no cambia lo ya registrado, y lo
  consumido sin precio se muestra «sin precio», nunca a cero. Es una estimación, no la factura del
  proveedor.
- **Tope mensual**, común a todos los canales (incluye "Probar el bot" y los resúmenes de
  derivación). Para activarlo, el modelo de `LLM_MODEL` tiene que tener precio. Al 80 % todas las
  pantallas del panel avisan; al 100 %, WhatsApp responde con el contacto del negocio sin llamar al
  modelo (una petición de persona se sigue derivando, con el resumen literal) y el chat web pasa a
  "no disponible". "Probar el bot" sigue funcionando. Se reanuda solo al subir o desactivar el tope o
  al empezar el mes local.

El estado del tope (`none`, `normal`, `warning`, `reached`) sale también en `GET /health` con
credencial y en la columna **Tope** de `pnpm instance:versions`, sin importes. Los precios, la moneda
y el tope no viajan en la exportación de la configuración; el consumo sí entra en las copias de
seguridad. Guía de validación manual:
[specs/010-usage-cost-cap/quickstart.md](specs/010-usage-cost-cap/quickstart.md).

## Protección frente a abuso y saturación

Desde la feature 012, una instancia aguanta el abuso desde Internet sin credenciales:

- **Tope de gasto obligatorio en producción**: con `NODE_ENV=production`, sin tope activo, sin
  precio para `LLM_MODEL` (o, con audios, para `STT_MODEL` en «Precios de transcripción»), o con el
  gasto ilegible, los clientes reciben solo el contacto del negocio, el negocio no se puede activar
  y todas las pantallas lo avisan. Los audios se comprueban contra el tope antes de descargarse y
  suman al gasto. WhatsApp tiene además un **tope diario** de respuestas con modelo (200 por
  defecto). `GET /health` da `spendCap: "blocked"` en esos casos.
- **Derivaciones acotadas** («Consumo» → «Límites de derivación»): derivaciones nuevas al día,
  minutos entre avisos de una derivación (los mensajes del cliente se reenvían agrupados) y avisos
  al negocio al día. En los avisos, el texto del cliente va entre comillas y con las direcciones
  desactivadas. Lo que se queda sin reenviar al terminar una derivación aparece como «retenido».
- **Rutas públicas**: límites por dirección (las IPv6 por su /64) en el frame, la hoja y las
  imágenes del diseño antes de tocar la base de datos, y las lecturas del chat web en un pool de
  conexiones propio y pequeño: una avalancha no deja sin servicio al panel ni a WhatsApp.
- **Login del operador**: los fallos ajenos solo añaden un retardo creciente (nunca un bloqueo
  global); el navegador desde el que ya entró el operador lo evita.
- **Proveedores lentos**: plazos en todas las llamadas a la Graph API y al SMTP; un lote que falla
  se reintenta a los 5 s, 30 s, 2 min y 10 min y al quinto fallo el cliente recibe una disculpa con
  el contacto; ningún aviso ni respuesta se envía dos veces.
- **Importación** con máximos por lista y como mucho 50 errores en pantalla; **enlaces**: el bot solo
  pinta como enlace lo que el verificador ha comprobado; **registros** sin datos de errores ni
  valores de la consulta; y la instancia **no arranca en producción** con secretos cortos, de
  ejemplo, triviales o repetidos, ni sin `HEALTH_SECRET` (las mismas reglas que
  `pnpm instance:check`).

Guía de validación: [specs/012-abuse-protection/quickstart.md](specs/012-abuse-protection/quickstart.md).

## Despliegue seguro

Desde la feature 013, el despliegue seguro se comprueba en lugar de depender de la memoria del
operador:

- **`pnpm instance:check`** da NO APTO en producción con `TRUST_PROXY` vacío y `PUBLIC_BASE_URL` en
  `https` (`trust_proxy_empty`) y con cualquier URL de base de datos remota (`DATABASE_URL`,
  `BACKUP_VERIFY_URL`, `INSTANCE_DB_ADMIN_URL`) sin `sslmode=verify-full` en la propia URL
  (`database_tls_required`), o con `verify-full` pero el servidor por IP en lugar de por el nombre
  de su certificado (`database_tls_ip_host`). En una instancia de pruebas son advertencias.
- **`pnpm instance:db`** se niega a conectar con un servidor remoto sin TLS verificado; acepta
  `--sslrootcert <ruta del contenedor>` y pone `verify-full` por defecto con `--print-sql --host`
  remoto. `instance:new` escribe `TRUST_PROXY=1`.
- **TLS hacia PostgreSQL** con `sslmode=verify-full` (y `sslrootcert` si la autoridad no es
  pública) en todas las conexiones; un certificado ilegible o que no vale se explica sin mostrar la
  URL, el host ni la ruta. Usa en la URL el nombre del certificado, nunca una IP.
- **`pnpm db:verify`**: las bases temporales no admiten conexiones de otros usuarios y cada
  verificación limpia antes las huérfanas de más de 6 h (informa cuántas, sin nombres).
- **Imagen**: `HEALTHCHECK` sobre la vista pública de `/health`, base `node:22-slim` fijada por
  digest, pnpm con hash, `save-exact` y scripts de instalación solo para `argon2` y `esbuild`;
  `.gitignore` excluye `*.pem`, `*.key` y `*.p12`.
- **Receta de producción** paso a paso, cada uno con su comprobación: §2.5 de
  [docs/operacion-multicliente.md](docs/operacion-multicliente.md#25-despliegue).

Guía de validación: [specs/013-secure-deployment/quickstart.md](specs/013-secure-deployment/quickstart.md).

## Exportar e importar la configuración

La página **Exportar e importar** del panel (`/admin/config`, feature 008) lleva la configuración del
negocio de una instancia a otra (por ejemplo, de pruebas a producción):

- **Exportar**: descarga un JSON versionado (formato 2 desde la feature 011) con datos del
  negocio, horarios, servicios, recursos, preguntas, políticas, tono, derivación, chat web y diseño
  del chat (con sus imágenes en base64). Nunca incluye conversaciones, clientes ni
  secretos; los destinos de avisos solo van si se marca la casilla.
- **Importar**: valida el fichero (se rechaza entero, con la lista de errores, si algo falla), muestra
  una vista previa por sección y se aplica al confirmar, en una transacción. No cambia el estado del
  negocio ni activa el chat web, y respeta los avisos críticos. Los ficheros del formato 1 se siguen
  importando: como no traen diseño, el destino vuelve al aspecto original del chat.
- **Deshacer**: se guarda la configuración anterior a la última importación, descargable desde la
  misma página y entra en las copias de seguridad.

Guía de uso: [docs/operacion-multicliente.md](docs/operacion-multicliente.md#26-configuración-del-negocio-en-el-panel-de-producción).

## Copias de seguridad

Con `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY` en `.env` (van las tres o ninguna; en `production`
son obligatorias):

```bash
pnpm db:backup                              # copia cifrada en BACKUP_DIR; aplica la retención
pnpm db:backups                             # lista las copias de la instancia (--prune: retención)
pnpm db:verify <fichero>                    # la restaura en una BD temporal, compara y la borra
pnpm db:restore <fichero>                   # con la instancia PARADA; pide escribir el INSTANCE_ID
```

- Cada copia es un único fichero `<instancia>__<esquema>__<fecha UTC>__<motivo>.cbak` (motivo
  `manual`, `daily` o `premigration`), cifrado con AES-256-GCM y una clave derivada de
  `BACKUP_KEY`. **Sin la clave no se puede restaurar**: guárdala fuera de `BACKUP_DIR`.
- La copia sale de un único instante y no pausa al bot. La restauración es todo o nada: rechaza
  sin tocar nada las copias dañadas, de otra clave (`BACKUP_KEYS_PREVIOUS` para las anteriores),
  de otra instancia (salvo `--from-instance <id>`) o de un núcleo más reciente.
- Al arrancar con migraciones pendientes y datos, la instancia hace una copia `premigration`; si
  no puede, no migra ni escucha (`migration_blocked`). Por eso las migraciones son de solo añadir
  y las ya publicadas no se editan.
- Las copias caducan a los `BACKUP_RETENTION_DAYS` días (7 por defecto, máximo 30); la última
  válida se conserva siempre. Los ficheros ajenos del directorio no se tocan.
- `db:verify` necesita un usuario con `CREATEDB` en el servidor de `BACKUP_VERIFY_URL`.

En producción las copias no se quedan en el servidor: `deploy/descargar-copias.ps1`, lanzado a
diario por el Programador de tareas de Windows, se las trae al PC del administrador y, si está
conectado, a un disco USB, de modo que viven en **tres sitios**. **Verifica cada fichero por
SHA-256** en los dos destinos y no borra nada en local, así que el histórico de aquí acaba siendo
más largo que el del VPS.

Guía del operador para comprobar las copias: [docs/operacion-multicliente.md §8](docs/operacion-multicliente.md#8-copias-de-seguridad-guía-de-validación),
y [cómo salen del servidor](docs/operacion-multicliente.md#sacar-las-copias-del-servidor).

## Alta de instancias

Se ejecutan en el equipo del operador, con este repositorio y sin cargar su `.env`. El inventario
vive fuera del repositorio (`INSTANCE_INVENTORY`, por defecto `~/.chatbotasesor/inventory.json`) y
su clave se da en `INSTANCE_INVENTORY_KEY` (se crea con el inventario y se muestra una vez):

```bash
pnpm instance:new --id <id> --client "<cliente>" --url https://… --timezone Europe/Madrid \
  --region ES --currency EUR --emergency-phone "+34 …" [--whatsapp]   # entorno + alta "en alta"
pnpm instance:db <id>                       # BD y usuario propios (INSTANCE_DB_ADMIN_URL o se pide)
pnpm instance:db <id> --print-sql --host <servidor> --port <puerto>  # solo el SQL, sin conectarse
pnpm instance:check <entorno> [--json]      # APTO / NO APTO antes de desplegar (0 / 1)
pnpm instance:list [--json]                 # instancias, estado, versión y verificaciones vencidas
pnpm instance:versions [--only <id>] [--json] [--annotate]  # versión real de cada instancia (0 / 1)
pnpm instance:health-secret <id> [--rotate] # secreto de salud de una instancia anterior a la 009
```

- `instance:new` parte de `.env.example`, genera `SESSION_SECRET`, `BACKUP_KEY`, `HEALTH_SECRET`, la contraseña del
  operador (se muestra **una sola vez**; el entorno solo lleva su hash) y el token del webhook, y
  deja marcados con `# PENDIENTE:` los valores de terceros. Nunca sobrescribe un fichero.
- `instance:db` crea `chatbot_<id>` con un usuario sin privilegios de administración, retira
  `CONNECT` a `PUBLIC` y escribe `DATABASE_URL`. La contraseña viaja como verificador SCRAM y las
  credenciales de administración no se guardan. Nunca reutiliza ni borra una base de datos.
- `instance:check` aplica las reglas del arranque y las del alta (production, `https`, calidad de
  cada secreto) y compara con todas las instancias del inventario, también las dadas de baja, por
  huellas HMAC: un identificador, una BD o un secreto repetidos son error. Nunca muestra un valor.
- Mantenimiento: `instance:register` (instancia anterior a la 007), `instance:sync` (tras rotar
  secretos), `instance:update`, `instance:verified <id> <informe de db:verify --json>` e
  `instance:retire` (solo el inventario; los pasos manuales se muestran al terminar).
- `instance:versions` consulta `GET /health` de cada instancia no retirada con el `HEALTH_SECRET`
  de su entorno (`<dir. del inventario>/envs/<id>.env`, solo en memoria), comprueba que responde
  la instancia esperada y compara con la versión anotada (`imageVersion`); la columna **Tope**
  (010) muestra el estado del tope de gasto, que no cuenta para el resultado. Solo `https`
  (`--allow-insecure` para `localhost`). No escribe nada salvo `--annotate`, que pide confirmación
  (`--yes` sin terminal). `instance:health-secret` escribe el secreto en el entorno sin mostrarlo.

Guía completa del alta y la baja: [docs/operacion-multicliente.md §2 y §7](docs/operacion-multicliente.md#2-alta-de-un-cliente-nuevo).
Contrato de las órdenes: [specs/007-instance-provisioning/contracts/instance-commands.md](specs/007-instance-provisioning/contracts/instance-commands.md).

## Variables de entorno

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `DATABASE_URL` | Sí | Base de datos propia de la instancia (una por cliente). Con un servidor remoto, `sslmode=verify-full` (y `sslrootcert` si la autoridad no es pública) |
| `OPERATOR_USER` | Sí | Usuario del operador |
| `OPERATOR_PASSWORD_HASH` | Sí | Hash Argon2id de la contraseña (`pnpm operator:hash-password`, mínimo 12 caracteres) |
| `SESSION_SECRET` | Sí | Clave de la cookie de sesión: 32 bytes aleatorios en hex (`openssl rand -hex 32`). Cambiarla cierra todas las sesiones |
| `DEFAULT_PHONE_REGION` | No (`ES`) | País para interpretar teléfonos escritos en formato nacional |
| `DEFAULT_TIMEZONE` | No (`Europe/Madrid`) | Zona horaria IANA inicial del negocio |
| `DEFAULT_CURRENCY` | No (`EUR`) | Moneda ISO 4217 inicial del negocio |
| `PORT` | No (`3000`) | Puerto HTTP |
| `NODE_ENV` | Sí | `development`, `test` o `production`. En `production` la cookie es `Secure`, se envía HSTS y las plantillas se cachean |
| `TRUST_PROXY` | Con `PUBLIC_BASE_URL` https (013) | Proxies delante del servicio: número de saltos (`1`) o IP/CIDR separadas por comas. Nunca `true` |
| `WHATSAPP_PHONE_NUMBER_ID` · `WHATSAPP_ACCESS_TOKEN` · `WHATSAPP_APP_SECRET` · `WHATSAPP_VERIFY_TOKEN` · `WHATSAPP_GRAPH_VERSION` | Las cinco o ninguna | Canal de WhatsApp Cloud API. Sin ellas la instancia arranca solo con el panel |
| `EMERGENCY_CONTACT_PHONE` | Con credencial del modelo | Teléfono E.164 que se da si no se puede leer la información del negocio (disculpa del bot y chat web "no disponible") |
| `LLM_PROVIDER` | No (`anthropic`) | Proveedor del modelo: `anthropic`, `gemini` u `openai` (017). Ausente equivale a `anthropic`, así que los entornos anteriores siguen funcionando sin cambios |
| `ANTHROPIC_API_KEY` · `GEMINI_API_KEY` · `OPENAI_API_KEY` | La del proveedor declarado, para tener bot | Credencial de su proveedor. **Solo se usa la del declarado en `LLM_PROVIDER`**: las otras nunca sirven de respaldo, y una credencial puesta en la variable de otro proveedor deja el entorno NO APTO en `pnpm instance:check`. Con la correcta ya hay bot: "Probar el bot" y chat web, aunque no haya WhatsApp. También la usan `pnpm bot:chat` y `pnpm test:eval` |
| `PUBLIC_BASE_URL` | No | URL pública de la instancia (`https`, sin ruta; `http` solo con `localhost` o `127.0.0.1`). Se usa para escribir el fragmento del chat web y para comprobar el origen de las peticiones del chat |
| `LLM_MODEL` | **Sí con `gemini` y `openai`**; no con `anthropic` (`claude-sonnet-5-5`) | Modelo que redacta las respuestas. Fuera de Anthropic no hay valor por defecto a propósito: sus catálogos se mueven rápido y un nombre retirado devuelve un 404 que se parece mucho a un proveedor caído |
| `LLM_EFFORT` | No (`medium`) | Esfuerzo del modelo: `low`, `medium` o `high`. No significa lo mismo en los tres proveedores: con `openai` depende del modelo, y si el modelo no lo admite la instancia lo deja dicho en el registro y sigue atendiendo sin él |
| `AUDIO_TRANSCRIPTION` | No (`off`) | Interruptor de audios. Con `off` un audio recibe el aviso de "solo texto" y no se descarga |
| `STT_API_KEY` | Con audios `on` | Clave del servicio de transcripción (API de OpenAI) |
| `STT_MODEL` | No (`whisper-1`) | Modelo de transcripción |
| `SMTP_URL` | Con `SMTP_FROM` | Servidor SMTP para los avisos de derivación: `smtps://usuario:clave@host:465` o `smtp://usuario:clave@host:587` (STARTTLS). Necesita además `PUBLIC_BASE_URL` |
| `SMTP_FROM` | Con `SMTP_URL` | Remitente de los avisos de derivación |
| `WHATSAPP_TEMPLATE_LANG` | No (`es`) | Idioma de las plantillas de WhatsApp de los avisos de derivación (`pnpm handoff:templates` imprime su definición) |
| `INSTANCE_ID` | En `production` | Identificador de la instancia (minúsculas, cifras y guiones; 1–40), distinto por cliente. Va dentro de cada copia |
| `BACKUP_DIR` | En `production` | Directorio absoluto de las copias: un volumen persistente escribible por la instancia |
| `BACKUP_KEY` | En `production` | Clave de las copias: 32 bytes aleatorios en hex (`openssl rand -hex 32`), distinta de `SESSION_SECRET`. Guárdala fuera de `BACKUP_DIR` |
| `BACKUP_KEYS_PREVIOUS` | No | Claves anteriores separadas por comas, solo para leer copias hechas antes de cambiar `BACKUP_KEY` |
| `BACKUP_RETENTION_DAYS` | No (`7`) | Días que se conservan las copias, de 1 a 30 |
| `BACKUP_DAILY_TIME` | No (`03:00`) | Hora local del negocio (`HH:MM`) de la copia diaria |
| `BACKUP_VERIFY_URL` | No (`DATABASE_URL`) | Servidor PostgreSQL donde `pnpm db:verify` crea la BD temporal (usuario con `CREATEDB`) |
| `HEALTH_SECRET` | En `production` (012); `instance:check` la exige | Secreto de salud: 32 bytes aleatorios en hex (`openssl rand -hex 32`), distinto de `SESSION_SECRET`, `BACKUP_KEY` y del de otras instancias. Enviado como `Authorization: Bearer`, `GET /health` añade la versión del núcleo y del esquema; sin él solo responde el estado |

## Comandos

| Comando | Qué hace |
|---------|----------|
| `pnpm dev` | Servidor con recarga; aplica migraciones al arrancar |
| `pnpm build` / `pnpm start` | Compila a `dist/` y arranca la versión compilada |
| `pnpm test` | Unitarios, contrato e integración (levanta PostgreSQL con Testcontainers) |
| `pnpm test:unit` · `test:contract` · `test:integration` | Cada suite por separado |
| `pnpm test <patrón>` | Solo los ficheros que coinciden, p. ej. `pnpm test sector-neutrality` |
| `pnpm test:eval` | Evaluación con el modelo real y los tres sectores de ejemplo (SC-001 a SC-010); tiene coste y no entra en `pnpm test`. Se parametriza con `LLM_PROVIDER` y `LLM_MODEL` para correrla por proveedor, y se omite —diciendo por qué— sin la credencial del proveedor declarado |
| `EVAL_CHANNEL=web pnpm test:eval` | La misma evaluación por el canal web, para comprobar que da los mismos resultados que por WhatsApp. SC-009 se omite: la web solo admite texto |
| `npx vitest run --project eval --reporter=verbose` | La evaluación mostrando las tablas de porcentajes de **todos** los criterios. Con `pnpm test:eval` a secas, el reporter por defecto de vitest descarta la salida de los ficheros que pasan y solo se ven los criterios que fallan |
| `pnpm test:eval audio` | Además, los audios con Whisper real (necesita `STT_API_KEY` y las grabaciones de `tests/fixtures/audio/`) |
| `pnpm bot:chat` | Conversación con el bot en la terminal, con el modelo real y sin WhatsApp |
| `pnpm lint` · `pnpm typecheck` · `pnpm format` | Calidad de código |
| `pnpm db:generate` | Genera una migración tras cambiar `src/db/schema.ts` |
| `pnpm db:migrate` | Aplica las migraciones a `DATABASE_URL`; con datos y migraciones pendientes hace antes una copia `premigration` (sin ella no migra) |
| `pnpm db:backup` | Copia cifrada de la instancia en `BACKUP_DIR` (`--json` para el inventario) |
| `pnpm db:restore <fichero>` | Restaura una copia con la instancia parada (`--from-instance <id>`, `--yes`, `--json`) |
| `pnpm db:verify <fichero>` | Restaura la copia en una BD temporal, compara los recuentos y la borra |
| `pnpm db:backups` | Lista las copias de la instancia; `--prune` aplica la retención |
| `pnpm instance:new` | Genera el entorno de una instancia nueva con secretos nuevos y la registra en el inventario (necesita terminal) |
| `pnpm instance:db <id>` | Crea la BD y el usuario propios de la instancia y escribe `DATABASE_URL` (`--print-sql` para solo el SQL) |
| `pnpm instance:check <entorno>` | Valida un entorno antes de desplegar y lo compara con el inventario (`--json`; 0 apto, 1 no apto) |
| `pnpm instance:list` | Inventario de instancias con estado, versión y verificaciones de copia vencidas (`--json`) |
| `pnpm instance:register` · `sync` · `update` · `verified` · `retire` | Mantenimiento del inventario (registrar una instancia existente, rotación, datos, verificación de copia, baja) |
| `pnpm instance:versions` | Versión del núcleo y del esquema que corre cada instancia del inventario, comparada con la anotada (`--only`, `--json`, `--annotate`; 0 todo correcto, 1 algo que revisar) |
| `pnpm instance:health-secret <id>` | Añade el secreto de salud al entorno de una instancia sin mostrarlo (`--rotate` para cambiarlo) |
| `pnpm kb:snapshot` | Imprime el `KnowledgeSnapshot` actual |
| `pnpm operator:hash-password` | Pide una contraseña sin mostrarla y devuelve su hash Argon2id |
| `pnpm handoff:templates` | Imprime la definición JSON de las tres plantillas de WhatsApp de los avisos de derivación, para darlas de alta en Meta |

## Despliegue

`Dockerfile` construye una imagen única del núcleo, igual para todos los clientes, con la versión
de `package.json` (`docker build --build-arg CORE_VERSION=X.Y.Z -t chatbot:X.Y.Z .`; con otra
versión la construcción falla; nunca `latest`). `GET /health` (sin sesión, 30 peticiones por
minuto e IP) responde `200 {"status":"ok"}` o `503` con `degraded`/`not_ready` para un monitor o
balanceador, y la versión solo con `HEALTH_SECRET`. Cada
instancia es un contenedor con sus variables de entorno, su base de datos y un **volumen
persistente para las copias** (la imagen declara `/var/lib/chatbot/backups`, escribible por el
usuario `node`); al arrancar aplica las migraciones pendientes, con copia previa si hay datos.
Desde la 013 la imagen trae un `HEALTHCHECK` (sana solo con `{"status":"ok"}`, 120 s de gracia) y
la receta de producción está en la §2.5 de la guía de operación.

> **Instancias existentes (desde la 006)**: en `production` una instancia **no arranca** sin
> `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY` y un volumen montado en `BACKUP_DIR`. Añádelos antes
> de actualizarla a esta versión.
 Dar de alta un negocio, cambiar sus datos o activar el chat web se
hace en el panel, sin desplegar. El webhook de WhatsApp escucha en `/webhooks/whatsapp`
(verificación con `WHATSAPP_VERIFY_TOKEN` y firma con `WHATSAPP_APP_SECRET`) y el chat web en
`/chat` (fragmento, iframe y su API JSON). Las conversaciones se borran a los 30 días y los
registros técnicos no guardan textos, números, tokens ni la IP de los visitantes.

Alta, aislamiento, actualización y baja de clientes, y specs de operación pendientes: [docs/operacion-multicliente.md](docs/operacion-multicliente.md).

## Estructura

```text
src/
├── config/        variables de la instancia (Zod)
├── db/            esquema Drizzle, migraciones, cliente y transacciones
├── knowledge/     dominio sin HTTP: esquemas, reglas temporales, avisos, snapshot, casos de uso
├── conversation/  dominio del bot sin HTTP: recepción, espera, respuesta, verificador, plantillas
├── handoff/       dominio de la derivación al negocio sin HTTP: decisión, avisos, horario, tokens
├── backup/        copias de la instancia sin HTTP: formato cifrado, volcado, restauración,
│                  comprobación, retención, copia diaria y bloqueos
├── channels/      adaptadores de canal: WhatsApp (webhook y Graph API), web (iframe y API JSON)
│                  los enlaces públicos de derivación (`/handoff/*`) y `GET /health`
├── health/        salud y versión sin HTTP: versión del núcleo, informe, secreto, ciclo de vida
├── webchat/       dominio del chat web sin HTTP: configuración, disponibilidad, topes, sesión
│                  y diseño (design/: colores, contraste, tema, imágenes)
├── usage/         consumo del modelo sin HTTP: registro, importes exactos, precios, resumen,
│                  tope mensual de gasto y retención
├── mail/          adaptador de email (avisos de derivación por SMTP)
├── llm/           adaptador de Claude, construcción del prompt y resumen de derivaciones
├── speech/        adaptador de transcripción (solo con audios activados)
├── admin/         panel del operador: sesión, rutas, plantillas Eta + htmx, probar el bot
├── provisioning/  herramientas de alta sin HTTP: plantilla de entorno, secretos, huellas,
│                  inventario, validación, creación de la BD y versiones del parque
├── cli/           kb:snapshot, operator:hash-password, bot:chat, handoff:templates,
│                  db:backup, db:restore, db:verify, db:backups e instance:*
├── bot.ts         composición del bot
├── app.ts         construcción de la app Fastify
├── startup.ts     arranque: bloqueo de instancia, migraciones con copia previa, purga y programador
└── server.ts      lee el entorno, llama a startInstance y atiende las señales
tests/             unit/, contract/, integration/, eval/, fixtures/ (los únicos con nombres de sector)
```
