# Feature Specification: Consumo y coste por instancia

**Feature Branch**: `010-usage-cost-cap`

**Created**: 2026-10-01

**Status**: Draft

**Ámbito**: Núcleo

**Input**: User description: "Medir y mostrar en el panel el consumo del modelo por instancia y canal (tokens y coste estimado, sin guardar textos) y permitir un tope mensual de gasto que, al alcanzarse, hace que el bot dé el contacto del negocio en todos los canales. Ámbito: núcleo (propuesta P4 de docs/operacion-multicliente.md)."

## Contexto

Cada instancia paga el modelo de lenguaje por uso. Hoy el operador solo ve cuántas respuestas ha dado
el chat web en el día y en el mes (feature 004), y ese tope cuenta respuestas, no dinero: no sabe
cuántos tokens consume cada instancia ni cuánto cuesta, y WhatsApp no tiene ningún tope. La única red
de seguridad es el límite de gasto del workspace del proveedor de cada cliente, que corta el servicio
en seco: el bot deja de responder sin ofrecer salida al cliente final.

Esta feature añade tres cosas, en este orden de valor:

1. **Medir** el consumo de cada llamada al modelo (tokens y modelo usado), sin guardar textos.
2. **Ver** en el panel el consumo y el coste estimado del día y del mes, por canal, con precios que
   el operador configura.
3. **Limitar** el gasto mensual de la instancia con un tope común a todos los canales que, al
   alcanzarse, hace que el bot deje de llamar al modelo y responda con el contacto del negocio
   (Principio V).

Es la propuesta P4 de [docs/operacion-multicliente.md](../../docs/operacion-multicliente.md). Hace
falta antes de facturar el consumo a un cliente o de activar WhatsApp en un cliente con tráfico
abierto.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cada llamada al modelo queda registrada sin textos (Priority: P1)

Cada vez que la instancia llama al modelo de lenguaje —para responder en WhatsApp, en el chat web o en
"Probar el bot", o para resumir una conversación derivada al negocio— queda un registro con el
momento, el canal, el uso (respuesta o resumen), el modelo y los tokens consumidos. El registro nunca
contiene el texto del cliente final, la respuesta, el teléfono ni ningún otro dato personal.

**Why this priority**: sin medición no hay vista ni tope. Además, por sí sola ya permite al operador
consultar el consumo real de la instancia para facturarlo.

**Independent Test**: enviar mensajes por cada canal y desde "Probar el bot", y comprobar que hay un
registro por cada llamada al modelo con el canal, el modelo y los tokens que informó el proveedor, y
que ningún registro contiene textos ni identificadores del cliente final.

**Acceptance Scenarios**:

1. **Given** un negocio activo, **When** un cliente final escribe por WhatsApp y el bot responde con
   el modelo, **Then** queda registrado el consumo de esa respuesta con canal "WhatsApp", el modelo
   usado y los tokens de entrada y de salida.
2. **Given** una respuesta que necesita varias llamadas al modelo (por ejemplo, un reintento tras
   rechazar una afirmación no registrada), **When** se registra el consumo, **Then** se suman todas
   las llamadas de esa respuesta, no solo la última.
3. **Given** el operador en "Probar el bot", **When** hace una pregunta, **Then** el consumo queda
   registrado como "Probar el bot", separado de los canales de clientes finales.
4. **Given** una conversación derivada al negocio cuyo aviso incluye un resumen hecho con el modelo,
   **When** se genera el resumen, **Then** su consumo queda registrado en el canal de esa conversación
   como uso "resumen de derivación".
5. **Given** una respuesta que no llama al modelo (plantilla fija, mensaje fuera de horario de
   atención, respuesta de tope alcanzado), **When** se envía, **Then** no se registra consumo.
6. **Given** una llamada al modelo que falla o se agota su tiempo, **When** el proveedor ha informado
   de tokens consumidos, **Then** se registran; si no ha informado de ninguno, no se inventa consumo.
7. **Given** cualquier registro de consumo, **When** se inspecciona, **Then** no contiene textos de
   mensajes, teléfonos, identificadores de cliente final, direcciones IP ni identificadores de
   conversación.

---

### User Story 2 - El operador ve el consumo y el coste en el panel (Priority: P2)

En el panel `/admin` de la instancia, una pantalla "Consumo" muestra el consumo del día y del mes en
curso (en la hora local del negocio), desglosado por canal (WhatsApp, chat web, "Probar el bot") y en
total: número de respuestas con modelo, tokens de entrada y de salida, y coste estimado. También
muestra los meses anteriores conservados para poder facturar. El coste se calcula con una tabla de
precios por modelo que el operador mantiene en esa misma pantalla.

**Why this priority**: es lo que el operador necesita para facturar y para detectar un consumo
anómalo antes de que lo corte el proveedor. Depende de la medición (US1).

**Independent Test**: con registros de consumo conocidos de varios canales y días, abrir la pantalla
y comprobar que los totales del día, del mes y de cada canal, y el coste con los precios
configurados, coinciden con un cálculo a mano.

**Acceptance Scenarios**:

1. **Given** consumo registrado hoy en WhatsApp, chat web y "Probar el bot", **When** el operador abre
   "Consumo", **Then** ve por separado el consumo de cada uno, el total de los canales de clientes
   finales y el total de la instancia (que incluye "Probar el bot").
2. **Given** precios configurados para el modelo usado, **When** el operador ve el consumo, **Then**
   el coste estimado de cada fila es la suma de tokens de cada tipo por su precio, con el redondeo
   indicado en la pantalla, y figura la moneda de los precios.
3. **Given** el operador cambia el precio de un modelo, **When** vuelve a ver el consumo, **Then**
   el coste estimado se recalcula con el precio nuevo para todo el periodo mostrado, y la pantalla
   indica que es una estimación con los precios actuales.
4. **Given** consumo de un modelo sin precio configurado, **When** el operador ve el consumo, **Then**
   sus tokens se muestran, su coste figura como "sin precio" (no como cero) y la pantalla avisa de
   qué modelo falta.
5. **Given** un mes anterior conservado, **When** el operador lo elige, **Then** ve su consumo y coste
   por canal y por día.
6. **Given** el negocio en una zona horaria distinta de la del servidor, **When** se muestra "hoy" o
   "este mes", **Then** los límites de día y de mes son los de la hora local del negocio.

---

### User Story 3 - Tope mensual de gasto para toda la instancia (Priority: P3)

El operador fija en el panel un tope mensual de gasto estimado para la instancia, común a todos los
canales. Cuando el gasto del mes lo alcanza, el bot deja de llamar al modelo en WhatsApp y en el chat
web y, a cada mensaje de un cliente final, responde con un mensaje fijo y el contacto del negocio. La
derivación a una persona (feature 005) sigue funcionando. El operador ve el aviso en el panel antes y
después de alcanzarlo, y puede subir el tope o desactivarlo; el cambio vale para el mensaje siguiente.
Al empezar el mes siguiente el bot vuelve a responder con el modelo.

**Why this priority**: es la protección del gasto, pero solo tiene sentido cuando ya se mide y se ve
el coste (US1 y US2). Mientras no esté, el límite del workspace del proveedor sigue siendo la red de
seguridad.

**Independent Test**: fijar un tope bajo, consumir hasta superarlo y comprobar que los mensajes
siguientes por WhatsApp y por el chat web reciben el mensaje fijo con el contacto sin llamar al
modelo, que una petición de hablar con una persona se sigue derivando y que, al subir el tope, el
siguiente mensaje vuelve a responderse con el modelo.

**Acceptance Scenarios**:

1. **Given** un tope mensual fijado y el gasto del mes por debajo, **When** llega un mensaje, **Then**
   el bot responde con normalidad.
2. **Given** el gasto del mes igual o superior al tope, **When** llega un mensaje por WhatsApp,
   **Then** el bot responde sin llamar al modelo con un mensaje fijo que dice que ahora no puede
   atender por este canal y da el contacto del negocio.
3. **Given** el gasto del mes igual o superior al tope, **When** un visitante abre o usa el chat web,
   **Then** ve el mismo estado "no disponible" con el contacto del negocio que ya muestra el chat web
   al alcanzar su tope de respuestas (feature 004).
4. **Given** el tope alcanzado, **When** un cliente final pide hablar con una persona, **Then** la
   petición se reconoce y se deriva al negocio con el mecanismo configurado (feature 005), y la
   respuesta al cliente final se envía igual que sin tope.
5. **Given** el tope alcanzado y una conversación derivada, **When** se avisa al negocio, **Then** el
   aviso se envía sin resumen hecho con el modelo (con el resto de su contenido), y no se registra
   consumo.
6. **Given** el gasto del mes alcanza el 80 % del tope, **When** el operador abre cualquier pantalla
   del panel, **Then** ve un aviso con el porcentaje consumido; al alcanzar el 100 %, el aviso dice
   que el bot está respondiendo solo con el contacto.
7. **Given** el tope alcanzado, **When** el operador sube el tope por encima del gasto del mes o lo
   desactiva, **Then** el siguiente mensaje de un cliente final se responde con el modelo, sin
   reiniciar nada.
8. **Given** el tope alcanzado en un mes, **When** empieza el mes siguiente en la hora local del
   negocio, **Then** el bot vuelve a responder con el modelo.
9. **Given** el tope alcanzado, **When** el operador usa "Probar el bot", **Then** puede seguir
   probando (su consumo cuenta para el gasto del mes) y la pantalla le recuerda que los clientes
   finales están recibiendo solo el contacto.
10. **Given** el tope alcanzado por primera vez en el mes, **When** ocurre, **Then** queda un evento
    en el registro de actividad (sin datos personales) una sola vez por mes.

---

### Edge Cases

- **Varias respuestas a la vez cerca del tope**: la comprobación se hace antes de cada respuesta con
  el gasto ya registrado; una respuesta en curso cuando se alcanza el tope termina y se cuenta. El
  exceso queda limitado a las respuestas simultáneas de ese momento, y el panel muestra el gasto
  real aunque supere el tope.
- **Tope menor que el gasto ya hecho en el mes**: se acepta; el bot pasa a responder con el contacto
  desde el siguiente mensaje y el panel lo indica.
- **Modelo sin precio configurado con el tope activo**: su consumo no tiene coste y no suma al gasto
  del tope. Para que eso no deje la instancia sin protección, el panel muestra un aviso mientras el
  modelo configurado en la instancia no tenga precio y el tope esté activo.
- **El modelo cambia a mitad de mes** (otro valor en el entorno): cada registro conserva su modelo y
  se valora con su propio precio.
- **Precio cambiado a mitad de mes**: el coste mostrado y el gasto del tope se calculan con el precio
  vigente para todo el mes (estimación), no con el histórico. Se indica en la pantalla.
- **El proveedor no informa de tokens** (error antes de procesar): no se registra consumo.
- **Instancia sin clave del modelo** (sin bot): no hay consumo ni tope que aplicar; la pantalla lo
  muestra vacío.
- **Tope del chat web (004) y tope de gasto a la vez**: se aplican los dos; el chat web deja de
  atender cuando se alcanza cualquiera de ellos, con el mismo estado "no disponible".
- **Negocio en preparación**: los canales de clientes finales ya no atienden (features 002 y 004);
  "Probar el bot" sí consume y se registra.
- **Restauración de una copia** (feature 006): los registros de consumo vuelven con la base de datos;
  el gasto del mes es el de los registros restaurados.
- **Exportar e importar configuración** (feature 008): los precios y el tope son de la instancia y de
  su contrato, no del negocio: no se exportan ni se importan.

## Requirements *(mandatory)*

### Functional Requirements

**Medición**

- **FR-001**: El sistema MUST registrar el consumo de cada llamada al modelo de lenguaje que haga la
  instancia: momento, canal (WhatsApp, chat web o "Probar el bot"), uso (respuesta o resumen de
  derivación), modelo y tokens de entrada y de salida, y, si el proveedor los distingue, los tokens
  de entrada escritos y leídos de su caché.
- **FR-002**: El consumo de una respuesta MUST incluir todas las llamadas al modelo hechas para
  producirla.
- **FR-003**: Los registros de consumo MUST NOT contener textos de mensajes ni de respuestas,
  teléfonos, identificadores de cliente final o de conversación, direcciones IP ni ningún otro dato
  personal.
- **FR-004**: Las respuestas que no llaman al modelo MUST NOT generar registros de consumo; las
  llamadas que fallan MUST registrar solo los tokens que el proveedor haya informado.
- **FR-005**: Registrar el consumo MUST NOT retrasar ni impedir la respuesta al cliente final: si el
  registro falla, la respuesta se entrega y el fallo queda en el registro de actividad.
- **FR-006**: El sistema MUST conservar los registros de consumo del mes en curso y de los 12 meses
  anteriores, y eliminar los más antiguos automáticamente.

**Vista en el panel**

- **FR-007**: El panel MUST tener una pantalla "Consumo", solo para el operador con sesión, con el
  consumo del día y del mes en curso por canal, el total de los canales de clientes finales y el
  total de la instancia: respuestas con modelo, tokens de cada tipo y coste estimado.
- **FR-008**: Los días y los meses MUST calcularse en la hora local del negocio.
- **FR-009**: El operador MUST poder consultar cualquier mes conservado, con el desglose por canal y
  por día.
- **FR-010**: El operador MUST poder mantener una tabla de precios por modelo: precio por millón de
  tokens de entrada, de salida, de escritura en caché y de lectura de caché, en una moneda de coste
  única para la instancia. La precisión MUST permitir que el coste de una sola respuesta no se
  redondee a cero.
- **FR-011**: El coste estimado MUST calcularse con los precios vigentes en el momento de mostrarlo;
  la pantalla MUST indicar que es una estimación y no la factura del proveedor.
- **FR-012**: El consumo de un modelo sin precio MUST mostrarse con sus tokens y coste "sin precio",
  con un aviso que nombre el modelo.
- **FR-013**: Los cambios de precios y del tope MUST validarse (valores no negativos, tope mayor que
  cero cuando está activo) y aplicarse en una transacción, con mensajes de error por campo.

**Tope mensual de gasto**

- **FR-014**: El operador MUST poder activar, cambiar y desactivar un tope mensual de gasto estimado
  para la instancia. Por defecto está desactivado.
- **FR-015**: El gasto del mes MUST ser la suma del coste estimado de todos los registros del mes en
  curso, incluidos "Probar el bot" y los resúmenes de derivación, con los precios vigentes. Los
  registros de modelos sin precio no suman.
- **FR-016**: Antes de llamar al modelo para responder a un cliente final, el sistema MUST comprobar
  el gasto del mes sin caché; si es igual o superior al tope activo, MUST NOT llamar al modelo y MUST
  responder con un mensaje fijo que dice que ahora no puede atender por ese canal y da el contacto del
  negocio (o el de emergencia de la instancia si el negocio no tiene ninguno).
- **FR-017**: En el chat web, el tope de gasto alcanzado MUST producir el mismo estado "no disponible"
  con contacto que el tope de respuestas de la feature 004, y ambos topes MUST aplicarse a la vez.
- **FR-018**: Con el tope alcanzado, las peticiones de hablar con una persona MUST seguir
  reconociéndose y derivándose al negocio (feature 005), y los avisos al negocio MUST enviarse sin
  resumen hecho con el modelo.
- **FR-019**: Con el tope alcanzado, "Probar el bot" MUST seguir funcionando con el modelo y MUST
  mostrar que los clientes finales están recibiendo solo el contacto.
- **FR-020**: El panel MUST mostrar en todas sus pantallas un aviso cuando el gasto del mes alcance el
  80 % del tope y otro distinto al alcanzar el 100 %. Estos avisos se calculan cada vez, no se guardan,
  y no impiden activar el negocio.
- **FR-021**: El panel MUST mostrar un aviso, mientras el tope esté activo, si el modelo configurado en
  la instancia no tiene precio.
- **FR-022**: Subir o desactivar el tope MUST surtir efecto desde el siguiente mensaje, y el cambio de
  mes en la hora local del negocio MUST reanudar las respuestas con el modelo, sin intervención.
- **FR-023**: La primera vez en cada mes que se alcance el tope, el sistema MUST registrar un evento en
  el registro de actividad, sin datos personales.

**Límites con otras features**

- **FR-024**: Los precios, la moneda de coste y el tope MUST NOT incluirse en el fichero de exportación
  de configuración del negocio (feature 008) ni modificarse al importarlo.
- **FR-025**: Los registros de consumo, los precios y el tope MUST formar parte de la base de datos de
  la instancia y, por tanto, de sus copias de seguridad (feature 006).
- **FR-026**: El núcleo MUST NOT contener precios ni topes específicos de un cliente; los valores por
  defecto, si los hay, son genéricos y editables.

### Key Entities

- **Registro de consumo**: una llamada (o el conjunto de llamadas de una respuesta) al modelo.
  Momento, canal, uso (respuesta o resumen de derivación), modelo y tokens de entrada, de salida, de
  escritura en caché y de lectura de caché. Sin textos ni identificadores personales ni de
  conversación.
- **Precio de modelo**: identificador del modelo y precio por millón de tokens de cada tipo, en la
  moneda de coste de la instancia.
- **Ajustes de consumo**: moneda de coste, tope mensual de gasto (activo o no, e importe).
- **Resumen de consumo** (calculado, no guardado): por periodo (día o mes local) y canal, respuestas
  con modelo, tokens por tipo, coste estimado y modelos sin precio.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100 % de las llamadas al modelo de una batería de pruebas que cubre los tres canales,
  los reintentos y los resúmenes de derivación quedan registradas con los tokens que informó el
  proveedor, y ningún registro contiene texto ni identificador personal.
- **SC-002**: Los totales de tokens y de coste que muestra el panel para un día y un mes coinciden
  exactamente con el cálculo a mano sobre los mismos registros y precios.
- **SC-003**: El operador obtiene el consumo y el coste estimado del mes de una instancia, por canal,
  en menos de 1 minuto desde que inicia sesión.
- **SC-004**: Con el tope alcanzado, el 100 % de los mensajes de clientes finales por WhatsApp y por
  chat web reciben el contacto del negocio sin ninguna llamada al modelo, y el 100 % de las peticiones
  de hablar con una persona se derivan.
- **SC-005**: Tras subir o desactivar el tope, o al empezar el mes siguiente, el primer mensaje de un
  cliente final se responde con el modelo.
- **SC-006**: Medir el consumo no añade más de 100 ms a la mediana del tiempo de respuesta al cliente
  final.
- **SC-007**: El gasto del mes que se pasa del tope queda limitado a las respuestas que estaban en
  curso cuando se alcanzó.

## Assumptions

- El coste es una **estimación** con los precios que configura el operador; la factura real es la del
  proveedor del modelo. Por eso los precios se aplican a todo el periodo mostrado y no se guarda un
  histórico de precios.
- La moneda de coste es la de los precios del proveedor (por defecto, dólares estadounidenses) y es
  independiente de la moneda del negocio (`DEFAULT_CURRENCY`), que se usa para los precios de sus
  servicios.
- Solo se mide el modelo de lenguaje. La transcripción de audios (otro proveedor, desactivada por
  defecto) queda fuera de esta feature.
- "Probar el bot" consume dinero real, así que suma al gasto del tope, pero no se bloquea: el operador
  tiene que poder comprobar el bot también con el tope alcanzado.
- Con el tope alcanzado, el mensaje fijo se envía a cada mensaje (o lote de mensajes) del cliente
  final, como hoy hace el chat web con su tope; enviarlo no llama al modelo.
- El aviso al 80 % es fijo; no se envían correos ni mensajes al operador por el tope (solo panel y
  registro de actividad).
- El tope del chat web por número de respuestas (feature 004) se mantiene sin cambios.
- La herramienta de terminal `pnpm bot:chat` y la evaluación `pnpm test:eval` no forman parte del
  consumo de la instancia: se ejecutan en el equipo del desarrollador.
- Conservar 13 meses de registros basta para facturar y comparar con el mismo mes del año anterior;
  los registros no tienen datos personales, así que no les aplica el plazo de 30 días de las
  conversaciones.
- Depende de que el proveedor del modelo informe de los tokens de cada llamada, como hace hoy.
