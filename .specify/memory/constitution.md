<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0 (MINOR: se amplía materialmente la guía sobre canales)
- Principios modificados: ninguno
- Secciones modificadas:
  - Descripción inicial: ya no limita la atención a WhatsApp.
  - Restricciones del producto: "Canal: WhatsApp es el canal de atención al cliente final" →
    "Canales: …" (canales añadidos mediante spec de núcleo; todos con la misma cadena de respuesta
    y las garantías de los Principios IV y V).
- Secciones añadidas: ninguna
- Secciones eliminadas: ninguna
- Motivo: la spec 004-web-channel añade un chat web para clientes finales.
- Plantillas dependientes: no modificadas (leen la constitución en tiempo de ejecución)
- Documentos que mencionan "WhatsApp" como único canal y conviene revisar: CLAUDE.md (primera
  línea) y README.md; las specs 001 y 002 no cambian (describen su propio alcance).
- TODOs diferidos: ninguno
-->

# Chatbot Asesor Constitution

Chatbot de atención al cliente para pequeños negocios (clínicas, peluquerías, talleres,
inmobiliarias), por WhatsApp y por los demás canales que se añadan al núcleo. Se despliega una
instancia por cliente a partir de una base común.

## Core Principles

### I. Base común única

Todos los clientes MUST partir del mismo núcleo. El núcleo MUST NOT contener lógica
específica de ningún sector ni de ningún cliente: ni nombres de negocio, ni ramas por tipo
de negocio (`if clínica…`), ni textos, servicios o reglas propias de un sector.

Criterio verificable: cualquier instancia de cualquier sector se construye con el mismo
núcleo sin modificarlo; una búsqueda en el núcleo de nombres de clientes o sectores no
devuelve lógica condicional.

**Razón**: un único núcleo permite corregir y mejorar una vez para todos los clientes y evita
que el producto degenere en N bifurcaciones imposibles de mantener.

### II. Configuración antes que código

Lo que varía entre negocios MUST expresarse como configuración, no como código: datos del
negocio, servicios, precios, horarios, recursos, preguntas frecuentes y tono. Dar de alta un
negocio nuevo o cambiar sus datos MUST NOT requerir cambios de código ni un nuevo despliegue
de código.

Cuando surja una variación nueva, primero se MUST evaluar si puede cubrirse ampliando el
modelo de configuración del núcleo (de forma genérica, válida para cualquier sector) antes de
recurrir a una extensión.

**Razón**: la configuración es más barata, más segura y la gestiona el operador sin
intervención de desarrollo.

### III. Personalizaciones aisladas

Cuando un cliente necesite un comportamiento que la configuración no cubre, MUST
implementarse como extensión sobre el núcleo, con una spec propia, y MUST NOT modificar el
núcleo. Las extensiones se conectan a través de puntos de extensión que el núcleo expone de
forma genérica.

- Si una extensión requiere un punto de extensión que no existe, ese punto se añade al núcleo
  mediante una spec de núcleo independiente, genérica y sin referencias al cliente.
- Una extensión de un cliente MUST NOT afectar al comportamiento de otras instancias.
- Retirar una extensión MUST dejar la instancia funcionando con el comportamiento del núcleo.

**Razón**: aislar lo particular protege la base común y hace trazable cada personalización.

### IV. Solo información registrada (NON-NEGOTIABLE)

El bot MUST responder únicamente con información registrada del negocio. MUST NOT inventar,
estimar ni deducir precios, horarios, servicios, disponibilidad ni cualquier otro dato del
negocio. Si la información no está registrada, el bot MUST decirlo explícitamente y ofrecer
contacto con el negocio.

Criterio verificable: toda afirmación factual del bot sobre el negocio es trazable a un dato
de su configuración; ante preguntas sin dato registrado, la respuesta reconoce la falta de
información y ofrece contacto.

**Razón**: una respuesta inventada (un precio, una cita disponible) genera compromisos falsos
en nombre del negocio y destruye la confianza en el producto.

### V. Siempre hay salida a una persona (NON-NEGOTIABLE)

El cliente final MUST poder pedir hablar con el negocio en cualquier momento de la
conversación, sea cual sea el estado o flujo en curso. Ningún flujo, configuración ni
extensión puede bloquear o retrasar esa salida.

Criterio verificable: desde cualquier punto de cualquier flujo, una petición de hablar con una
persona se reconoce y se atiende con el mecanismo de derivación configurado para el negocio.

**Razón**: el bot es una ayuda, no una barrera; un cliente atrapado es un cliente perdido.

### VI. El operador registra la información

La información del negocio la registra el operador del sistema, no el negocio. El sistema
MUST NOT exponer al negocio mecanismos para alterar su propia configuración salvo que una
spec aprobada lo introduzca explícitamente como enmienda a este principio.

**Razón**: el operador garantiza la calidad, coherencia y completitud de los datos de los que
depende el Principio IV.

## Restricciones del producto

- Canales: el núcleo atiende al cliente final por los canales que se añadan mediante spec de
  núcleo; el primero es WhatsApp. Todo canal MUST aplicar la misma cadena de respuesta y las
  mismas garantías de los Principios IV y V.
- Despliegue: una instancia por cliente, construida a partir del núcleo común más su
  configuración y, si las hay, sus extensiones.
- Aislamiento: la configuración, las conversaciones y los datos de una instancia MUST NOT ser
  accesibles desde otra instancia.
- Las decisiones de stack tecnológico se toman en los planes de implementación y MUST ser
  compatibles con estos principios.

## Flujo de desarrollo

- Todo cambio se inicia con una spec. Cada spec MUST declarar su ámbito: **núcleo**
  (genérico, aplica a todos los clientes) o **extensión** (de un cliente concreto).
- Una spec de núcleo MUST NOT mencionar clientes ni sectores concretos como requisitos; puede
  usarlos solo como ejemplos ilustrativos.
- Cada plan MUST incluir un Constitution Check que verifique los seis principios; cualquier
  desviación MUST justificarse por escrito o bloquea el avance.
- Los comportamientos de los Principios IV y V MUST contar con pruebas que los verifiquen
  antes de dar por terminada cualquier feature que afecte a la conversación.

## Governance

- Esta constitución prevalece sobre cualquier otra práctica o documento del proyecto.
- Las enmiendas se realizan mediante `/speckit-constitution`, quedan documentadas en el Sync
  Impact Report y requieren revisar su impacto en specs, planes y extensiones existentes.
- Versionado semántico: MAJOR para eliminar o redefinir principios de forma incompatible;
  MINOR para añadir principios o secciones o ampliar materialmente su guía; PATCH para
  aclaraciones y redacción.
- Revisión de cumplimiento: toda spec, plan y revisión de código MUST verificar el
  cumplimiento de estos principios; la complejidad añadida MUST estar justificada.

**Version**: 1.1.0 | **Ratified**: 2026-09-24 | **Last Amended**: 2026-09-25
