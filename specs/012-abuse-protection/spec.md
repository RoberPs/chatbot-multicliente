# Feature Specification: Protección frente a abuso y saturación

**Feature Branch**: `012-abuse-protection`

**Created**: 2026-10-05

**Status**: Draft

**Ámbito**: Núcleo

**Input**: User description: "Proteger cada instancia frente al abuso y la saturación antes de publicarla: el tope de gasto pasa a ser obligatorio en producción y falla cerrado, cubre también la transcripción de audios y tiene tope diario en WhatsApp; los reenvíos de una derivación al negocio cuentan para los topes y tienen su propio límite; las rutas públicas del chat web tienen límite de peticiones; el bloqueo del login no impide entrar al operador con la credencial correcta; las llamadas salientes tienen plazo; los lotes que fallan se reintentan con espera; la importación de configuración limita su tamaño y su coste; el bot no muestra enlaces que no haya verificado; los registros no guardan datos de errores ni tokens; y la instancia no arranca en producción con secretos débiles o sin copias. Ámbito: núcleo (propuesta P8 de docs/operacion-multicliente.md)."

## Contexto

La auditoría completa del 2026-10-05 ([docs/operacion-multicliente.md, sección 11.6](../../docs/operacion-multicliente.md))
concluyó que la instancia **no es apta todavía para producción**. No hay fallos que den acceso a
datos o al panel, pero un anónimo desde Internet puede:

- hacer gastar dinero al negocio: el tope de gasto (feature 010) está desactivado por defecto, no
  cubre la transcripción de audios y WhatsApp no tiene tope diario de respuestas;
- convertir una derivación (feature 005) en un canal de mensajes de pago sin límite hacia el
  negocio, con su propio texto dentro;
- dejar la instancia sin servicio saturando las rutas públicas del chat web o haciendo esperar sin
  fin las llamadas al proveedor de mensajería;
- dejar al operador fuera del panel justo cuando lo necesita para cortar el abuso, porque el límite
  global de fallos del login bloquea también la credencial correcta.

Además hay fallos menores que se corrigen aquí porque comparten causa: la importación de
configuración tiene coste cuadrático, el bot puede mostrar enlaces que el verificador no ha visto,
los registros guardan errores completos y el token de verificación del webhook, y la instancia
arranca en producción con secretos débiles.

Es la propuesta P8. La P9 (requisitos de despliegue seguro: proxy, TLS hacia la base de datos,
imagen y receta de producción) es una feature aparte.

**Producción** en esta spec es una instancia que se ejecuta con el entorno marcado como producción.
Fuera de producción (desarrollo, pruebas) los requisitos marcados «en producción» no se exigen,
para no entorpecer el trabajo en local.

## Clarifications

### Session 2026-10-05

- Q: Cuando una instancia de producción no tiene tope de gasto activo (o su modelo no tiene precio),
  ¿qué debe pasar? → A: Arranca; es un aviso crítico que impide activar el negocio, y si el negocio
  ya estaba activo los clientes finales reciben solo el contacto hasta que se configure el tope.
- Q: ¿Qué recibe un cliente final que pide hablar con una persona cuando la instancia ya alcanzó su
  máximo de derivaciones nuevas del día? → A: El contacto del negocio para llamarle o escribirle él;
  el negocio no recibe aviso y el panel muestra cuántas peticiones se quedaron sin aviso.
- Q: ¿Puede el operador cambiar desde el panel los límites de las derivaciones? → A: Sí, junto al
  tope de gasto y al de WhatsApp, con valores por defecto genéricos y un mínimo y un máximo que
  impiden anularlos; no viajan en la exportación.
- Q: Si una instancia ya en producción tiene un secreto que ahora se considera débil, ¿qué pasa al
  actualizarla? → A: No arranca, como una nueva; la guía de publicación pide pasar `instance:check`
  antes de cada tanda y rotar los secretos que fallen.
- Q: ¿Cómo aparecen en los avisos al negocio las direcciones web que escribió el cliente final? →
  A: Dentro del texto marcado como del cliente y desactivadas para que no sean pulsables (sin
  protocolo y con los puntos marcados, p. ej. `ejemplo[.]com`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El gasto de una instancia en producción siempre está acotado (Priority: P1)

En producción, una instancia no atiende a clientes finales con el modelo si no tiene un tope de
gasto activo con precio para el modelo que usa. El tope falla cerrado: si el sistema no puede
saber cuánto se ha gastado, no llama al modelo. La transcripción de audios se comprueba contra el
tope antes de hacerse y su consumo suma al gasto. WhatsApp tiene, como el chat web, un tope diario
de respuestas con el modelo, que limita el número de llamadas aunque su coste no se conozca.

**Why this priority**: es el riesgo de mayor impacto económico y el que se explota sin ninguna
credencial: basta con escribir al número de WhatsApp o enviar audios.

**Independent Test**: en una instancia de producción sin tope, comprobar que el negocio no se puede
activar y que un negocio ya activo responde con el contacto sin llamar al modelo; activar el tope y
comprobar que se atiende con normalidad; simular que no se puede leer el gasto y que el bot no llama
al modelo; enviar audios con el tope alcanzado y comprobar que no se transcriben; superar el tope
diario de WhatsApp y comprobar que el resto del día se responde con el contacto.

**Acceptance Scenarios**:

1. **Given** una instancia en producción con el tope de gasto desactivado, **When** el operador
   intenta activar el negocio, **Then** no puede: el panel muestra un aviso crítico que dice que en
   producción el tope de gasto es obligatorio.
2. **Given** una instancia en producción con el negocio ya activo y sin tope (por ejemplo, recién
   actualizada a esta versión), **When** un cliente final escribe por WhatsApp o por el chat web,
   **Then** el bot no llama al modelo y responde con el contacto del negocio, como con el tope
   alcanzado (feature 010), y el panel muestra el aviso crítico en todas sus pantallas.
3. **Given** una instancia en producción con el negocio activo, **When** el operador intenta
   desactivar el tope, **Then** el cambio se rechaza con un mensaje que explica que en producción es
   obligatorio.
4. **Given** una instancia en producción cuyo modelo configurado no tiene precio, **When** llega un
   mensaje de un cliente final, **Then** el bot no llama al modelo y responde con el contacto; el
   panel muestra un aviso crítico que nombra el modelo.
5. **Given** cualquier instancia con tope activo, **When** no se puede leer el gasto del mes (por
   ejemplo, la consulta falla o tarda demasiado), **Then** el bot no llama al modelo y responde con
   el contacto del negocio (o el de emergencia de la instancia), y queda un evento en el registro de
   actividad.
6. **Given** los audios activados y el tope alcanzado, **When** un cliente final envía un audio,
   **Then** el audio no se descarga ni se transcribe y el cliente final recibe el contacto del
   negocio.
7. **Given** los audios activados y el gasto por debajo del tope, **When** se transcribe un audio,
   **Then** su consumo (duración y modelo de transcripción) queda registrado con su coste estimado,
   sin texto ni datos personales, y suma al gasto del mes.
8. **Given** el tope diario de respuestas de WhatsApp alcanzado, **When** un cliente final escribe
   por WhatsApp, **Then** el bot responde sin llamar al modelo con un mensaje fijo y el contacto del
   negocio; al empezar el día siguiente en la hora local del negocio vuelve a responder con el
   modelo.
9. **Given** el tope diario de WhatsApp o el tope de gasto alcanzados, **When** un cliente final
   pide hablar con una persona por WhatsApp, **Then** la petición se sigue derivando al negocio
   (feature 005), dentro de los límites de la User Story 2.
10. **Given** una respuesta cuyo coste no se conoce (el proveedor no informó de tokens o el registro
    de consumo falló), **When** se cuentan las respuestas del día, **Then** cuenta para el tope
    diario de su canal igual que cualquier otra.

---

### User Story 2 - Una derivación no se convierte en un canal de mensajes sin límite (Priority: P1)

Mientras una conversación está derivada al negocio, el bot calla y reenvía al negocio lo que
escribe el cliente final (feature 005). Esos reenvíos, los avisos de derivaciones nuevas y los
recordatorios cuestan dinero (plantillas de pago de WhatsApp) y llevan texto escrito por el cliente
final. Con esta feature cuentan para los límites de mensajes del cliente y del canal, tienen su
propio límite por instancia y por derivación, se agrupan, y el texto del cliente va claramente
delimitado para que el negocio no lo confunda con un mensaje del sistema.

**Why this priority**: es el segundo vector de gasto sin credenciales, y además permite a un
atacante enviar texto propio al teléfono o al correo del negocio desde un remitente de confianza.

**Independent Test**: con una derivación activa, enviar muchos mensajes seguidos desde un cliente
final y comprobar que el negocio recibe como mucho un aviso agrupado por periodo, que los mensajes
cuentan para el límite del cliente, y que al superar el límite de derivaciones nuevas del día el
cliente final recibe directamente el contacto del negocio.

**Acceptance Scenarios**:

1. **Given** una derivación activa, **When** el cliente final escribe varios mensajes en poco
   tiempo, **Then** el negocio recibe un único reenvío que agrupa los mensajes del periodo, no uno
   por mensaje.
2. **Given** una derivación activa que ya ha alcanzado su máximo de avisos en el periodo, **When**
   el cliente final sigue escribiendo, **Then** no se envían más avisos hasta el periodo siguiente,
   los mensajes no se pierden (van en el siguiente reenvío agrupado y se ven en el panel) y el
   cliente final no recibe nada distinto de lo habitual.
3. **Given** un cliente final con una derivación activa, **When** supera el límite de mensajes por
   cliente que ya aplica el bot, **Then** sus mensajes se tratan igual que sin derivación: dejan de
   reenviarse hasta que pasa la ventana y recibe el aviso de límite una sola vez.
4. **Given** la instancia ha alcanzado el máximo de derivaciones nuevas del día, **When** otro
   cliente final pide hablar con una persona, **Then** el negocio no recibe aviso, y el cliente final
   recibe el contacto del negocio para que lo llame o le escriba directamente (Principio V), y el
   panel muestra cuántas peticiones del día se quedaron sin aviso.
5. **Given** la instancia ha alcanzado el máximo diario de avisos al negocio, **When** se generaría
   otro aviso, reenvío o recordatorio, **Then** no se envía, queda un evento en el registro de
   actividad (una sola vez al día) y el panel muestra un aviso con el número de avisos retenidos.
6. **Given** un aviso al negocio con texto del cliente final, **When** el negocio lo lee por
   WhatsApp o por email, **Then** el texto que escribió el cliente aparece delimitado y marcado
   como escrito por el cliente, y sus direcciones web se ven desactivadas (por ejemplo,
   `ejemplo[.]com`) y no se pueden pulsar.

---

### User Story 3 - Las rutas públicas del chat web resisten la saturación (Priority: P2)

Las páginas y recursos del chat web que cualquiera puede pedir sin sesión (la página del chat, la
hoja de estilos del diseño y las imágenes del diseño) tienen límite de peticiones como el resto de
rutas públicas. La ruta de imágenes comprueba que la versión pedida es la vigente antes de leer la
imagen. Los límites por dirección agrupan las direcciones IPv6 de un mismo cliente. Una avalancha
de peticiones públicas no deja sin servicio al panel ni a WhatsApp.

**Why this priority**: es la principal vía de dejar la instancia sin servicio sin credenciales,
pero no genera gasto directo.

**Independent Test**: enviar ráfagas de peticiones a cada ruta pública desde una dirección y desde
direcciones IPv6 distintas del mismo bloque, y comprobar que se rechazan por encima del límite, que
el panel y el webhook de WhatsApp siguen respondiendo, y que pedir imágenes con versiones falsas no
lee ninguna imagen.

**Acceptance Scenarios**:

1. **Given** una dirección que supera el límite de peticiones de la página del chat, de la hoja de
   estilos del diseño o de las imágenes del diseño, **When** sigue pidiendo, **Then** recibe una
   respuesta de «demasiadas peticiones» hasta que pasa la ventana, sin que se consulte la base de
   datos.
2. **Given** una petición de imagen del diseño con una versión que no es la vigente, **When** se
   atiende, **Then** se responde «no encontrado» sin leer ni validar la imagen guardada.
3. **Given** peticiones desde muchas direcciones IPv6 del mismo bloque de red asignado a un cliente
   (un /64), **When** se aplican los límites por dirección, **Then** cuentan como una sola dirección.
4. **Given** una avalancha de peticiones públicas que ocupa la base de datos, **When** el operador
   usa el panel o llega un mensaje de WhatsApp, **Then** se atienden: las conexiones a la base de
   datos tienen un máximo y ninguna consulta puede durar indefinidamente.

---

### User Story 4 - El operador siempre puede entrar al panel con su credencial (Priority: P2)

El límite global de fallos del login deja de ser un bloqueo: en su lugar, cada intento espera un
retardo que crece con los fallos recientes. Un atacante que prueba contraseñas desde muchas
direcciones se frena igual, pero el operador con la credencial correcta entra, aunque tenga que
esperar unos segundos.

**Why this priority**: sin acceso al panel el operador no puede cortar un abuso (activar el tope,
desactivar el chat web, desactivar el negocio) justo cuando más falta hace.

**Independent Test**: provocar muchos fallos de login desde varias direcciones y comprobar que,
durante el ataque, el operador entra con la credencial correcta dentro del retardo máximo, y que el
ritmo de intentos del atacante queda limitado.

**Acceptance Scenarios**:

1. **Given** más fallos recientes que el antiguo límite global, **When** el operador introduce la
   credencial correcta desde una dirección que no ha superado su límite propio, **Then** entra al
   panel tras un retardo no mayor que el máximo.
2. **Given** fallos recientes, **When** llega cualquier intento de login, **Then** se aplica un
   retardo que crece con el número de fallos recientes hasta un máximo, y vuelve a cero cuando dejan
   de producirse fallos durante la ventana.
3. **Given** un ataque con muchos intentos simultáneos, **When** se verifican las contraseñas,
   **Then** el número de verificaciones simultáneas está limitado, para que el ataque no sature la
   instancia ni deje sin servicio al bot.
4. **Given** una dirección que supera su límite de intentos por minuto, **When** sigue intentándolo,
   **Then** se le sigue rechazando como hasta ahora.

---

### User Story 5 - Los servicios externos lentos o caídos no bloquean la instancia (Priority: P3)

Todas las llamadas a servicios externos (envío de mensajes, consulta de datos y descarga de audios
del proveedor de mensajería, y envío de correos) tienen un plazo máximo. Los lotes de mensajes que
fallan al procesarse se reintentan con una espera que crece en cada intento, con un máximo de
intentos, y sin repetir respuestas al cliente final ni avisos al negocio que ya se enviaron.

**Why this priority**: una llamada sin plazo o un lote que se reintenta sin espera pueden dejar la
instancia bloqueada o martilleando a un proveedor, pero requieren un fallo externo para darse.

**Independent Test**: simular un proveedor de mensajería que no responde y comprobar que cada
llamada termina en su plazo; simular un lote que falla siempre y comprobar los intervalos entre
reintentos, el abandono tras el máximo y que no hay envíos duplicados.

**Acceptance Scenarios**:

1. **Given** el proveedor de mensajería no responde, **When** la instancia envía un mensaje, consulta
   los datos de un archivo o descarga un audio, **Then** la llamada se abandona al cumplirse su plazo
   y se trata como un fallo.
2. **Given** el servidor de correo no responde, **When** se envía un aviso por email, **Then** el
   envío se abandona en su plazo y se trata como un fallo de esa vía.
3. **Given** un lote de mensajes cuyo procesamiento falla, **When** se reintenta, **Then** cada
   reintento espera más que el anterior y se lleva la cuenta de intentos.
4. **Given** un lote que ha agotado sus intentos, **When** se abandona, **Then** queda un evento en
   el registro de actividad sin datos personales, el cliente final recibe una disculpa con el
   contacto del negocio una sola vez, y el lote deja de reintentarse.
5. **Given** un lote que falla después de haber enviado ya la respuesta o el aviso, **When** se
   reintenta, **Then** no se envía de nuevo lo que ya se envió.

---

### User Story 6 - Importar una configuración tiene un coste acotado (Priority: P3)

Al importar un fichero de configuración (feature 008), las listas tienen un número máximo de
elementos, los errores que se muestran tienen un máximo, y el tiempo de proceso crece en proporción
al tamaño del fichero y no más.

**Why this priority**: solo puede hacerlo el operador con sesión, pero un fichero erróneo o
manipulado puede dejar la instancia ocupada durante minutos.

**Independent Test**: importar ficheros en el límite de tamaño con listas en su máximo, con más
elementos que el máximo y con miles de errores, y comprobar los rechazos, el número de errores
mostrados y el tiempo de proceso.

**Acceptance Scenarios**:

1. **Given** un fichero con una lista que supera su máximo de elementos, **When** se importa,
   **Then** se rechaza con un error que nombra la lista y el máximo, sin aplicar nada.
2. **Given** un fichero con muchos errores, **When** se valida, **Then** el panel muestra como mucho
   el número máximo de errores y dice cuántos más hay.
3. **Given** un fichero válido en el límite de tamaño y con las listas en su máximo, **When** se
   genera la vista previa y se confirma, **Then** cada paso termina dentro del tiempo de SC-007.
4. **Given** un fichero con elementos repetidos, **When** se detectan los repetidos, **Then** el
   tiempo de detección crece en proporción al número de elementos.

---

### User Story 7 - El bot no muestra enlaces que no haya verificado (Priority: P3)

El bot solo puede mostrar un enlace al cliente final si el verificador de afirmaciones lo ha visto y
comprobado contra la información registrada (Principio IV). La regla que reconoce un enlace es la
misma en el verificador, en el chat web y en «Probar el bot», para que ningún texto se muestre como
enlace sin haber pasado por el verificador.

**Why this priority**: protege el Principio IV y evita que el bot envíe a los clientes finales a
direcciones no registradas, pero requiere que el modelo produzca un enlace con una forma que hoy se
escapa al verificador.

**Independent Test**: con una batería de textos con enlaces en distintas formas (con y sin
protocolo, con signos de puntuación pegados, con caracteres poco comunes), comprobar que todo lo
que el chat web o «Probar el bot» muestran como enlace ha sido identificado antes por el
verificador.

**Acceptance Scenarios**:

1. **Given** una respuesta del modelo con una dirección web registrada del negocio, **When** se
   muestra, **Then** aparece como enlace.
2. **Given** una respuesta con una dirección web no registrada, en cualquier forma que el chat web o
   el panel mostrarían como enlace, **When** pasa por el verificador, **Then** se rechaza como dato
   no registrado.
3. **Given** un texto que el verificador no considera enlace, **When** se muestra en el chat web o
   en «Probar el bot», **Then** no se muestra como enlace.

---

### User Story 8 - Los registros no guardan datos y la instancia no arranca insegura (Priority: P2)

Los errores se registran con su tipo y su código, no con su mensaje ni con los datos que llevan. El
token de verificación del webhook y cualquier otro secreto de las direcciones de las peticiones no
aparecen en el registro. En producción, la instancia no arranca con secretos débiles, de ejemplo o
repetidos, ni sin la clave de las copias o el secreto de salud.

**Why this priority**: un error completo puede llevar textos de clientes o credenciales, y un
secreto débil invalida las demás protecciones; se corrige antes de publicar, aunque no se explota
directamente desde Internet.

**Independent Test**: provocar errores con datos personales y secretos en su mensaje y comprobar
que el registro solo contiene tipo y código; hacer la verificación del webhook y comprobar que el
token no aparece; arrancar en producción con cada tipo de secreto débil y con cada secreto
obligatorio ausente y comprobar que no arranca y que el mensaje nombra la variable sin mostrar su
valor.

**Acceptance Scenarios**:

1. **Given** un error al procesar un mensaje, al enviar un aviso o en una petición, **When** se
   registra, **Then** el registro contiene el tipo y el código del error y el contexto de la
   instancia, y no contiene el mensaje del error, textos de clientes, teléfonos, direcciones de
   correo ni secretos.
2. **Given** la verificación del webhook de WhatsApp, **When** se registra la petición, **Then** el
   token de verificación no aparece en el registro.
3. **Given** el entorno de producción, **When** algún secreto de la instancia es demasiado corto,
   coincide con un valor de ejemplo de la documentación, es trivial (por ejemplo, un solo carácter
   repetido) o coincide con otro secreto de la instancia, **Then** la instancia no arranca y el
   mensaje nombra la variable y la regla incumplida sin mostrar su valor.
4. **Given** el entorno de producción, **When** falta la clave de las copias o el secreto de salud,
   **Then** la instancia no arranca y el mensaje nombra la variable que falta.
5. **Given** un entorno que no es de producción, **When** los secretos son débiles, **Then** la
   instancia arranca y lo indica en el registro de arranque.
6. **Given** una instancia que cumple estos requisitos, **When** se ejecuta la comprobación previa
   al despliegue (feature 007), **Then** aplica las mismas reglas y da el mismo resultado que el
   arranque.

---

### Edge Cases

- **Actualizar a esta versión una instancia en producción con el negocio activo y sin tope**: arranca
  y el panel funciona, pero los clientes finales reciben el contacto hasta que el operador configure
  el tope (fallo cerrado). La guía de publicación por tandas (sección 5 de la guía de operación)
  avisa de configurarlo antes de actualizar.
- **Tope de gasto, tope diario de WhatsApp, tope del chat web y límite por cliente a la vez**: se
  aplican todos; manda el primero que se alcance.
- **Audio con el tope a punto de alcanzarse**: la comprobación se hace antes de transcribir; si la
  transcripción hace superar el tope, la respuesta de ese audio termina y se cuenta, como en 010.
- **Audios desactivados**: no hay consumo de transcripción ni precio que exigir.
- **Modelo de transcripción sin precio con los audios activados en producción**: los audios se
  responden como con el tope alcanzado y el panel muestra un aviso crítico que nombra el modelo.
- **«Probar el bot» con el tope alcanzado o sin tope en producción**: sigue funcionando como en 010
  (su consumo suma y la pantalla avisa); no cuenta para el tope diario de WhatsApp.
- **Derivación por email sin límite de coste**: los avisos por email no cuestan por mensaje, pero
  cuentan igual para los límites de avisos, porque el problema es también el texto del atacante en
  el buzón del negocio.
- **Avisos retenidos al pasar el periodo**: se envían agrupados en el siguiente aviso permitido; si
  la derivación ha terminado entretanto, no se envían y siguen visibles en el panel.
- **El cliente final que ya tiene una derivación activa pide otra persona**: no cuenta como
  derivación nueva.
- **Varias instancias detrás del mismo proxy**: cada instancia aplica sus límites por su cuenta; la
  dirección del cliente final depende de la configuración del proxy (P9).
- **Instancia ya publicada con un secreto que ahora es débil**: al actualizarla no arranca, igual que
  una nueva. La guía de publicación por tandas pide pasar la comprobación previa al despliegue antes
  de cada tanda y rotar los secretos que fallen; si se actualiza sin hacerlo, la vuelta atrás
  (feature 009) devuelve la versión anterior hasta rotarlos.
- **Retardo del login y reinicio de la instancia**: el contador de fallos se pierde al reiniciar; se
  acepta, porque el límite por dirección y el retardo vuelven a crecer con el ataque.
- **Lote abandonado y mensaje nuevo del mismo cliente**: el mensaje nuevo empieza un lote nuevo con
  su propio contador de intentos.
- **Restauración de una copia** (feature 006): el consumo de transcripción y los contadores diarios
  vuelven con la base de datos.
- **Exportar e importar configuración** (feature 008): los topes y los límites son de la instancia y
  no viajan en el fichero de configuración del negocio.

## Requirements *(mandatory)*

### Functional Requirements

**Tope de gasto obligatorio y que falla cerrado**

- **FR-001**: En producción, un tope de gasto desactivado o un modelo configurado sin precio MUST ser
  un aviso crítico: impide activar el negocio y, si el negocio ya está activo, se muestra en todas
  las pantallas del panel. Fuera de producción el tope sigue siendo opcional (feature 010).
- **FR-002**: En producción, mientras se dé alguna de las condiciones de FR-001, los canales de
  clientes finales MUST NOT llamar al modelo y MUST responder como con el tope alcanzado (feature
  010, FR-016 y FR-017).
- **FR-003**: En producción, con el negocio activo, desactivar el tope o borrar el precio del modelo
  configurado MUST rechazarse con un mensaje que lo explique.
- **FR-004**: Si no se puede conocer el gasto del mes (la consulta falla o supera su plazo), el
  sistema MUST NOT llamar al modelo para clientes finales y MUST responder con el contacto del
  negocio o, si no se puede leer, con el de emergencia de la instancia. MUST registrarse un evento
  de actividad sin datos personales.
- **FR-005**: Las respuestas con modelo cuyo coste no se conoce (el proveedor no informó de tokens o
  el registro de consumo falló) MUST contar para los topes diarios de respuestas de su canal.

**Transcripción de audios dentro del tope**

- **FR-006**: Antes de descargar y transcribir un audio, el sistema MUST comprobar el tope de gasto,
  el tope diario del canal y las condiciones de FR-001; si alguno lo impide, MUST NOT descargarlo ni
  transcribirlo y MUST responder con el contacto del negocio.
- **FR-007**: Cada transcripción MUST registrar su consumo (momento, canal, uso «transcripción»,
  modelo y duración del audio) con su coste estimado según el precio por minuto que el operador
  configure para ese modelo, sin textos ni datos personales, y MUST sumar al gasto del mes. Se
  aplican las reglas de precio de la feature 010 (coste guardado al registrar, «sin precio» si no lo
  hay).
- **FR-008**: En producción, con los audios activados, un modelo de transcripción sin precio MUST ser
  un aviso crítico y los audios MUST responderse como con el tope alcanzado.

**Tope diario de respuestas en WhatsApp**

- **FR-009**: El operador MUST poder fijar en el panel un tope diario de respuestas con modelo en
  WhatsApp para toda la instancia, con un valor por defecto genérico. En producción MUST NOT poder
  desactivarse.
- **FR-010**: Alcanzado el tope diario de WhatsApp, el bot MUST NOT llamar al modelo en WhatsApp y
  MUST responder con un mensaje fijo y el contacto del negocio hasta el día siguiente en la hora
  local del negocio; la derivación a una persona MUST seguir funcionando dentro de los límites de
  FR-013 y FR-014.
- **FR-011**: El tope diario de respuestas del chat web (feature 004) MUST NOT poder desactivarse en
  producción.

**Derivaciones**

- **FR-012**: Los mensajes del cliente final durante una derivación activa MUST contar para el
  límite de mensajes por cliente que ya aplica el bot, igual que sin derivación.
- **FR-013**: El sistema MUST limitar el número de derivaciones nuevas por instancia y día local.
  Alcanzado el límite, una petición de hablar con una persona MUST responderse con el contacto del
  negocio sin avisar al negocio, y MUST quedar un evento de actividad una vez al día. El panel MUST
  mostrar cuántas peticiones del día se quedaron sin aviso por este límite.
- **FR-014**: El sistema MUST limitar el número de avisos al negocio (avisos de derivación,
  reenvíos y recordatorios, por cualquier vía) por derivación y periodo, y por instancia y día. Los
  mensajes del cliente final que lleguen durante un periodo MUST agruparse en un solo reenvío.
- **FR-015**: Los mensajes que no se reenvían por los límites MUST conservarse: se incluyen en el
  siguiente reenvío permitido de esa derivación y se ven en el panel. El panel MUST mostrar un aviso
  cuando haya avisos retenidos por el límite diario de la instancia.
- **FR-016**: En los avisos al negocio, el texto escrito por el cliente final y las direcciones web
  que contenga MUST ir delimitados y marcados como escritos por el cliente («El cliente escribió:
  …»). Las direcciones web y de correo MUST desactivarse para que no sean pulsables en ningún
  programa de correo ni en WhatsApp (sin protocolo y con los puntos marcados, por ejemplo
  `ejemplo[.]com`), conservando lo bastante para que el negocio sepa qué escribió el cliente.
- **FR-017**: El operador MUST poder cambiar en el panel, junto al tope de gasto y al tope diario de
  WhatsApp, los límites de FR-013 y FR-014. Tienen valores por defecto genéricos y válidos para
  cualquier sector, documentados en la guía de operación, y un mínimo y un máximo que impiden
  anularlos; los cambios se validan, se aplican en una transacción y valen desde el siguiente
  mensaje.

**Rutas públicas**

- **FR-018**: La página del chat web, la hoja de estilos del diseño y las imágenes del diseño MUST
  tener límite de peticiones por dirección, comprobado antes de consultar la base de datos.
- **FR-019**: La ruta de imágenes del diseño MUST comprobar que la versión pedida es la vigente antes
  de leer la imagen guardada.
- **FR-020**: Todos los límites por dirección MUST agrupar las direcciones IPv6 por su bloque /64.
- **FR-021**: Las conexiones a la base de datos MUST tener un máximo, y toda consulta MUST tener una
  duración máxima, de forma que una saturación de rutas públicas no deje sin servicio al panel ni a
  WhatsApp.

**Login del operador**

- **FR-022**: El límite global de fallos del login MUST NOT impedir la entrada con la credencial
  correcta. En su lugar, cada intento MUST esperar un retardo que crece con los fallos recientes de
  toda la instancia, hasta un máximo.
- **FR-023**: El número de verificaciones de contraseña simultáneas MUST estar limitado.
- **FR-024**: Se MUST mantener el límite de intentos por dirección, la verificación en tiempo
  constante y el mensaje de error único del login actual.

**Llamadas salientes y reintentos**

- **FR-025**: Toda llamada a un servicio externo (envío de mensajes, consulta de datos y descarga de
  archivos del proveedor de mensajería, envío de correos) MUST tener un plazo máximo; al cumplirse,
  MUST abandonarse y tratarse como un fallo.
- **FR-026**: Los lotes de mensajes cuyo procesamiento falla MUST reintentarse con una espera que
  crece en cada intento y con un máximo de intentos; al agotarlos, MUST abandonarse, registrar un
  evento de actividad sin datos personales y enviar al cliente final una sola disculpa con el
  contacto del negocio.
- **FR-027**: Un reintento MUST NOT volver a enviar respuestas al cliente final ni avisos al negocio
  que ya se enviaron.

**Importación de configuración**

- **FR-028**: El fichero de configuración MUST tener un tamaño máximo y cada una de sus listas un
  número máximo de elementos; superarlos MUST rechazar la importación sin aplicar nada, con un error
  que nombre el límite.
- **FR-029**: La validación MUST mostrar como mucho un número máximo de errores e indicar cuántos más
  hay.
- **FR-030**: El tiempo de validación, vista previa y aplicación MUST crecer en proporción al tamaño
  del fichero (sin comparaciones de todos con todos).

**Enlaces**

- **FR-031**: Todo lo que el chat web, WhatsApp o «Probar el bot» muestren como enlace MUST haber sido
  identificado como enlace por el verificador de afirmaciones; la regla que reconoce enlaces MUST
  ser una sola para todos ellos.

**Registros y arranque**

- **FR-032**: Los errores MUST registrarse con su tipo y su código, sin su mensaje ni los datos que
  lleven.
- **FR-033**: El token de verificación del webhook y cualquier otro secreto que llegue en la
  dirección de una petición MUST NOT aparecer en el registro de peticiones.
- **FR-034**: En producción, la instancia MUST NOT arrancar si algún secreto es demasiado corto, es un
  valor de ejemplo de la documentación, es trivial o coincide con otro secreto de la instancia, ni
  si falta la clave de las copias o el secreto de salud. El mensaje MUST nombrar la variable y la
  regla sin mostrar el valor.
- **FR-035**: La comprobación previa al despliegue (feature 007) MUST aplicar las mismas reglas de
  FR-034 y dar el mismo resultado que el arranque.

**Límites con otras features**

- **FR-036**: Los topes y límites de esta feature y el precio de la transcripción MUST NOT incluirse
  en el fichero de configuración del negocio (feature 008) ni modificarse al importarlo, y MUST
  formar parte de la base de datos de la instancia y de sus copias (feature 006).
- **FR-037**: El estado del tope en el informe completo de salud (feature 010, FR-023a) MUST indicar
  también cuándo la instancia está respondiendo solo con el contacto por las condiciones de FR-001 o
  FR-008.
- **FR-038**: El núcleo MUST NOT contener topes ni límites específicos de un cliente o sector.

### Key Entities

- **Registro de consumo** (feature 010, ampliado): añade el uso «transcripción» y, para ese uso, la
  duración del audio en lugar de tokens.
- **Precio de modelo** (feature 010, ampliado): añade el precio por minuto para los modelos de
  transcripción.
- **Ajustes de consumo** (feature 010, ampliado): añade el tope diario de respuestas de WhatsApp.
- **Límites de derivación**: máximo de derivaciones nuevas por día, de avisos por derivación y
  periodo, y de avisos por instancia y día. Ajustes de la instancia editables en el panel, con
  mínimo y máximo; no viajan en la exportación.
- **Estado de protección** (calculado, no guardado): si la instancia está en producción sin tope o
  sin precio, si el gasto no se puede leer, qué topes están alcanzados hoy y cuántos avisos al
  negocio hay retenidos.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: En producción, el 100 % de los mensajes de clientes finales recibidos sin tope activo,
  sin precio para el modelo o sin poder leer el gasto se responden sin ninguna llamada al modelo ni
  a la transcripción.
- **SC-002**: Con el tope de gasto o el tope diario de un canal alcanzado, el 100 % de los audios se
  responden sin descargarse ni transcribirse, y el 100 % de las peticiones de hablar con una persona
  reciben una salida (derivación o contacto del negocio).
- **SC-003**: Durante una derivación, 100 mensajes seguidos de un cliente final producen como mucho
  el número de avisos al negocio que permite su límite por periodo, y ninguno de esos mensajes se
  pierde.
- **SC-004**: Una ráfaga de 10.000 peticiones a las rutas públicas del chat web desde una dirección
  (o desde un mismo bloque IPv6) no impide que el panel y WhatsApp sigan respondiendo en menos de 2
  segundos.
- **SC-005**: Durante un ataque de fallos de login desde muchas direcciones, el operador entra con la
  credencial correcta en menos de 30 segundos.
- **SC-006**: Con el proveedor de mensajería o el servidor de correo sin responder, ninguna llamada
  queda abierta más que su plazo y la instancia sigue atendiendo los demás canales.
- **SC-007**: Validar y previsualizar un fichero de configuración en su tamaño máximo tarda menos de
  5 segundos.
- **SC-008**: En una batería de textos con enlaces en distintas formas, el 0 % de lo mostrado como
  enlace por el chat web o «Probar el bot» se ha escapado al verificador.
- **SC-009**: En una batería de errores provocados con datos personales y secretos, el 0 % de las
  líneas del registro contiene esos datos o el token de verificación.
- **SC-010**: El 100 % de los casos de secreto débil, de ejemplo, repetido o ausente de la batería de
  pruebas impiden el arranque en producción, y la comprobación previa al despliegue da el mismo
  resultado en todos.
- **SC-011**: En una batería de mensajes de cliente con direcciones web y de correo en distintas
  formas, el 0 % aparece como una dirección completa con protocolo o sin desactivar en los avisos
  al negocio, por WhatsApp o por email.

## Assumptions

- Se parte de la auditoría completa del 2026-10-05: todos los puntos están comprobados en el código
  actual. Los retos anti-bot en el chat web quedan fuera de alcance y solo se valorarán si los
  límites no bastan.
- Los requisitos de despliegue (proxy de confianza, TLS hacia la base de datos, imagen, receta de
  producción) son de la P9 y quedan fuera.
- El límite del workspace del proveedor del modelo sigue siendo la última red de seguridad por
  encima del tope de la instancia.
- Los límites por defecto son genéricos y orientativos (se fijan en el plan): por ejemplo, del orden
  de 20 derivaciones nuevas al día por instancia, un reenvío agrupado como mucho cada 15 minutos por
  derivación, y un tope diario de WhatsApp del mismo orden que el del chat web (feature 004). Todos
  se editan en el panel dentro de su mínimo y su máximo (FR-009, FR-017).
- El retardo máximo del login es de unos segundos (bastante menor que el objetivo de SC-005); el
  contador de fallos vive en memoria de la instancia, como hoy.
- El coste de las plantillas de WhatsApp no se estima en dinero: se acota por número de avisos.
- La transcripción se cobra por duración del audio; se usa la duración que informa el proveedor o,
  si no la informa, la del archivo.
- «Secreto débil» se concreta en el plan con reglas verificables (longitud mínima, valores de
  ejemplo de `.env.example` y de la documentación, caracteres repetidos, coincidencia con otro
  secreto); la contraseña del operador ya se guarda como hash y su fortaleza no se comprueba aquí.
- Las instancias que ya están en producción se actualizan siguiendo la guía de publicación por
  tandas (feature 009); la guía de operación se actualiza para pedir, antes de cada tanda,
  configurar el tope y pasar la comprobación previa al despliegue para rotar los secretos débiles.
