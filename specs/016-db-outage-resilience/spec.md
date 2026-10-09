# Feature Specification: Resistencia a los cortes de la base de datos y verificación de copias por socket

**Feature Branch**: `016-db-outage-resilience`

**Created**: 2026-10-09

**Status**: Ready for implementation

**Ámbito**: Núcleo (corrección; afecta a todas las instancias)

**Input**: User description: "Corrección de núcleo: resistencia a los cortes de la base de datos y verificación de copias con socket Unix. Dos fallos descubiertos en la fase 9 del despliegue a producción, los dos del mismo origen: qué hace el programa cuando la base de datos no está disponible."

## Contexto

La fase 9 del [plan de despliegue](../../docs/plan-despliegue-produccion.md) —las pruebas de punta a
punta sobre las dos instancias reales— destapó dos fallos del núcleo el 2026-10-09. Ninguno es de
configuración: los dos estaban en el código desde antes y ninguno de los tests actuales los detecta.

Los dos responden a la misma pregunta mal resuelta: **qué hace el programa cuando la base de datos
no está**.

### Fallo 1 · Un corte de la base de datos mata el proceso de la instancia

La instancia mantiene conexiones abiertas y ociosas contra PostgreSQL. Cuando el servidor
desaparece, esas conexiones avisan de que se han caído; si nadie recoge ese aviso, el entorno de
ejecución lo trata como un error fatal y **termina el proceso**. La política de reinicio lo
relanza, el arranque intenta aplicar las migraciones, la base sigue sin estar y vuelve a caer:
**bucle de reinicio**, con el proxy devolviendo 502 a todo el mundo.

Comprobado en producción el 2026-10-09: al parar PostgreSQL, las dos instancias pasaron a
`restarting` y solo volvieron cuando volvió la base, 60 s después.

**Lo grave no es la caída: es que deja inalcanzable toda la resistencia a fallos que el núcleo ya
tiene escrita.** La feature 012 implementó qué responder cuando la base de datos no da servicio —el
«ahora mismo no puedo atenderte» con el contacto, el teléfono de emergencia cuando no se puede leer
la información del negocio, la disculpa al abandonar un lote de mensajes—, y nada de eso llega a
ejecutarse nunca, porque el proceso muere antes de poder responder.

Para el cliente final, el efecto es el peor posible: el chat se queda **«escribiendo…» para
siempre**. No recibe ni una respuesta, ni un aviso, ni el teléfono del negocio. Esto choca de frente
con el **Principio V** de la constitución: desde cualquier punto de cualquier flujo tiene que haber
salida a una persona.

Ese «escribiendo…» eterno es además un segundo defecto, independiente de la causa: la interfaz del
chat pinta ese texto antes de enviar y solo lo retira cuando la respuesta del servidor encaja en
alguno de los casos que conoce. Ante un fallo inesperado del servidor no encaja en ninguno y la
interfaz se queda colgada sin decir nada, aunque el servidor siga vivo.

### Fallo 2 · Las copias no se pueden comprobar en la arquitectura de producción

La orden que comprueba una copia de seguridad la restaura en una base de datos temporal y compara
los recuentos. Para hacerlo construye la dirección de esa base temporal, y la construye con una
herramienta que **no admite el formato de dirección que usa el despliegue real**: el de las bases
alcanzadas por socket local, sin nombre de servidor.

Consecuencia: **en producción las copias nunca se han podido verificar**. Se crean bien, se
guardan bien y se listan bien; es la comprobación la que falla, y falla además con un mensaje que
despista («no se pudo crear la base de datos temporal») porque la conexión y la creación **sí**
funcionan: lo que falla es el paso siguiente, y el rastro se borra solo.

El núcleo ya conoce esa limitación del formato y la rodea en el módulo que clasifica las
direcciones de base de datos; el código de las copias se quedó fuera de esa lección.

### Por qué no lo vieron los tests

Es la parte que más importa de esta spec, porque es la que evita que vuelva a pasar:

- **Los tests simulan el fallo justo donde el código lo espera.** Las pruebas de la 012 inyectan
  errores en la capa de datos y comprueban las respuestas; nunca cortan la base de datos por
  debajo. Con el fallo inyectado, el error llega por el camino previsto y todo funciona. Con la base
  caída de verdad, llega **además** por otro camino —las conexiones ociosas— que nadie vigilaba.
- **Ningún test usa una dirección de base de datos por socket local.** Todos usan direcciones con
  nombre de servidor, mientras que el despliegue real usa dos agrupaciones de PostgreSQL alcanzadas
  solo por socket.

De ahí que los dos fallos pasaran por las pruebas unitarias, de contrato y de integración y solo
aparecieran en producción.

## Clarifications

### Session 2026-10-09

- Q: ¿La corrección debe garantizar también que WhatsApp responda al cliente final durante el corte de la base de datos, o basta con el chat web? → A: Los dos canales: la garantía de respuesta con contacto durante el corte aplica a cualquier canal del núcleo (chat web y WhatsApp), con escenario de aceptación propio para WhatsApp.
- Q: Durante el corte, ¿qué debe devolver la comprobación de salud para que el orquestador no reinicie la instancia y anule la corrección? → A: Responde correctamente (proceso vivo, no reiniciable) e informa del estado degradado de la base de datos en su contenido; el orquestador no reinicia.
- Q: Cuando la interfaz del chat no recibe respuesta útil del servidor, ¿de dónde saca el teléfono de contacto que debe mostrar? → A: El contacto viaja en la página del chat al cargarla y la interfaz lo usa aunque el servidor no responda.
- Q: ¿La prueba que corta de verdad la base de datos debe ejecutarse dentro de `pnpm test`, o en una suite aparte? → A: Dentro de las pruebas de integración (y por tanto de `pnpm test`), con su contenedor propio para no afectar a las demás pruebas.
- Q: Durante un corte largo, ¿qué debe hacer el registro con los fallos de conexión repetidos? → A: Registrar una vez el inicio del corte y una vez su recuperación, agrupando los fallos repetidos del intervalo.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El cliente final recibe una respuesta aunque la base de datos no esté (Priority: P1)

Un cliente está escribiendo al bot por cualquiera de los canales —el chat web o WhatsApp—. En ese
momento la base de datos del negocio deja de estar disponible: un reinicio de mantenimiento, un
corte momentáneo, un fallo del servidor.

Hoy el cliente se queda mirando «escribiendo…» indefinidamente y nunca recibe nada. Con esta
corrección, recibe en el acto un mensaje que le dice que ahora no se le puede atender por el chat y
le da una forma de hablar con una persona.

**Why this priority**: es el Principio V de la constitución, no negociable, y hoy está incumplido en
la práctica. Además es lo que convierte un corte breve de la base de datos en una caída total y
visible del servicio del cliente.

**Independent Test**: se puede probar entero cortando la base de datos mientras el chat está abierto
y comprobando que llega respuesta con contacto, sin tocar nada más del sistema.

**Acceptance Scenarios**:

1. **Given** una instancia en marcha con el negocio activo y una conversación abierta en el chat
   web, **When** la base de datos deja de estar disponible y el cliente envía un mensaje,
   **Then** el chat responde que no puede atenderle ahora y muestra una forma de contactar con una
   persona, y el proceso de la instancia **sigue vivo**.
2. **Given** la misma situación, **When** no se puede leer la información del negocio —que durante
   un corte es siempre el caso, porque se lee de la base de datos en cada respuesta y sin caché—,
   **Then** el contacto que se muestra es el teléfono de emergencia de la instancia.
3. **Given** una instancia que ha pasado por un corte de la base de datos, **When** la base de datos
   vuelve, **Then** la instancia vuelve a atender con normalidad **sin que haya hecho falta
   reiniciar el proceso** y sin que el operador tenga que intervenir.
4. **Given** una instancia durante el corte, **When** se consulta su estado de salud,
   **Then** responde e informa de que su base de datos no está disponible, y ese resultado no
   provoca que el despliegue reinicie el proceso.
5. **Given** la misma instancia durante el corte, **When** llega el primer mensaje de un cliente
   final por WhatsApp, **Then** recibe el mismo aviso con el mismo contacto de emergencia que por
   el chat web, y el proceso de la instancia **sigue vivo**.
6. **Given** un cliente que ya recibió el aviso por WhatsApp en este corte, **When** insiste con
   más mensajes o la plataforma reintenta la entrega, **Then** no se le envía ningún mensaje
   saliente más durante ese corte; cuando la base de datos vuelva, sus mensajes se atienden con
   normalidad, y un corte posterior volverá a avisarle (FR-002).

---

### User Story 2 - El operador puede comprobar que sus copias de seguridad sirven (Priority: P1)

El operador hace una copia de seguridad de una instancia y quiere confirmar que se puede restaurar.
Hoy, en la arquitectura de producción, esa comprobación falla siempre y el operador no tiene forma
de saber si sus copias valen.

**Why this priority**: una copia que no se puede comprobar es una copia en la que no se puede
confiar, y es el único respaldo de los datos del cliente. El coste de descubrirlo el día que haga
falta restaurar es total.

**Independent Test**: se puede probar entero ejecutando la comprobación de una copia en una
instancia cuya base de datos se alcanza por socket local y verificando que responde «restaurable».

**Acceptance Scenarios**:

1. **Given** una instancia cuya base de datos y cuyo servidor de verificación se alcanzan por socket
   local, **When** el operador comprueba una copia recién hecha, **Then** el resultado es
   **restaurable**, con sus recuentos por tabla, y la base temporal queda borrada.
2. **Given** la misma instancia, **When** la copia está corrupta o la clave de cifrado no es la
   suya, **Then** el resultado es **no restaurable** con el motivo correcto, distinguible de un
   problema de conexión.
3. **Given** una instancia cuya base de datos se alcanza por nombre de servidor, **When** el
   operador comprueba una copia, **Then** sigue funcionando exactamente igual que antes.

---

### User Story 3 - La interfaz del chat no se queda colgada ante un fallo inesperado (Priority: P2)

Un cliente envía un mensaje y el servidor devuelve algo que la interfaz no sabe interpretar: un
error interno, una respuesta del proxy, una caída de red. Hoy la interfaz se queda en «escribiendo…»
indefinidamente, sin mensaje y sin salida.

**Why this priority**: es independiente de la causa concreta y protege contra fallos futuros que hoy
no están previstos, pero no es el que deja el servicio caído. Va después de la 1 y la 2.

**Independent Test**: se puede probar provocando desde el servidor una respuesta de error a un envío
y comprobando que la interfaz deja de indicar espera y ofrece contacto.

**Acceptance Scenarios**:

1. **Given** un chat abierto, **When** el envío de un mensaje termina en un fallo que la interfaz no
   reconoce, **Then** la interfaz deja de indicar que el bot está escribiendo y muestra un aviso con
   la forma de contactar con el negocio, tomada de la que la página trae desde que se cargó.
2. **Given** ese mismo estado, **When** el cliente vuelve a escribir más tarde y el servicio ya
   funciona, **Then** la conversación continúa con normalidad.

---

### User Story 4 - Ningún otro punto del sistema tiene el mismo defecto (Priority: P2)

El operador necesita saber que los dos fallos están corregidos **en todos los sitios donde pueden
darse**, no solo donde se detectaron.

**Why this priority**: los dos fallos son casos particulares de dos descuidos sistemáticos. Corregir
solo el sitio donde se vieron deja el siguiente despliegue expuesto al mismo problema en otro punto.

**Independent Test**: se puede verificar con una revisión del código y de las pruebas, con criterio
de aceptación comprobable.

**Acceptance Scenarios**:

1. **Given** el código del núcleo, **When** se revisan todos los puntos que abren conexiones a la
   base de datos, **Then** todos tratan el fallo de una conexión ociosa sin terminar el proceso.
2. **Given** el código del núcleo, **When** se revisan todos los puntos que interpretan o
   reconstruyen una dirección de base de datos, **Then** todos admiten las direcciones por socket
   local.
3. **Given** el conjunto de pruebas, **When** se revisa qué formas de dirección cubre,
   **Then** las direcciones por socket local están cubiertas.

---

### Edge Cases

- **La base de datos no está al arrancar.** El proceso no puede aplicar las migraciones ni servir;
  termina y la política de reinicio lo relanza. Eso se mantiene: es un arranque imposible, no una
  degradación. La diferencia es que una instancia **ya arrancada** no debe caer.
- **La base de datos se cae en mitad de una escritura** (una derivación, un mensaje entrante): la
  operación falla y se informa al cliente; no se da por hecha ninguna escritura a medias.
- **Corte muy breve**, de menos de lo que tarda un mensaje: la instancia sigue viva y la siguiente
  petición vuelve a funcionar sin intervención.
- **La base de datos vuelve pero con otra identidad** (restauración, cambio de servidor): queda
  fuera del alcance de esta corrección; lo cubre la comprobación de esquema del arranque.
- **El panel del operador durante el corte**: deja de poder leer y escribir, pero el proceso vive,
  así que las sesiones abiertas siguen valiendo y no hay que volver a entrar al volver la base.
- **La comprobación de una copia se interrumpe** dejando una base temporal: se sigue limpiando al
  principio de la comprobación siguiente, como hasta ahora.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Una instancia ya arrancada MUST seguir en ejecución cuando su base de datos deja de
  estar disponible, sea cual sea el momento del corte, y MUST NOT terminar el proceso por ese
  motivo.
- **FR-002**: Durante el corte, **todos los canales del núcleo** (chat web y WhatsApp) MUST
  responder a los mensajes del cliente final con el aviso de que no se le puede atender y con una
  forma de contactar con una persona. Ningún canal puede quedar sin respuesta durante el corte.
  La cadencia del aviso depende de la naturaleza del canal:
  - **Canales sincrónicos** (chat web): cada petición del cliente MUST obtener su respuesta con
    contacto, sin excepción.
  - **Canales asincrónicos** (WhatsApp): el aviso con contacto MUST llegar **al menos una vez por
    cliente y corte**, y MUST NOT repetirse con cada mensaje insistente ni con cada reintento de
    la plataforma, porque el envío no depende de una petición del cliente y repetirlo convertiría
    el aviso en una ráfaga de mensajes salientes. Tras la recuperación, un corte posterior vuelve
    a avisar.

  El contacto que se ofrece durante el corte es el **teléfono de emergencia de la instancia**, por
  construcción: la información del negocio se lee de la base de datos en cada respuesta y sin
  caché, así que mientras la base no está no hay contacto del negocio que ofrecer. La regla de dos
  ramas —contacto del negocio si se puede leer su información, emergencia si no— sigue aplicándose
  donde sí hay información disponible: en la carga de la página del chat (FR-013) y en el resto de
  los fallos que ya cubre la 012.
- **FR-003**: Durante el corte, la comprobación de salud de la instancia MUST responder —en lugar
  de quedarse sin respuesta— con un resultado **correcto** que indique en su contenido que la base
  de datos no está disponible. El resultado MUST NOT ser uno que la política de reinicio del
  despliegue interprete como motivo para reiniciar el proceso: el proceso vive y sirve, aunque su
  base de datos esté degradada.
- **FR-004**: Cuando la base de datos vuelve, la instancia MUST recuperar el servicio por sí sola,
  sin reiniciar el proceso y sin intervención del operador.
- **FR-005**: Todos los puntos del núcleo que abren conexiones a la base de datos MUST tratar el
  fallo de una conexión sin terminar el proceso. Criterio verificable: una búsqueda de los puntos
  que crean conexiones o agrupaciones de conexiones no devuelve ninguno sin ese tratamiento.
- **FR-006**: La comprobación de una copia de seguridad MUST funcionar cuando la base de datos de
  verificación se alcanza por socket local, y MUST devolver «restaurable» con sus recuentos cuando
  la copia es válida. Verificación: la forma **sin nombre de servidor** —la que rompía el código y
  es la raíz del fallo— MUST comprobarse en las pruebas automáticas en cualquier sistema
  operativo; la forma con **ruta de socket Unix literal** solo se puede ejecutar en sistemas que
  admiten sockets Unix, así que su prueba se salta en Windows con una razón visible y su
  verificación obligatoria es el escenario de producción de SC-004. No existe hoy integración
  continua en Linux, de modo que SC-004 es la única puerta que ejercita la forma literal de
  producción y MUST pasarse antes de dar la feature por terminada.
- **FR-007**: Todos los puntos del núcleo que interpretan o reconstruyen una dirección de base de
  datos MUST admitir las direcciones por socket local, con el mismo criterio que ya aplica el módulo
  de clasificación de direcciones.
- **FR-008**: Los motivos de fallo de la comprobación de copias MUST distinguir un problema de
  conexión de un problema de la copia, de modo que el mensaje no atribuya a una causa un fallo
  ocurrido en otra.
- **FR-009**: La interfaz del chat web MUST dejar de indicar espera y MUST mostrar un aviso con la
  forma de contactar ante cualquier respuesta de error que no sepa interpretar, incluidas las que no
  proceden de la instancia. El contacto que muestra es el que la página ya trae consigo (FR-013),
  sin depender de una respuesta del servidor en ese momento.
- **FR-010**: El conjunto de pruebas MUST incluir una prueba que corte de verdad la base de datos
  con la instancia en marcha y verifique FR-001 a FR-004. No vale inyectar el fallo en la capa de
  datos: tiene que ser el servidor el que deje de estar. Esta prueba MUST formar parte de las
  pruebas de integración que se ejecutan con la orden de pruebas habitual, y MUST usar una base de
  datos propia y aislada, de modo que pararla no altere el resto de las pruebas.
- **FR-011**: El conjunto de pruebas MUST incluir una prueba de la reconstrucción de direcciones de
  base de datos con una dirección por socket local, sin necesidad de una base de datos real.
- **FR-012**: Ningún mensaje, registro ni salida nueva de esta corrección MUST contener
  credenciales, direcciones de base de datos ni partes de ellas —usuario, contraseña, servidor,
  nombre de base ni ruta de socket—, manteniendo la regla ya vigente en el núcleo. Criterio
  verificable: cada salida nueva de esta feature tiene una aserción que lo comprueba, en concreto
  las anotaciones del corte (inicio, resumen y recuperación), las del aviso degradado, el informe
  de salud con el estado nuevo y los tres motivos nuevos de la comprobación de copias.
- **FR-013**: La página del chat web MUST llevar consigo la forma de contacto desde el momento en
  que se carga, de modo que la interfaz pueda mostrarla sin pedir nada más al servidor. Si al cargar
  la página no se puede leer la información del negocio, el contacto que viaja es el teléfono de
  emergencia de la instancia.
- **FR-014**: Durante un corte, la instancia MUST registrar una vez el inicio del corte y una vez
  su recuperación, agrupando los fallos de conexión repetidos del intervalo en lugar de registrar
  uno por cada conexión o cada reintento. El volumen del registro MUST NOT crecer con el número de
  peticiones ni con la duración del corte.

### Key Entities

- **Agrupación de conexiones**: el conjunto de conexiones abiertas que una instancia mantiene contra
  su base de datos. Tiene dos: la general (panel, recepción de mensajes, derivaciones, copias) y la
  de las lecturas públicas del chat. Las dos están afectadas.
- **Dirección de base de datos**: cómo se nombra una base de datos. Tres formas en uso, que se
  agrupan en dos familias según cómo las interpreta el código:
  - **Por nombre de servidor** (`postgres://usuario:clave@servidor:puerto/base`): la de los
    entornos de desarrollo y pruebas. La interpretan bien todas las herramientas.
  - **Sin nombre de servidor, con autoridad vacía**
    (`postgres://usuario:clave@/base?host=…&port=…`): el servidor viaja como parámetro. Es la
    forma que rompe el intérprete de direcciones estándar y, por tanto, la raíz del fallo 2. Se
    puede construir y probar en cualquier sistema operativo, incluso apuntando a un servidor por
    TCP.
  - **Sin nombre de servidor, con ruta de socket Unix** (`host=/var/run/postgresql`): la del
    despliegue de producción. Es la forma literal de producción y comparte con la anterior el
    mismo defecto de interpretación, pero solo se puede ejercitar en sistemas que admiten sockets
    Unix.

  Cuando esta spec dice «direcciones por socket local» o «sin nombre de servidor» se refiere a las
  dos últimas: las dos tienen la autoridad vacía y las dos deben admitirse.
- **Base de datos temporal de verificación**: la que se crea para restaurar una copia y comprobarla,
  y se borra al terminar. Vive en una agrupación distinta de la de producción.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Con la base de datos parada, el cliente final recibe respuesta con contacto en menos
  de 10 segundos desde que envía el mensaje, en los dos canales (chat web y WhatsApp), con la
  cadencia de FR-002: en el chat web, el 100 % de los envíos obtiene respuesta; por WhatsApp, el
  primer mensaje de cada cliente en cada corte obtiene el aviso, y los siguientes del mismo corte
  no generan mensajes salientes adicionales.
- **SC-002**: Una instancia sobrevive a un corte de su base de datos sin reiniciarse ni una sola
  vez, ni por la caída de sus conexiones ni por su comprobación de salud. Umbrales comprobables:
  en la prueba de integración, un corte que abarque al menos dos ciclos del sondeo de salud y una
  petición de cada canal; en el escenario de producción, un corte de al menos 5 minutos con la
  sonda del contenedor activa. Nada en el diseño hace que la duración importe —no hay contador
  que se agote ni memoria que crezca—, y de eso responde SC-008.
- **SC-003**: Al volver la base de datos, la instancia vuelve a atender con normalidad en menos de
  30 segundos, sin intervención del operador y sin que las sesiones del panel se pierdan.
- **SC-004**: La comprobación de una copia de seguridad da «restaurable» en las dos instancias de
  producción, que es la casilla que quedó bloqueada en la fase 9.
- **SC-005**: El chat nunca queda indicando espera indefinidamente: ante cualquier fallo, la
  interfaz termina en un aviso con contacto.
- **SC-006**: Las dos pruebas de regresión fallan si se revierte su corrección correspondiente.
  Criterio de que las pruebas sirven de verdad.
- **SC-007**: Las pruebas cubren las tres formas de dirección de base de datos, no solo la de
  nombre de servidor: la de nombre de servidor y la de autoridad vacía con el servidor en un
  parámetro, en cualquier sistema operativo; la de ruta de socket Unix, en los sistemas que la
  admiten y, obligatoriamente, en el escenario de producción de SC-004.
- **SC-008**: Un corte de una hora deja en el registro un número de anotaciones acotado —el inicio,
  la recuperación y los resúmenes del intervalo—, no una por petición fallida.

## Assumptions

- **El arranque sin base de datos sigue terminando el proceso.** No se convierte en un arranque
  degradado: una instancia que no puede aplicar sus migraciones no puede servir. Lo que cambia es
  el comportamiento de una instancia **ya en marcha**.
- **Se incluye la corrección de la interfaz del chat** (User Story 3) aunque sea un defecto
  independiente: sin ella, el síntoma visible para el cliente final —el «escribiendo…» eterno—
  seguiría apareciendo ante cualquier otro fallo del servidor. Se mantiene en P2 para que pueda
  separarse si estorba.
- **No se cambia ningún formato de dirección de base de datos ni ningún entorno existente.** Las
  dos instancias desplegadas no necesitan tocar sus ficheros de configuración: los fallos son de
  código.
- **No hay migración de base de datos** en esta corrección, así que no cambia la versión del formato
  de transferencia de configuración.
- **Sale la versión 0.1.1 del núcleo**, con imagen nueva y actualización de las dos instancias
  desplegadas, lo que sirve además de primera prueba real del ciclo de actualización sobre
  instancias en producción.
- **Las pruebas de integración ya levantan PostgreSQL en un contenedor**, así que parar un
  contenedor en mitad de una prueba es posible sin infraestructura nueva. La prueba del corte usa
  uno propio y aislado (FR-010), para que pararlo no afecte a las demás pruebas de integración.
- **Al terminar se repiten las dos casillas bloqueadas de la fase 9** del plan de despliegue: la
  comprobación de copias y el teléfono de emergencia mostrado por el bot.
