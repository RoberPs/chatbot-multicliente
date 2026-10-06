# Feature Specification: Requisitos de despliegue seguro

**Feature Branch**: `013-secure-deployment`

**Created**: 2026-10-06

**Status**: Draft

**Ámbito**: Núcleo (operación y documentación)

**Input**: User description: "Hacer que el despliegue seguro se compruebe y no dependa de la memoria del operador: instance:check marca como no apto en producción un proxy sin TRUST_PROXY, las conexiones a PostgreSQL remotas sin TLS verificado y la falta de PUBLIC_BASE_URL; la imagen tiene healthcheck y base fijada por digest; la verificación de copias limpia sus bases temporales; y la guía de operación incluye la receta de producción (proxy, red, TLS, permisos, contenedor endurecido e integración continua con escaneo de dependencias, secretos e imagen). Ámbito: núcleo (propuesta P9 de docs/operacion-multicliente.md)."

## Contexto

La auditoría completa del 2026-10-05 ([docs/operacion-multicliente.md, sección 11.6](../../docs/operacion-multicliente.md))
concluyó que la aplicación hace bien lo que le toca, pero que su seguridad en producción depende de
requisitos del despliegue que hoy no se comprueban o ni siquiera están escritos:

- si delante hay un proxy y la instancia no lo sabe, todos los clientes parecen venir de la misma
  dirección: los límites por dirección de la feature 012 dejan fuera a todos a la vez, o no
  limitan a nadie si el proxy añade en lugar de sustituir la dirección de origen;
- la conexión a una base de datos en otra máquina puede ir sin cifrar o sin comprobar con quién se
  habla, y por ella viajan los datos de la instancia y las credenciales de la base de datos;
- sin dirección pública declarada, los enlaces de los avisos al negocio y el origen del chat web
  dependen de la petición;
- la imagen no dice si la instancia está sana, se construye sobre una base que puede cambiar sin
  aviso y las dependencias pueden instalarse con versiones o scripts no previstos;
- la verificación de copias puede dejar bases de datos temporales con datos reales si se
  interrumpe, accesibles a otros usuarios del mismo servidor;
- no hay una receta escrita de cómo se publica una instancia de forma segura (proxy, red, TLS,
  permisos, contenedor endurecido, integración continua).

Hoy `instance:check` solo **advierte** de algunos de estos puntos. Esta feature los convierte en
condiciones de **no apto** y deja el resto escrito como receta comprobable. Es la propuesta P9 y la
última bloqueante antes de la primera publicación en producción.

**Producción** en esta spec es el perfil de producción de `instance:check` y una instancia que se
ejecuta con el entorno marcado como producción. Fuera de producción (desarrollo, instancia de
pruebas) las reglas nuevas no bloquean, para no entorpecer el trabajo en local.

**Host local** es `localhost`, una dirección de bucle local (`127.0.0.0/8`, `::1`) o un socket
local. Cualquier otro host es **remoto**, también los de una red privada.

## Clarifications

### Session 2026-10-06

- Q: ¿Cómo sabe `db:verify` la antigüedad de una base temporal para decidir si está huérfana? → A: La marca de tiempo de creación va en el nombre (`verify_<UTC yyyymmddhhmmss>_<aleatorio>`); las del formato antiguo `verify_<16 hex>` son huérfanas si no tienen conexiones abiertas.
- Q: Con un certificado de autoridad privada, ¿cómo recibe la instancia esa autoridad para `verify-full`? → A: Con `sslrootcert=<ruta>` en la propia URL, apuntando a un fichero montado en solo lectura; sin él se usan las autoridades públicas; `instance:check` no exige `sslrootcert`.
- Q: ¿Debe `instance:db` negarse siempre a conectar con un servidor remoto sin `verify-full`, también para instancias de pruebas? → A: Sí, siempre y sin opción de escape; la alternativa es `--print-sql`.
- Q: (Encontrado al implementar.) Con una IP en la URL, `pg` no pasa la dirección a TLS y Node compara el certificado con `localhost`, así que `verify-full` no comprueba el nombre. ¿Cuenta como TLS verificado? → A: No. Una URL remota cuyo host es una IP literal (IPv4 o IPv6) no cuenta como TLS verificado aunque lleve `verify-full`; `instance:check` lo señala con su propio código (`database_tls_ip_host`, mismas severidades que FR-003) y `instance:db` se niega a conectar. La URL debe usar el nombre del servidor que figura en su certificado.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El entorno de producción no pasa la comprobación si el despliegue no es seguro (Priority: P1)

El operador prepara el entorno de una instancia nueva y lo pasa por `instance:check` antes de
desplegar. Si la URL pública es https pero no ha indicado cuántos proxies hay delante, si falta la
URL pública, o si alguna conexión a una base de datos remota no exige TLS con verificación del
certificado y del nombre del servidor, la comprobación da **NO APTO**, dice qué variable falla y
qué hacer, sin mostrar ningún valor. El despliegue automatizado que usa el código de salida se
detiene solo.

**Why this priority**: es lo que hace que el despliegue seguro no dependa de la memoria del
operador. Los tres fallos dejan sin efecto protecciones ya construidas (límites por dirección de la
012, confidencialidad de los datos) y hoy pasan como simples advertencias.

**Independent Test**: preparar entornos de producción con cada uno de los fallos y comprobar que
`instance:check` da NO APTO con el error y la acción correctos, y que con los valores correctos da
APTO; repetir con el perfil de pruebas y comprobar que solo advierte.

**Acceptance Scenarios**:

1. **Given** un entorno de producción con `PUBLIC_BASE_URL` en https y `TRUST_PROXY` vacío o
   `false`, **When** se ejecuta `instance:check`, **Then** el resultado es NO APTO con un error en
   `TRUST_PROXY` que explica que con https hay un proxy delante y que hay que indicar sus saltos o
   direcciones.
2. **Given** un entorno de producción sin `PUBLIC_BASE_URL`, **When** se ejecuta `instance:check`,
   **Then** el resultado es NO APTO con un error en `PUBLIC_BASE_URL`.
3. **Given** un entorno de producción cuyo `DATABASE_URL` apunta a un host remoto sin exigir TLS
   verificado, **When** se ejecuta `instance:check`, **Then** el resultado es NO APTO con un error
   en `DATABASE_URL` que indica el modo de TLS necesario, sin mostrar la URL.
4. **Given** lo mismo con `BACKUP_VERIFY_URL` o `INSTANCE_DB_ADMIN_URL` presentes en el fichero,
   **When** se ejecuta `instance:check`, **Then** cada una da su propio error.
5. **Given** un entorno de producción con la base de datos en un host local sin TLS, **When** se
   ejecuta `instance:check`, **Then** esa conexión no da error por TLS.
6. **Given** un entorno con cualquiera de estos fallos en el perfil de pruebas, **When** se ejecuta
   `instance:check`, **Then** se informan como advertencias y el resultado puede ser APTO.
7. **Given** un entorno de producción que cumple todo, **When** se ejecuta `instance:check`,
   **Then** el resultado es APTO y la salida en JSON incluye los mismos códigos de regla que la
   salida de texto.

---

### User Story 2 - La verificación de copias no deja bases temporales con datos accesibles (Priority: P2)

El operador verifica periódicamente las copias con `db:verify`, que restaura cada copia en una base
de datos temporal. Si una verificación anterior se interrumpió (corte, proceso parado, máquina
reiniciada), su base temporal quedó en el servidor con datos reales. La siguiente verificación la
encuentra y la borra, y mientras existe ninguna base temporal es accesible para otros usuarios del
servidor.

**Why this priority**: las bases huérfanas son copias en claro de los datos de un negocio fuera de
toda retención y de todo cifrado; pero solo aparecen si una verificación se interrumpe, de ahí que
vaya después de la comprobación del entorno.

**Independent Test**: dejar en el servidor de verificación una base temporal de una verificación
interrumpida, ejecutar `db:verify` y comprobar que la borra, que no toca bases con otros nombres ni
una verificación en curso, y que la base que crea no admite conexiones de otros usuarios.

**Acceptance Scenarios**:

1. **Given** una base temporal de verificación huérfana en el servidor de verificación, **When** se
   ejecuta `db:verify`, **Then** la base huérfana se borra y el informe dice cuántas se han
   limpiado, sin nombres de negocio ni datos.
2. **Given** otra verificación en curso en el mismo servidor, **When** se ejecuta `db:verify`,
   **Then** la base temporal de esa verificación no se toca.
3. **Given** cualquier base de datos cuyo nombre no sea el de una base temporal de verificación,
   **When** se ejecuta `db:verify`, **Then** esa base no se toca nunca.
4. **Given** una verificación en marcha, **When** otro usuario del servidor sin permisos
   especiales intenta conectarse a su base temporal, **Then** la conexión se rechaza.
5. **Given** que la limpieza de huérfanas falla (por ejemplo, por permisos), **When** se ejecuta
   `db:verify`, **Then** la verificación de la copia sigue y el informe avisa de que quedan bases
   sin limpiar.

---

### User Story 3 - La imagen es reproducible y dice si la instancia está sana (Priority: P2)

El operador construye la imagen del núcleo y la despliega. La imagen parte siempre de la misma
base exacta, instala exactamente las dependencias del lockfile con el gestor de paquetes fijado y
sin ejecutar scripts de instalación no autorizados, y la plataforma de contenedores sabe en todo
momento si la instancia está sana sin confundir las migraciones del arranque con un fallo. En el
repositorio no puede colarse por descuido un certificado o una clave privada.

**Why this priority**: evita que dos construcciones de la misma versión den imágenes distintas y
que una instancia caída pase inadvertida; es endurecimiento, no cierra un fallo explotable.

**Independent Test**: construir la imagen dos veces y comprobar que usa la misma base; arrancarla
con y sin base de datos y comprobar el estado de salud que informa la plataforma; intentar añadir
un fichero de clave al repositorio y comprobar que git lo ignora.

**Acceptance Scenarios**:

1. **Given** la imagen recién arrancada aplicando migraciones, **When** la plataforma consulta su
   salud dentro del periodo de gracia, **Then** los fallos no cuentan y la instancia no se marca
   como enferma.
2. **Given** la instancia lista y atendiendo, **When** la plataforma consulta su salud, **Then** la
   marca como sana.
3. **Given** la instancia sin acceso a su base de datos después del periodo de gracia, **When** la
   plataforma consulta su salud varias veces seguidas, **Then** la marca como enferma.
4. **Given** el Dockerfile, **When** se revisa su imagen base, **Then** está fijada por digest
   además de por etiqueta, y el gestor de paquetes declarado en el proyecto lleva su hash.
5. **Given** una dependencia nueva con script de instalación que no está en la lista autorizada,
   **When** se instalan las dependencias, **Then** su script no se ejecuta.
6. **Given** un fichero `*.pem`, `*.key` o `*.p12` en el directorio del proyecto, **When** se
   consulta el estado de git, **Then** el fichero aparece como ignorado.

---

### User Story 4 - La guía de operación tiene la receta de producción (Priority: P3)

El operador que publica su primera instancia sigue la sección 2.5 de la guía de operación y
encuentra, en orden y con comandos de ejemplo, todo lo que el despliegue debe cumplir y que el
código no puede comprobar por sí solo: proxy, red, TLS hacia la base de datos, permisos del
fichero de entorno, contenedor endurecido, volumen de copias, servidor de verificación separado e
integración continua con escaneo de dependencias, secretos e imagen. Cada punto dice cómo
comprobarlo.

**Why this priority**: es documentación; sin las historias 1 a 3 la receta sería solo una lista de
buenos deseos, y con ellas la mayor parte ya se comprueba sola.

**Independent Test**: una persona que no haya participado en la feature sigue la receta en una
máquina limpia y llega a una instancia que pasa `instance:check` y cada comprobación de la receta,
sin preguntar nada.

**Acceptance Scenarios**:

1. **Given** la sección 2.5, **When** se lee, **Then** incluye cada punto de FR-020 con su
   comprobación.
2. **Given** la receta, **When** se despliega con ella, **Then** el puerto de la aplicación no es
   accesible desde fuera de la máquina o de la red interna, y la dirección de origen que ve la
   instancia es la del cliente aunque este envíe una cabecera de reenvío falsa.

---

### Edge Cases

- `TRUST_PROXY` con un valor no vacío pero erróneo (más saltos de los reales): no se puede detectar
  desde el fichero; la receta incluye cómo comprobar la dirección que ve la instancia.
- `PUBLIC_BASE_URL` en http en producción: ya es error hoy (debe ser https pública); no cambia.
- URL de base de datos con TLS pedido por otro medio que no sea la propia URL (variables del
  cliente de PostgreSQL en el entorno): no cuenta; la regla mira solo la URL, que es lo que usa la
  instancia, y el mensaje lo dice.
- Modo de TLS que cifra pero no verifica (`require`, `verify-ca`, `prefer`): no basta; solo vale
  la verificación completa (certificado y nombre del servidor).
- `BACKUP_VERIFY_URL` ausente: la verificación usa `DATABASE_URL`, que ya se comprueba; no se
  duplica el error.
- `INSTANCE_DB_ADMIN_URL` no suele estar en el fichero de la instancia (es del operador): solo se
  comprueba si está; `instance:db` aplica la misma regla a la que recibe, con el mismo mensaje.
- URL de base de datos que no se puede interpretar: error de formato, como hoy, no de TLS.
- Host remoto escrito como IP privada (`10.x`, `192.168.x`): es remoto; la red privada no sustituye
  al TLS verificado.
- Instancias ya en producción que hoy pasan con advertencias: al actualizar el núcleo, la siguiente
  `instance:check` da NO APTO; la guía de actualización lo avisa y dice cómo corregirlo antes de la
  tanda (FR-023).
- El servidor de verificación no permite listar bases o borrarlas: la verificación sigue y avisa
  (escenario 2.5).
- Dos instancias comparten servidor de verificación y verifican a la vez: ninguna borra la base
  temporal de la otra.
- Base temporal del formato anterior (`verify_<16 hex>`) que dejó una versión previa del núcleo:
  como no lleva marca de tiempo, se borra si no tiene conexiones abiertas. Una verificación en curso
  de una instancia aún no actualizada siempre tiene conexiones, así que no se toca.
- Nombre con marca de tiempo que no se puede interpretar (fecha imposible): no sigue exactamente el
  patrón y no se toca (FR-011).
- La comprobación de salud consulta `/health`, que tiene límite de peticiones por dirección: el
  periodo de la comprobación queda muy por debajo de ese límite.
- `/health` responde `not_ready` (arrancando o cerrando) o `degraded` (base de datos sin respuesta,
  vacía o con un esquema distinto del esperado): cuenta como fallo; la receta dice que la
  plataforma no reinicia por sí sola y qué mirar en cada caso.
- La imagen no trae utilidades de red (curl, wget): la comprobación de salud no puede depender de
  ellas.

## Requirements *(mandatory)*

### Functional Requirements

**Comprobación del entorno (`instance:check`)**

- **FR-001**: En el perfil de producción, `instance:check` MUST dar error (no apto) cuando
  `PUBLIC_BASE_URL` es https y `TRUST_PROXY` está vacío, ausente o vale `false`. Hoy es una
  advertencia.
- **FR-002**: En el perfil de producción, `instance:check` MUST dar error cuando falta
  `PUBLIC_BASE_URL` (se mantiene la regla actual y se cubre con pruebas).
- **FR-003**: En el perfil de producción, `instance:check` MUST dar error, uno por variable, cuando
  `DATABASE_URL`, `BACKUP_VERIFY_URL` o `INSTANCE_DB_ADMIN_URL` (las dos últimas solo si están en
  el fichero) apuntan a un host remoto y la URL no exige TLS con verificación completa del
  certificado y del nombre del servidor (`sslmode=verify-full`). La regla no exige
  `sslrootcert` (sin él valen las autoridades públicas). Con un host remoto que es una IP literal,
  `verify-full` no cuenta como TLS verificado (la librería no comprueba el nombre con una IP): es
  un error propio, `database_tls_ip_host`, que pide el nombre del certificado.
- **FR-004**: Una conexión a un host local MUST NOT dar error por falta de TLS. Se mantiene la
  advertencia actual de base de datos en localhost en producción.
- **FR-005**: En el perfil de pruebas, las reglas de FR-001 y FR-003 MUST informarse como
  advertencias, sin bloquear.
- **FR-006**: Cada error nuevo MUST tener su código de regla estable (también en la salida JSON),
  nombrar la variable, decir la acción que lo corrige y no mostrar nunca el valor ni partes de la
  URL (usuario, contraseña, host).
- **FR-007**: `pnpm instance:db` MUST aplicar la regla de FR-003 a la URL de administración que
  recibe: con host remoto sin TLS verificado se niega a conectar y lo explica (con
  `--print-sql` no conecta y no aplica). La negativa no depende del perfil de la instancia
  (también en pruebas) y no tiene opción para saltársela; el mensaje propone `--print-sql` como
  alternativa.
- **FR-008**: La instancia MUST ser capaz de conectarse a una base de datos remota con
  `sslmode=verify-full` en todas sus conexiones (aplicación, copias, restauración y verificación),
  verificando el certificado del servidor; si el certificado no es válido para ese nombre, la
  conexión falla con un mensaje sin datos. La autoridad de confianza se indica en la propia URL
  con `sslrootcert=<ruta de un fichero>`; sin ese parámetro se usan las autoridades públicas. Si
  el fichero indicado no existe o no se puede leer, la conexión falla con un mensaje que nombra la
  variable, sin la ruta ni otras partes de la URL.

**Verificación de copias (`db:verify`)**

- **FR-009**: Al crear su base temporal, la verificación MUST quitar inmediatamente a todos los
  usuarios (PUBLIC) el permiso de conexión a ella, antes de cargar ningún dato.
- **FR-010**: Antes de verificar, `db:verify` MUST buscar en el servidor de verificación bases
  temporales de verificación huérfanas y borrarlas. Es huérfana la que sigue el patrón de nombre de
  las bases temporales de verificación, no tiene conexiones abiertas y tiene una antigüedad mayor
  que el plazo máximo de una verificación. La antigüedad se lee del nombre: la base temporal se
  llama `verify_<yyyymmddhhmmss en UTC>_<aleatorio>`. Las bases del formato anterior
  (`verify_<16 hex>`, sin marca de tiempo) se consideran huérfanas si no tienen conexiones abiertas.
- **FR-011**: La limpieza MUST NOT tocar nunca una base cuyo nombre no siga exactamente ese patrón,
  ni una base temporal de una verificación en curso (con conexiones o dentro del plazo).
- **FR-012**: El informe de `db:verify` (texto y JSON) MUST decir cuántas bases huérfanas se han
  borrado y cuántas no se han podido borrar, sin nombres ni datos; un fallo de la limpieza MUST NOT
  impedir la verificación de la copia.

**Imagen y repositorio**

- **FR-013**: La imagen MUST declarar una comprobación de salud sobre `GET /health` (vista
  pública, sin secreto) que no dependa de utilidades que la imagen no trae, con periodo de gracia
  inicial suficiente para aplicar las migraciones, intervalo y número de reintentos que no se
  acerquen al límite de peticiones de `/health`.
- **FR-014**: La comprobación de salud MUST considerar sana la instancia solo cuando `/health`
  responde que está lista y bien; cualquier otra respuesta o la falta de respuesta en el plazo
  cuenta como fallo.
- **FR-015**: Las imágenes base de todas las etapas del Dockerfile MUST estar fijadas por digest,
  conservando la etiqueta legible; la guía dice cómo actualizar el digest.
- **FR-016**: El gestor de paquetes declarado en el proyecto MUST llevar su hash, de modo que la
  construcción use exactamente esa versión.
- **FR-017**: La configuración de pnpm del proyecto MUST guardar versiones exactas al añadir
  dependencias y MUST permitir scripts de instalación solo a una lista explícita de dependencias
  (las que hoy los necesitan); la construcción de la imagen respeta esa configuración.
- **FR-018**: El `.gitignore` MUST ignorar `*.pem`, `*.key` y `*.p12` (sin dejar fuera ningún
  fichero que hoy esté en el repositorio).

**Guía de operación**

- **FR-019**: La sección 2.5 de `docs/operacion-multicliente.md` MUST contener la receta de
  producción, con cada punto acompañado de cómo comprobarlo.
- **FR-020**: La receta MUST cubrir al menos:
  - proxy inverso que **sustituye** (no añade) la cabecera de dirección de origen, y `TRUST_PROXY`
    con el número de saltos real;
  - puerto 3000 publicado solo en `127.0.0.1` o en una red interna, nunca en todas las interfaces;
  - TLS hacia PostgreSQL con `sslmode=verify-full` y, si la autoridad no es pública, su
    certificado montado en el contenedor en solo lectura e indicado con `sslrootcert=<ruta>` en
    cada URL de base de datos;
  - fichero de entorno pasado con `--env-file`, con permisos 0600 y dueño el operador;
  - contenedor con sistema de ficheros de solo lectura (con los directorios temporales que
    necesite), sin capacidades (`--cap-drop=ALL`) y con `no-new-privileges`;
  - volumen de copias con dueño UID 1000 y modo 0700;
  - servidor de verificación de copias separado del de producción y con un usuario sin acceso a
    las bases de las instancias;
  - integración continua con `pnpm audit --prod`, escaneo de la imagen y las herramientas de la
    sección 11.2 (gitleaks, semgrep, osv-scanner), y qué resultado bloquea la publicación según
    la sección 11.4;
  - estado de salud del contenedor: qué significa y qué hacer cuando está enfermo.
- **FR-021**: La receta MUST ser genérica: sin proveedor de hosting concreto ni nombres de cliente
  o sector; los ejemplos de proxy y de contenedor pueden usar herramientas concretas como ejemplo.
- **FR-022**: La tabla de variables de la sección 2.4 MUST reflejar las reglas nuevas
  (`TRUST_PROXY` obligatorio con https; TLS verificado en las URL de base de datos remotas).
- **FR-023**: La sección 5 (actualizar el núcleo) MUST avisar de que, desde esta versión,
  instancias que antes pasaban con advertencias pueden dar NO APTO, y que hay que pasar cada
  entorno por `instance:check` y corregirlo antes de su tanda.

### Key Entities

- **Regla de despliegue**: condición que `instance:check` evalúa sobre un fichero de entorno; tiene
  código estable, variable, severidad según el perfil (error en producción, advertencia en
  pruebas) y acción que la corrige.
- **Base temporal de verificación**: base de datos que crea `db:verify` en el servidor de
  verificación para restaurar una copia; tiene nombre con patrón fijo que incluye su momento de
  creación en UTC (`verify_<yyyymmddhhmmss>_<aleatorio>`), no admite conexiones de
  otros usuarios y se borra al terminar o, si queda huérfana, en una verificación posterior.
- **Receta de producción**: lista ordenada de requisitos del despliegue que el código no comprueba,
  cada uno con su comprobación.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100 % de los entornos de producción con alguno de los fallos de FR-001 a FR-003
  da NO APTO, y ninguno de los entornos correctos de las pruebas da NO APTO por estas reglas.
- **SC-002**: Ningún mensaje de `instance:check`, `instance:db` ni `db:verify` muestra un valor
  secreto, una URL o una parte de ella (comprobado en las pruebas).
- **SC-003**: Tras una verificación interrumpida, la siguiente verificación deja el servidor sin
  bases temporales huérfanas en el 100 % de los casos de prueba, y en ninguno borra una base ajena
  o en uso.
- **SC-004**: Una instancia recién arrancada pasa a sana en menos de 2 minutos con la base de datos
  disponible, y una instancia sin base de datos pasa a enferma en menos de 3 minutos después del
  periodo de gracia.
- **SC-005**: Dos construcciones de la imagen de la misma versión, en días distintos, parten de la
  misma imagen base.
- **SC-006**: Una persona que no haya participado en la feature despliega una instancia siguiendo
  solo la sección 2.5 y cumple cada comprobación de la receta sin preguntar nada.
- **SC-007**: Ninguna de las reglas nuevas cambia el resultado de `instance:check` en el perfil de
  pruebas (siguen siendo advertencias).

## Assumptions

- La regla de TLS se aplica solo en `instance:check` (y en `instance:db`), no al arrancar la
  instancia: endurecer el arranque podría parar instancias ya publicadas sin pasar por su tanda.
  El arranque se puede endurecer en una spec posterior.
- El TLS verificado se exige con `sslmode=verify-full` en la propia URL, que es el modo estándar
  de PostgreSQL para verificar certificado y nombre; otros medios (variables del cliente) no
  cuentan.
- La instancia no termina TLS por sí misma: una `PUBLIC_BASE_URL` en https implica siempre un
  proxy delante.
- El plazo máximo de una verificación para considerar huérfana una base temporal es de unas horas
  (el valor exacto lo fija el plan, holgado frente a la copia más grande razonable).
- La imagen se construye con Docker o una herramienta compatible con su `HEALTHCHECK`; las
  plataformas que no lo usan configuran su propia comprobación sobre `/health` con la receta.
- La integración continua se describe en la guía como receta; no se añade un fichero de CI al
  repositorio porque aún no hay remoto ni proveedor elegido.
- Fuera de alcance: elegir proveedor de hosting, crear la infraestructura, retos anti-bot, firmar
  la imagen y gestionar certificados del proxy.
- Depende de P1 (feature 007, `instance:check` e `instance:db`), de la 006 (verificación de
  copias) y de la 009 (`/health` y su ciclo de vida).
