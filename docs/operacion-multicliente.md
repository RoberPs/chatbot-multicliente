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
| `AUDIO_TRANSCRIPTION` · `STT_*` | `off` salvo que esté contratado y cubierto por el contrato |

Guarda este fichero en un gestor de secretos (o en las variables cifradas de tu plataforma), no en
el repositorio.

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

- [ ] Copia de seguridad inicial de la BD.
- [ ] Anotada la instancia en tu inventario: cliente, subdominio, versión de la imagen, workspace
      de Anthropic, fecha de alta.
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
5. **Copia de seguridad** de la BD de cada cliente justo antes de actualizarlo.
6. Actualiza los clientes de uno en uno o por tandas pequeñas, comprobando cada instancia.
7. Si algo falla: vuelve a la etiqueta anterior. Si la migración ya se aplicó y no es compatible
   hacia atrás, restaura la copia; por eso las migraciones deben ser, siempre que se pueda,
   aditivas (añadir columnas o tablas antes de dejar de usar las viejas).

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
4. Borra la BD y sus copias de seguridad en el plazo acordado, y anótalo en el inventario.

---

## 8. Propuestas de specs

Lo anterior funciona a mano con pocos clientes, pero con cada cliente nuevo aumenta el riesgo de
error humano (secretos repetidos, BD equivocada, actualizaciones sin copia). Estas specs lo cubren.
Todas son de **núcleo**: genéricas, sin nombres de cliente ni de sector.

Los números definitivos los asigna `/speckit-specify`; el orden recomendado es el de la tabla.

| Id | Propuesta | Prioridad | Cuándo |
|---|---|---|---|
| P1 | Aprovisionamiento de instancias | Alta | Antes del 2.º o 3.er cliente |
| P2 | Exportar e importar la configuración del negocio | Alta | Antes del 2.º o 3.er cliente |
| P3 | Copias de seguridad y restauración por instancia | Alta | Antes del primer cliente real |
| P4 | Consumo y coste por instancia | Media | Al facturar el consumo |
| P5 | Puntos de extensión del núcleo | Baja | Cuando la primera petición no quepa en la configuración |
| P6 | Versión visible y actualización escalonada | Media | Con 3 o más instancias |

### P1. Aprovisionamiento de instancias

- **Ámbito**: núcleo (herramientas de operación).
- **Problema**: el alta se hace a mano y cada paso manual puede romper el aislamiento (secretos
  copiados, BD compartida, variables incompletas).
- **Alcance**:
  - Comando `pnpm instance:new` que pide los datos mínimos (identificador de instancia, URL
    pública, zona horaria, región telefónica, moneda, teléfono de emergencia) y genera un fichero
    de entorno completo con secretos nuevos.
  - Script SQL o comando que crea la BD y un usuario con permisos solo sobre ella.
  - Comando `pnpm instance:check` que valida un fichero de entorno antes de desplegar: variables
    obligatorias, `NODE_ENV=production`, `https` en `PUBLIC_BASE_URL`, WhatsApp "las cinco o
    ninguna" y que ningún secreto coincide con los de otras instancias del inventario.
  - Inventario de instancias (fichero local fuera del repositorio) sin secretos en claro.
- **Fuera de alcance**: elegir proveedor de hosting o crear la infraestructura.
- **Texto para `/speckit-specify`**:
  > Herramientas de operación para dar de alta una instancia nueva del núcleo de forma segura:
  > generar un entorno completo con secretos únicos, crear una base de datos con un usuario
  > propio y validar el entorno antes de desplegar, detectando secretos repetidos entre
  > instancias. Ámbito: núcleo.

### P2. Exportar e importar la configuración del negocio

- **Ámbito**: núcleo.
- **Problema**: la configuración solo se puede preparar en el panel de producción. No hay forma de
  prepararla en una instancia de pruebas, revisarla y llevarla a producción, ni de guardar una
  copia legible de la configuración.
- **Alcance**:
  - Exportar desde el panel un fichero JSON versionado con la configuración del negocio (datos,
    horarios, servicios, precios, FAQ, configuración del chat web). **Sin** conversaciones ni
    datos de clientes finales.
  - Importarlo en otra instancia: validación con los esquemas Zod del dominio, vista previa de
    cambios, aplicación en una transacción que respeta FR-032 (si el negocio queda activo con un
    aviso crítico, se revierte).
  - La importación nunca activa el negocio por sí sola.
- **Fuera de alcance**: sincronización automática entre instancias; plantillas por sector dentro
  de `src/` (seguirían en `tests/fixtures/` o fuera del repositorio).
- **Texto para `/speckit-specify`**:
  > El operador puede exportar la configuración del negocio de una instancia a un fichero y
  > importarla en otra, con validación, vista previa de cambios y aplicación transaccional que
  > respeta los avisos críticos. No incluye conversaciones ni datos de clientes finales. Ámbito:
  > núcleo.

### P3. Copias de seguridad y restauración por instancia

- **Ámbito**: núcleo (operación).
- **Problema**: no hay procedimiento de copia ni de restauración, y las actualizaciones aplican
  migraciones automáticamente.
- **Alcance**:
  - Comandos `pnpm db:backup` y `pnpm db:restore` sobre `DATABASE_URL`, con copias cifradas y
    nombradas por instancia, versión de esquema y fecha.
  - Copia automática antes de aplicar migraciones pendientes al arrancar (o bloqueo del arranque
    si no se puede hacer).
  - Retención configurable y coherente con el borrado de conversaciones a los 30 días.
  - Procedimiento de prueba de restauración documentado en un quickstart.
- **Texto para `/speckit-specify`**:
  > Copias de seguridad y restauración de la base de datos de una instancia, con copia previa
  > obligatoria a las migraciones, cifrado, retención configurable compatible con el borrado de
  > conversaciones a los 30 días y un procedimiento de restauración verificable. Ámbito: núcleo.

### P4. Consumo y coste por instancia

- **Ámbito**: núcleo.
- **Problema**: el panel muestra respuestas por día y mes del chat web, pero no los tokens
  consumidos ni el gasto estimado, y WhatsApp no tiene un tope de gasto equivalente.
- **Alcance**:
  - Registrar por respuesta los tokens de entrada y salida y el modelo usado, **sin** guardar
    textos.
  - Vista en el panel con el consumo del día y del mes por canal y el coste estimado con precios
    configurables.
  - Tope mensual de gasto por instancia, común a todos los canales, que al alcanzarse hace que el
    bot responda con el contacto del negocio (Principio V: siempre hay salida a una persona).
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

### P6. Versión visible y actualización escalonada

- **Ámbito**: núcleo (operación).
- **Problema**: con varias instancias no es fácil saber qué versión corre cada una ni comprobar
  que una actualización ha ido bien.
- **Alcance**:
  - Versión del núcleo y versión del esquema de BD visibles en el panel y en un endpoint de salud
    (`/health`) sin datos sensibles.
  - Guía de publicación: etiquetado semántico, instancia de pruebas, copia previa (P3), tandas,
    vuelta atrás.
  - Norma de migraciones aditivas y compatibles hacia atrás durante al menos una versión.
- **Texto para `/speckit-specify`**:
  > Exponer la versión del núcleo y del esquema de base de datos en el panel y en un endpoint de
  > salud, y definir el procedimiento de publicación escalonada con instancia de pruebas, copia
  > previa, migraciones compatibles hacia atrás y vuelta atrás. Ámbito: núcleo.

---

## 9. Resumen de reglas

1. Una imagen para todos; un entorno y una BD por cliente.
2. Secretos, credenciales y clave de Anthropic nuevos para cada cliente, nunca copiados.
3. La información del negocio se registra en el panel de su instancia; el cliente no la edita.
4. Nada específico de un cliente o sector en `src/`.
5. Antes de actualizar: tests, evaluación, instancia de pruebas y copia de seguridad.
6. Lo que no cabe en la configuración se resuelve con una spec, primero de núcleo si es genérico y
   de extensión solo si es realmente particular.
