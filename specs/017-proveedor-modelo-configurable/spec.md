# Feature Specification: Proveedor del modelo configurable por instancia

**Feature Branch**: `017-proveedor-modelo-configurable`

**Created**: 2026-10-13

**Status**: Draft

**Ámbito**: Núcleo (afecta a todas las instancias)

**Input**: User description: "Proveedor del modelo configurable por instancia: Anthropic, Gemini u OpenAI. Spec de NÚCLEO. Cada instancia declara su proveedor en su fichero de entorno y aporta solo la clave del proveedor que declara; la costura queda en un punto único del dominio. Decidir por proveedor qué se conserva, qué se traduce y qué se degrada. Cerrar el agujero de la clave que no corresponde al proveedor. Evaluación obligatoria por proveedor."

## Contexto

Hoy el chatbot solo sabe hablar con un proveedor de modelo. Esto ata cada instancia a ese proveedor
y a su facturación, y deja al operador sin respuesta ante tres situaciones reales: un cliente que ya
tiene contrato con otro proveedor, un proveedor que sube precios o cambia condiciones, y un corte
prolongado de un proveedor sin alternativa.

La decisión de poder elegir proveedor se tomó el 2026-10-12 y quedó anotada en el
[plan de despliegue](../../docs/plan-despliegue-produccion.md) §6. Los tres proveedores elegibles
son **Anthropic**, **Gemini** y **OpenAI**.

### Lo que esta feature encuentra hecho

El dominio **ya tiene la costura correcta**: un puerto de modelo de conversación que el resto del
dominio consume sin saber quién responde, y un adaptador concreto detrás. El verificador de
respuestas, el bucle de reintento con observaciones y la regla de «solo información registrada»
trabajan sobre la respuesta ya normalizada, no sobre la del proveedor.

### Los tres problemas que esta feature resuelve

**Problema 1 · La elección del proveedor está filtrada por todo el programa.** El nombre de la
variable que guarda la credencial aparece en 15 ficheros del núcleo y en 28 de las pruebas: en la
validación del entorno, en las cinco órdenes de aprovisionamiento, en el panel de operador, en el
arranque, en la orden de hablar con el bot por terminal, en el canal web y en el cálculo de si el
bot puede atender. Añadir un proveedor hoy obliga a tocar todos esos sitios.

**Problema 2 · Los parámetros del proveedor actual no tienen equivalente exacto en los otros.** El
adaptador actual usa razonamiento interno automático, un mando de esfuerzo de tres posiciones, una
salida obligada a un esquema, marcas de caché en los bloques de sistema y una señal propia de
rechazo. Ninguna de esas cinco cosas se traslada tal cual a los otros dos proveedores. Tampoco se
traslada tal cual lo que cuenta el medidor de consumo: los tokens de escritura y de lectura de
caché.

**Problema 3 · Una credencial equivocada no se detecta hasta que falla delante del cliente.** La
comprobación previa al despliegue valida que la variable de la credencial **exista** y que tenga
calidad suficiente, pero no que la credencial **sea del proveedor que la instancia va a usar**. Una
credencial de un proveedor puesta en la variable de otro pasa la comprobación, el despliegue se da
por bueno, y la instancia empieza a rechazar **todas** las respuestas con un error de autorización.
El cliente final no ve un error: ve la respuesta degradada, una y otra vez, y nadie se entera hasta
revisar el registro. Es el fallo más grave de los tres porque pasa la puerta de calidad actual.

### Lo que esta feature NO hace

- No cambia a ningún cliente de proveedor. Deja la elección disponible; las instancias en producción
  siguen con el proveedor que tienen.
- No reparte una misma conversación entre varios proveedores, ni cambia de proveedor en caliente,
  ni hace reserva automática ante un corte. Una instancia, un proveedor, declarado en su entorno.
- No cambia el modelo de transcripción de audio: tiene su propia variable y su propio proveedor, y
  queda fuera del alcance.
- No cambia la tabla de precios ni su clave, y no sube la versión del formato de configuración del
  negocio.

## Clarifications

### Session 2026-10-13

- Q: Cuando la credencial es del proveedor correcto y está bien formada, pero el proveedor la
  rechaza (revocada, caducada, sin saldo o sin permisos), ¿qué hace la instancia? → A: comprobación
  al arrancar **no fatal**: la instancia arranca, y si el proveedor rechaza la credencial queda en
  degradado declarado (solo contacto del negocio) con aviso crítico y reintento periódico. Si la
  comprobación no concluye, no hay veredicto y se arranca con normalidad, igual que FR-030a.
- Q: ¿Qué severidad tiene el aviso de que hubo consumo no medido? → A: crítico solo cuando el tope
  de gasto está activado y el negocio está activo —entonces hay una protección que deja de poder
  garantizarse—; en los demás casos, aviso normal.
- Q: ¿Puede cumplirse el registro del consumo no medido sin tocar la base de datos? → A: no. Lleva
  una migración de **solo añadir** que permite distinguir una respuesta no medida de una respuesta
  de consumo cero. No sube `formatVersion`, porque el registro de consumo no es configuración del
  negocio.
- Q: ¿Las pruebas automáticas necesitan credenciales reales de los tres proveedores? → A: no. La
  suite completa corre sin red y sin credenciales, con respuestas preparadas por proveedor. Las
  credenciales reales solo las necesita la evaluación, que ya vive fuera de la suite y tiene coste.
- Q: ¿Cómo muestra el panel un concepto del que el proveedor no informa, sin revelar quién es? →
  A: distinguiendo «sin dato» de cero, con una nota genérica que dice que el modelo configurado no
  informa de ese concepto y sin nombrar al proveedor; los totales no suman lo no informado como
  cero.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dar de alta una instancia con el proveedor elegido (Priority: P1)

El operador da de alta una instancia nueva declarando en su fichero de entorno qué proveedor va a
usar y aportando **solo** la credencial de ese proveedor. La instancia arranca, el bot contesta a
los clientes por todos sus canales, y nada en el panel de operador, en los canales ni en la
información pública de la instancia revela qué proveedor hay detrás.

**Why this priority**: es la razón de ser de la feature. Sin esto no hay nada que probar.

**Independent Test**: se prueba de punta a punta levantando una instancia con cada uno de los tres
proveedores declarados y manteniendo una conversación completa por el canal web: misma cadena de
respuesta, mismas garantías, misma forma de respuesta.

**Acceptance Scenarios**:

1. **Given** un entorno que declara un proveedor elegible y aporta su credencial, **When** la
   instancia arranca y un cliente pregunta por un dato registrado del negocio, **Then** recibe la
   respuesta con ese dato, igual que con cualquier otro proveedor.
2. **Given** una instancia con cualquiera de los tres proveedores, **When** el cliente pide hablar
   con una persona, **Then** la derivación funciona con el mecanismo configurado para el negocio
   (Principio V).
3. **Given** una instancia con cualquiera de los tres proveedores, **When** el cliente pregunta
   algo que el negocio no tiene registrado, **Then** el bot reconoce la falta de información y
   ofrece el contacto, sin inventar (Principio IV).
4. **Given** una instancia en marcha, **When** el operador abre cualquier pantalla del panel,
   **Then** no aparece el nombre del proveedor en ningún sitio.
5. **Given** el entorno de una instancia anterior a esta versión, que **no** declara proveedor,
   **When** la instancia arranca, **Then** funciona exactamente como antes, sin tocar su entorno.

---

### User Story 2 - La comprobación previa descubre una credencial que no corresponde (Priority: P1)

El operador declara un proveedor y pega por error la credencial de otro. La comprobación previa al
despliegue lo dice **antes** de desplegar, con el nombre de la variable y qué hacer, y marca el
entorno como no apto.

**Why this priority**: es el agujero que esta spec existe para cerrar. Sin él, la elección de
proveedor multiplica por tres la probabilidad de un despliegue que falla en silencio.

**Independent Test**: se prueba pasando la comprobación sobre entornos preparados donde la
credencial pertenece a un proveedor distinto del declarado, y comprobando que el resultado es no
apto y que el mensaje nombra la variable sin mostrar su valor.

**Acceptance Scenarios**:

1. **Given** un entorno que declara un proveedor y aporta una credencial reconocible como de otro
   proveedor elegible, **When** el operador pasa la comprobación, **Then** el resultado es **no
   apto** con un error que nombra la variable, dice a qué proveedor parece pertenecer la credencial
   y qué hacer, sin mostrar ningún carácter de la credencial.
2. **Given** un entorno con la credencial correcta para su proveedor, **When** el operador pasa la
   comprobación sin red, **Then** la comprobación termina sin red, como hasta ahora, y no inventa
   un veredicto sobre la validez de la credencial.
3. **Given** un entorno que declara un proveedor y aporta además credenciales de otros proveedores
   que no se van a usar, **When** el operador pasa la comprobación, **Then** recibe un aviso por
   cada credencial sobrante, porque es un secreto vivo que nadie usa.
4. **Given** un entorno que declara un proveedor no elegible o escrito con un error, **When** la
   instancia arranca o el operador pasa la comprobación, **Then** el fallo dice qué proveedores son
   elegibles y la instancia no arranca con un proveedor a medias.
5. **Given** un entorno cuya credencial el proveedor declarado rechaza, **When** el operador pide la
   validación con llamada real y el proveedor contesta rechazándola, **Then** el resultado es **no
   apto**.
6. **Given** una máquina sin red, **When** el operador pide la validación con llamada real,
   **Then** el entorno sigue **apto** con un aviso de que no se pudo validar, distinguible del caso
   en que la validación no se pidió, y el despliegue no queda bloqueado por la falta de red.
7. **Given** una instancia cuya credencial es del proveedor correcto pero el proveedor la rechaza
   (revocada, caducada, sin saldo), **When** la instancia arranca, **Then** arranca sin entrar en
   bucle de reinicio, queda en degradado declarado con solo el contacto del negocio, y el operador
   tiene un aviso crítico. **And** cuando la credencial vuelve a ser aceptada, la instancia sale del
   degradado por sí sola, sin intervención.
8. **Given** una instancia que arranca sin red, **When** la comprobación del arranque no concluye,
   **Then** la instancia arranca con normalidad, no queda degradada, y el hecho queda registrado.

---

### User Story 3 - El consumo y el tope de gasto siguen midiendo con cualquier proveedor (Priority: P2)

El operador ve en el panel el consumo y el gasto de su instancia, y el tope de gasto sigue
protegiéndole, sea quien sea el proveedor. Cuando el proveedor no informa de algo que el medidor
cuenta, el panel lo dice en lugar de dar por bueno un cero.

**Why this priority**: el tope de gasto es la protección que impide que una instancia se coma el
presupuesto del cliente. Degradarlo en silencio sería peor que no tenerlo.

**Independent Test**: se prueba con respuestas preparadas de cada proveedor, comprobando qué queda
registrado y qué avisos salen cuando faltan datos de consumo.

**Acceptance Scenarios**:

1. **Given** una instancia con cualquiera de los tres proveedores, **When** el bot responde,
   **Then** quedan registrados los tokens de entrada y de salida de esa respuesta y su coste
   congelado con el precio vigente del modelo.
2. **Given** un proveedor que no informa de la escritura de caché, **When** el operador abre la
   pantalla de consumo, **Then** ese concepto aparece como **sin dato**, no como cero, con una nota
   que no nombra al proveedor, y los totales no lo suman como cero.
3. **Given** una respuesta que llega sin ninguna información de consumo, **When** el bot la
   entrega, **Then** la respuesta se entrega igual, queda registrada como **no medida** y
   distinguible de una de consumo cero, y el operador recibe un aviso: **crítico** si el tope de
   gasto está activado y el negocio está activo, normal en los demás casos.
4. **Given** un operador que cambia el proveedor de una instancia a otro cuyo modelo no tiene
   precio registrado, **When** vuelve a arrancar, **Then** salta el aviso de «modelo sin precio»
   que ya existe y los clientes reciben solo el contacto del negocio, hasta que registre el precio.

---

### User Story 4 - Las diferencias entre proveedores están declaradas, no escondidas (Priority: P2)

El operador sabe, para cada proveedor elegible, qué se conserva igual, qué se traduce a su
equivalente y qué no existe y se degrada. No tiene que deducirlo de un comportamiento raro.

**Why this priority**: sin esa tabla escrita, cada diferencia entre proveedores se convierte en una
incidencia de soporte que nadie sabe explicar.

**Independent Test**: se prueba leyendo la documentación de operación y comprobando que, para cada
fila de la tabla y cada proveedor, existe una prueba que fija el comportamiento declarado.

**Acceptance Scenarios**:

1. **Given** un proveedor sin mando de esfuerzo equivalente, **When** la instancia arranca con un
   esfuerzo declarado, **Then** el arranque deja constancia de que ese ajuste no tiene efecto con
   ese proveedor, y el valor no se rechaza ni se silencia.
2. **Given** cualquiera de los tres proveedores, **When** la respuesta no encaja en la forma que el
   dominio exige, **Then** no llega nunca al cliente final: se reintenta con observaciones y, si
   vuelve a fallar, se responde de forma degradada con el contacto del negocio.
3. **Given** cualquiera de los tres proveedores, **When** el proveedor rechaza atender, agota el
   plazo, devuelve algo inservible o falla por su lado, **Then** el dominio recibe una de las
   cuatro causas de fallo que ya conoce, sin que su vocabulario crezca por proveedor.

---

### User Story 5 - Ningún proveedor se declara elegible sin haber superado la evaluación (Priority: P3)

Antes de que un proveedor quede disponible para los clientes, la evaluación con el modelo real se ha
pasado **con ese proveedor** y su resultado está anotado.

**Why this priority**: el ajuste de esfuerzo se calibró contra un modelo concreto. Dar por elegible
un proveedor sin medirlo es prometer una calidad que nadie ha comprobado.

**Independent Test**: se prueba comprobando que existe un resultado de evaluación anotado por cada
proveedor declarado elegible, con su fecha, su modelo y su ajuste de esfuerzo.

**Acceptance Scenarios**:

1. **Given** los tres proveedores, **When** se cierra la feature, **Then** hay un resultado de
   evaluación por proveedor, con el modelo y el esfuerzo con los que se obtuvo.
2. **Given** un proveedor que no alcanza el criterio con el esfuerzo por defecto, **When** se le da
   un esfuerzo propio razonado y se reevalúa, **Then** o alcanza el criterio y queda elegible con su
   esfuerzo documentado, o no lo alcanza y queda **no elegible** en esta versión.
3. **Given** los proveedores finalmente elegibles, **When** se consulta la documentación de
   operación, **Then** cada uno tiene escrito su ajuste de esfuerzo por defecto y el resultado de
   evaluación que lo justifica.

---

### Edge Cases

- **Proveedor declarado sin su credencial, pero con la de otro presente**: la instancia no arranca
  y el fallo nombra la variable que falta. No se usa la credencial del otro proveedor.
- **Credencial revocada mientras la instancia está en marcha**: las respuestas empiezan a fallar por
  autorización. El reintento periódico de FR-005b vuelve a comprobarla, la instancia pasa a
  degradado declarado y el aviso crítico aparece sin necesidad de reiniciar.
- **El proveedor rechaza la credencial al arrancar y sigue rechazándola**: la instancia se queda en
  degradado indefinidamente, con el aviso crítico en pie, y reintenta **cada 5 minutos**. Son como
  mucho 288 peticiones al día que no generan tokens, y acotan la recuperación automática a 5 minutos
  después de arreglar la credencial. Deja **una** línea de registro al entrar en degradado y **una**
  al salir, nunca una por petición.
- **Entorno sin proveedor declarado y sin ninguna credencial**: se comporta exactamente como hoy un
  entorno sin credencial del modelo, incluida la regla de que el canal de mensajería la exige.
- **Credencial de un proveedor no elegible**: no se reconoce su forma; se trata como credencial del
  proveedor declarado y la validación de forma no la rechaza por no reconocerla. Solo se rechaza lo
  que es reconociblemente de **otro proveedor elegible**.
- **Comprobación de huellas entre instancias**: la reutilización de la misma credencial del modelo
  en dos instancias se sigue detectando aunque cada una la guarde en una variable de nombre
  distinto.
- **El proveedor deja de informar de los tokens de caché a mitad de un periodo**: el periodo queda
  con una parte medida y otra no; el panel no mezcla ambas como si fueran lo mismo.
- **Dos proveedores con un modelo del mismo nombre**: el precio se guarda por nombre de modelo. Si
  ocurriera, el precio registrado se aplicaría a los dos; queda anotado como riesgo conocido y sin
  caso real entre los tres proveedores elegibles.
- **Nombre de modelo que no corresponde al proveedor declarado**: el proveedor lo rechaza. El fallo
  debe llegar como un fallo del proveedor identificable, no como una respuesta inservible.
- **Transferencia de configuración entre instancias con proveedores distintos**: la configuración
  del negocio no incluye el proveedor ni el modelo, así que se transfiere igual; los precios
  registrados del proveedor de origen quedan como entradas sin uso y el modelo de destino aparece
  sin precio hasta que el operador lo registre.
- **Cambio de proveedor en una instancia viva**: el consumo y el coste ya registrados no se
  recalculan nunca. El histórico conserva el coste congelado con el precio del modelo de entonces.

## Requirements *(mandatory)*

### Functional Requirements

**Elección del proveedor**

- **FR-001**: El sistema MUST permitir que cada instancia declare en su fichero de entorno cuál de
  los tres proveedores elegibles usa.
- **FR-002**: El sistema MUST aceptar como elegibles exactamente Anthropic, Gemini y OpenAI, y MUST
  rechazar cualquier otro valor en el arranque y en la comprobación previa, nombrando los
  elegibles.
- **FR-003**: Una instancia que no declara proveedor MUST comportarse como si declarase Anthropic,
  para que los entornos anteriores a esta versión funcionen sin tocarlos.
- **FR-004**: El sistema MUST leer la credencial del proveedor declarado y MUST NOT usar la de
  ningún otro, ni aunque esté presente.
- **FR-005**: Si falta la credencial del proveedor declarado, el sistema MUST fallar con la misma
  claridad con la que hoy falla al faltar la credencial del modelo, nombrando la variable.
- **FR-005a**: Al arrancar, el sistema MUST comprobar contra el proveedor declarado que la
  credencial es aceptada, con la petición más barata que el proveedor admita. Esa comprobación MUST
  NOT ser fatal: la instancia arranca en cualquier caso y MUST NOT quedar en bucle de reinicio por
  ella.
- **FR-005b**: Si el proveedor **rechaza** la credencial al arrancar, la instancia MUST quedar en
  degradado declarado —los clientes reciben solo el contacto del negocio, como con el modelo sin
  precio—, MUST levantar un aviso crítico para el operador y MUST reintentar la comprobación
  periódicamente, saliendo del degradado por sí sola cuando la credencial pase a ser aceptada.
- **FR-005c**: Si la comprobación del arranque **no concluye** —no hay red, el proveedor no responde
  o falla por algo que no es un rechazo de la credencial—, el sistema MUST arrancar con normalidad y
  MUST NOT degradar la instancia ni dar la credencial por mala. El hecho MUST quedar registrado.
- **FR-006**: La decisión de proveedor MUST quedar en un punto único del dominio. El panel de
  operador, los adaptadores de canal, el cálculo de si el bot puede atender y la información de
  estado de la instancia MUST NOT depender de qué proveedor hay detrás.
- **FR-007**: La información de estado que la instancia publica por red MUST NOT revelar el
  proveedor.
- **FR-008**: El panel de operador MUST NOT mostrar el nombre del proveedor en ninguna pantalla.
- **FR-009**: El inventario de instancias MUST registrar el proveedor declarado de cada instancia, y
  MUST NOT registrar ninguna credencial.
- **FR-010**: Las órdenes de aprovisionamiento y la orden de hablar con el bot por terminal MUST
  funcionar con cualquiera de los tres proveedores, sin pedir el nombre de una variable concreta.
- **FR-011**: Las reglas de calidad de secretos MUST aplicarse a la credencial del proveedor
  declarado, cualquiera que sea el nombre de su variable.
- **FR-012**: La detección de secretos reutilizados entre instancias MUST reconocer la credencial
  del modelo como el mismo secreto aunque las instancias comparadas declaren proveedores distintos.

**Comportamiento del modelo por proveedor**

- **FR-013**: El dominio MUST seguir recibiendo la respuesta del modelo en una única forma, válida
  frente al esquema del dominio, sea quien sea el proveedor.
- **FR-013a**: Todo uso del proveedor MUST quedar cubierto, no solo la respuesta al cliente. En
  particular, el resumen que se envía al negocio al derivar una conversación MUST funcionar con los
  tres proveedores: una instancia MUST NOT poder conversar con un proveedor y fallar justo al
  derivar a una persona, porque esa es la salida que garantiza el Principio V.
- **FR-014**: El sistema MUST garantizar esa forma con los medios que el proveedor ofrezca y MUST
  revalidarla siempre en el dominio. Una respuesta que no valida MUST NOT llegar nunca al cliente
  final.
- **FR-015**: El bucle de reintento con observaciones y la respuesta degradada con el contacto del
  negocio MUST funcionar igual con los tres proveedores.
- **FR-016**: Cada proveedor MUST traducir sus fallos a las cuatro causas que el dominio ya conoce
  —plazo agotado, rechazo, salida inservible y fallo del proveedor—. El vocabulario de causas del
  dominio MUST NOT crecer por proveedor.
- **FR-017**: El sistema MUST traducir el ajuste de esfuerzo del dominio al equivalente más cercano
  de cada proveedor. Donde el proveedor no tenga equivalente, el ajuste MUST quedar sin efecto de
  forma declarada, dejando constancia en el arranque, y MUST NOT rechazarse ni silenciarse.
- **FR-018**: El sistema MUST usar el razonamiento interno del proveedor donde exista y MUST
  funcionar sin él donde no exista, sin que eso cambie la forma de la respuesta.
- **FR-019**: El sistema MUST usar la caché de contexto del proveedor donde exista y MUST funcionar
  sin ella donde no exista.
- **FR-020**: El sistema MUST mantener el plazo máximo de respuesta y la política de reintento de
  red en términos del dominio, no de cada proveedor.
- **FR-021**: El comportamiento conservado, traducido y degradado de cada proveedor MUST quedar
  escrito en la documentación de operación, y cada fila de esa tabla MUST tener prueba.

**Consumo, coste y tope de gasto**

- **FR-022**: El medidor de consumo MUST registrar los tokens de entrada y de salida de cada
  respuesta con los tres proveedores.
- **FR-023**: El medidor MUST NOT depender de los tipos ni de la forma de respuesta de ningún
  proveedor concreto.
- **FR-024**: Donde el proveedor no informe de la escritura o de la lectura de caché, el panel MUST
  mostrar ese concepto como **sin dato**, distinguible de un cero medido, con una nota genérica que
  diga que el modelo configurado no informa de él y que MUST NOT nombrar al proveedor. Los totales
  MUST NOT sumar lo no informado como cero, y el panel MUST NOT presentarlo como un ahorro
  conseguido.
- **FR-025**: Si una respuesta llega sin ninguna información de consumo, el sistema MUST entregarla
  al cliente, MUST registrar que hubo consumo no medido y MUST avisar al operador de que el tope de
  gasto no puede garantizarse.
- **FR-025a**: Ese aviso MUST ser **crítico** cuando el tope de gasto está activado y el negocio
  está activo, porque es entonces cuando hay una protección que deja de poder garantizarse. En los
  demás casos MUST ser un aviso normal. Este aviso nace de una respuesta del bot, no de una
  escritura del operador, así que MUST NOT revertir ninguna escritura ni impedir que el operador
  siga trabajando: es una alarma, no un bloqueo. La regla que revierte una escritura cuando deja a
  un negocio activo con un aviso crítico se aplica a las escrituras de configuración del negocio, y
  esta no es una.
- **FR-025b**: El registro MUST permitir distinguir una respuesta **no medida** de una respuesta de
  consumo **cero**. Esto MUST conseguirse con una migración de solo añadir, sin tocar ni reescribir
  lo ya registrado.
- **FR-026**: El precio MUST seguir registrándose por nombre de modelo, y el coste MUST seguir
  congelándose en el momento del consumo. El histórico MUST NOT recalcularse al cambiar de
  proveedor.
- **FR-027**: El aviso de «modelo sin precio» y su degradación a solo contacto del negocio MUST
  seguir funcionando igual con cualquier proveedor.

**Comprobación previa al despliegue**

- **FR-028**: La comprobación previa MUST validar, sin red, que la forma de la credencial aportada
  no corresponde reconociblemente a un proveedor elegible distinto del declarado. Si corresponde a
  otro, el resultado MUST ser no apto.
- **FR-029**: La comprobación previa MUST poder validar la credencial contra el proveedor declarado
  con una llamada real, y esa validación MUST ser una petición explícita del operador, nunca el
  comportamiento por defecto: la comprobación MUST seguir siendo local y sin red si no se le pide
  otra cosa. Esto se refiere a la herramienta de comprobación previa, que es local por naturaleza;
  la instancia en marcha sí comprueba su credencial siempre al arrancar (FR-005a), y las dos cosas
  son independientes.
- **FR-030**: Cuando la validación con llamada real es concluyente y el proveedor rechaza la
  credencial, el resultado MUST ser **no apto**.
- **FR-030a**: Cuando se pide la validación con llamada real y no se puede concluir —no hay red, el
  proveedor no responde o responde con un fallo que no es un rechazo de la credencial—, la
  comprobación MUST decir que no pudo validar, MUST dejarlo como **aviso** y MUST NOT dar la
  credencial por buena ni por mala. El entorno sigue **apto**: la red es una ayuda de la
  comprobación, nunca un requisito para desplegar, y el fallo que esta feature existe para cerrar
  ya lo bloquea sin red (FR-028). El aviso MUST distinguirse del caso en que no se pidió la
  validación, para que «no se comprobó» y «no se pudo comprobar» no se confundan.
- **FR-031**: Toda validación de credencial con llamada real MUST usar la petición más barata que el
  proveedor admita y MUST NOT consumir presupuesto del cliente de forma apreciable. Esto aplica a
  los **dos** sitios que validan: la comprobación previa (FR-029) y la comprobación del arranque
  (FR-005a), incluidos sus reintentos.
- **FR-032**: Ningún mensaje de la comprobación MUST mostrar ningún carácter de ninguna credencial.
  (Este identificador es de esta spec; no confundirlo con el FR-032 que otras specs del proyecto
  usan para la regla de reversión por aviso crítico.)
- **FR-033**: La comprobación MUST avisar de cada credencial de otro proveedor elegible presente en
  el entorno y no utilizada.
- **FR-034**: La comprobación MUST seguir sin escribir nada en el entorno ni en el inventario.

**Evaluación y puesta en producción**

- **FR-035**: La evaluación con el modelo real MUST pasarse por cada proveedor declarado elegible
  antes de cerrar la feature, y su resultado MUST quedar anotado con el proveedor, el modelo, el
  ajuste de esfuerzo y la fecha.
- **FR-036**: Un proveedor que no alcance el criterio de la evaluación con el ajuste de esfuerzo por
  defecto MUST recibir un ajuste de esfuerzo propio, escrito y razonado, y MUST volver a evaluarse
  con él. Si tras el ajuste sigue sin alcanzar el criterio, ese proveedor MUST NOT declararse
  elegible en esta versión.
- **FR-036a**: El ajuste de esfuerzo por defecto de cada proveedor MUST quedar escrito en la
  documentación de operación junto al resultado de evaluación que lo justifica, para que se sepa
  que el mismo ajuste del dominio no significa lo mismo en los tres proveedores.
- **FR-037**: Esta feature MUST NOT cambiar la versión del formato de configuración, porque no
  cambia ninguna configuración del negocio. Su única migración MUST ser la de solo añadir que exige
  FR-025b, sobre el registro de consumo, que no es configuración del negocio.
- **FR-038**: La suite de pruebas MUST correr completa sin red y sin ninguna credencial real, con
  respuestas preparadas por proveedor, y MUST cubrir así los tres proveedores. Solo la evaluación
  con el modelo real MUST requerir credenciales reales, y MUST seguir viviendo fuera de la suite.

### Key Entities

- **Proveedor del modelo**: el proveedor que una instancia usa para conversar. Uno de los tres
  elegibles. Vive en el entorno de la instancia y se registra en el inventario. No es configuración
  del negocio y no se transfiere entre instancias.
- **Credencial del proveedor**: el secreto que autoriza a la instancia ante su proveedor. Uno por
  instancia: el del proveedor declarado. Nunca se muestra, nunca se registra en el inventario y
  nunca sale en un mensaje.
- **Capacidades del proveedor**: lo que cada proveedor conserva, traduce o no tiene respecto de lo
  que el dominio pide —forma de la respuesta, esfuerzo, razonamiento interno, caché de contexto,
  señal de rechazo e información de consumo—. Es la tabla que FR-021 obliga a escribir.
- **Consumo de una respuesta**: los tokens de entrada, de salida, de escritura y de lectura de
  caché de una respuesta, más el estado «no medido» que esta feature añade.
- **Resultado de la comprobación previa**: el veredicto apto o no apto de un entorno, con sus
  errores y sus avisos. Esta feature le añade los hallazgos de credencial que no corresponde,
  credencial sobrante y validación no concluyente.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Una instancia nueva queda atendiendo clientes con cualquiera de los tres proveedores
  cambiando **solo** su fichero de entorno, sin tocar ni una línea de código ni construir una
  imagen distinta.
- **SC-002**: Las cinco garantías de la conversación —dato registrado, falta de dato reconocida,
  salida a una persona, respuesta degradada y reintento con observaciones— se cumplen con los tres
  proveedores, verificadas por prueba.
- **SC-003**: Una credencial que no corresponde al proveedor declarado se detecta **antes** de
  desplegar en el 100 % de los casos en los que la credencial es reconociblemente de otro proveedor
  elegible, sin necesidad de red.
- **SC-004**: Ninguna credencial aparece, ni entera ni parcial, en ningún mensaje, registro o
  salida, con los tres proveedores.
- **SC-005**: El consumo y el coste quedan registrados en el 100 % de las respuestas en las que el
  proveedor informa de tokens, y el 100 % de las respuestas sin información de consumo quedan
  marcadas como no medidas en lugar de como consumo cero.
- **SC-006**: El operador no puede saber, desde el panel ni desde la información que la instancia
  publica por red, qué proveedor hay detrás.
- **SC-007**: Existe un resultado de evaluación anotado por cada proveedor declarado elegible, con
  su modelo, su esfuerzo y su fecha; y ningún proveedor queda elegible sin ese resultado.
- **SC-008**: Una búsqueda en el núcleo del nombre de la variable de credencial de un proveedor
  concreto solo la encuentra en el punto único de la costura y en su adaptador.
- **SC-009**: La comprobación previa sigue terminando sin red y sin escribir nada cuando no se le
  pide la validación con llamada real.
- **SC-010**: Una credencial que el proveedor rechaza deja de poder pasar inadvertida: el operador
  tiene un aviso crítico desde el arranque, y ningún cliente recibe una respuesta degradada sin que
  ese aviso exista.
- **SC-011**: La suite de pruebas completa pasa en una máquina sin red y sin ninguna credencial
  real, cubriendo los tres proveedores.
- **SC-012**: Ningún concepto de consumo del que el proveedor no informa aparece en el panel como un
  cero, y los totales nunca lo suman como cero.

## Assumptions

- Los tres proveedores elegibles informan de los tokens de entrada y de salida de cada respuesta.
  La respuesta sin información de consumo se trata como un caso excepcional (FR-025), no como el
  comportamiento normal de ninguno de los tres.
- Las credenciales de los tres proveedores tienen formas reconocibles entre sí sin consultar al
  proveedor. Eso es lo que hace posible FR-028 sin red. Si en el plan se comprueba que dos de ellas
  son indistinguibles, FR-028 pierde alcance y la validación con llamada real pasa a ser la única
  defensa; habrá que decirlo entonces.
- Los tres proveedores admiten alguna forma de obligar o inducir una salida estructurada. La
  revalidación en el dominio (FR-014) es la garantía real, así que una salida solo inducida es
  aceptable mientras el reintento con observaciones absorba los fallos sin empeorar la evaluación.
- El modelo de transcripción de audio mantiene su variable y su proveedor actuales. Esta feature no
  lo toca.
- El ajuste de esfuerzo sigue siendo un mando del dominio de tres posiciones, no una lista por
  proveedor. Su traducción por proveedor es asunto del adaptador. Lo que sí puede variar por
  proveedor es **qué posición es la de por defecto**, cuando la evaluación lo exija (FR-036a).
- Los nombres de modelo de los tres proveedores no colisionan entre sí, y por eso la tabla de
  precios puede seguir teniendo el nombre del modelo como clave y sin migración.
- La única migración de la feature es la de FR-025b, sobre el registro de consumo. Al no ser
  configuración del negocio, no obliga a subir la versión del formato ni a escribir un actualizador
  (FR-037). Si en el plan resultase que sí toca configuración del negocio, esa decisión se cae y hay
  que subir la versión del formato.
- Los tres proveedores admiten alguna petición barata que sirva para saber si aceptan la credencial
  sin generar una respuesta completa. Es lo que hacen posibles FR-005a y FR-031. Si algún proveedor
  no la tuviera, su comprobación costaría una respuesta y habría que decidir si merece la pena.
- La elección de proveedor sigue siendo del operador, nunca del negocio (Principio VI).
- El detalle exacto de los parámetros equivalentes de cada proveedor se fija en la investigación del
  plan, no en esta spec. Aquí se fija **qué** comportamiento es obligatorio, no **cómo** lo consigue
  cada proveedor.
