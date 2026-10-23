# Guía de validación: proveedor del modelo configurable

**Feature**: `017-proveedor-modelo-configurable` | **Fecha**: 2026-10-13

Recorridos que demuestran que la feature funciona de punta a punta. Los apartados §1 a §3 no
cuestan dinero ni necesitan credenciales. Los apartados §4 y §5 **sí** gastan: necesitan una
credencial real por proveedor.

## 0. Antes de empezar

```bash
pnpm install                 # añade los SDK de los dos proveedores nuevos (R16)
pnpm lint && pnpm typecheck
docker compose up -d db
pnpm db:migrate              # aplica 0009_unmeasured_usage.sql
```

**Aviso de esta máquina**: si `pnpm install` falla por certificado, comprueba el emisor antes de
seguir. Si sale Avast, hay que desactivar su análisis HTTPS:

```bash
echo | openssl s_client -connect registry.npmjs.org:443 -servername registry.npmjs.org 2>/dev/null | openssl x509 -noout -issuer
```

## 1. La suite, sin red y sin credenciales (SC-011, FR-038)

```bash
pnpm test
```

**Esperado**: todo en verde, con los tres proveedores cubiertos por sus dobles
(`tests/fixtures/llm/`). Ninguna prueba hace red ni lee una credencial real.

**Comprobación adicional** — que la costura es un punto único (SC-008):

```bash
# Debe encontrar las variables de credencial SOLO en src/llm/
grep -rn "ANTHROPIC_API_KEY\|GEMINI_API_KEY\|OPENAI_API_KEY" src/
# Debe encontrar los SDK SOLO en src/llm/
grep -rln "@anthropic-ai/sdk\|@google/genai\|from 'openai'" src/
```

La prueba estática del contrato ([llm-provider.md](contracts/llm-provider.md) §2) ya vigila esto,
pero conviene verlo con los propios ojos una vez.

## 2. El bot responde con cada proveedor (US1)

Con el proveedor declarado en `.env` y su credencial puesta:

```bash
pnpm kb:snapshot             # la vista del bot, sin cambios
pnpm bot:chat                # conversación en terminal, modelo real
```

Repetir con los tres valores de `LLM_PROVIDER`. En cada uno:

| Qué preguntar | Qué debe pasar |
|---|---|
| Un dato que el negocio tiene registrado | lo contesta con ese dato |
| Un dato que **no** tiene registrado | reconoce que no lo tiene y ofrece el contacto (Principio IV) |
| «Quiero hablar con una persona» | deriva con el mecanismo configurado (Principio V) |

**La derivación es la parte crítica** (FR-013a): es la que usa el segundo puerto de proveedor. Si
conversa bien y falla al derivar, el resumidor no se migró.

Y por el panel, con `pnpm dev`:

- `http://localhost:3000/admin` → ninguna pantalla nombra al proveedor (FR-008, SC-006).
- El chat web del visitante responde igual con los tres.

> `localhost` resuelve a `::1` y el servidor escucha solo en IPv4. Si no entra, prueba
> `127.0.0.1:3000`. Y para dejar `pnpm dev` vivo, lánzalo con `Start-Process` desde PowerShell.

## 3. La comprobación previa caza la credencial equivocada (US2, SC-003)

El recorrido que cierra el agujero. **Lo lanza el usuario**: Claude no puede leer ficheros de
entorno de producción.

### 3.1 Credencial de otro proveedor (sin red)

Prepara un entorno de prueba que declare `LLM_PROVIDER=anthropic` y ponga en `ANTHROPIC_API_KEY`
una credencial con forma de Gemini (`AIza…` o `AQ.…`):

```bash
pnpm instance:check <entorno>
```

**Esperado**: **no apto**, con `llm_key_other_provider`, el nombre de la variable, a qué proveedor
parece pertenecer y qué hacer. **Sin un solo carácter de la credencial** (FR-032, SC-004).

> Hoy, antes de esta feature, este mismo caso **pasa** la comprobación con un simple aviso. Merece
> la pena ejecutarlo en `main` primero para ver el fallo que se está corrigiendo.

### 3.2 Forma no reconocida

Una credencial con un prefijo que no es de ninguno de los tres.

**Esperado**: **apto**, con el aviso `llm_key_format`. No se rechaza lo que no se reconoce (R3).

### 3.3 Credenciales sobrantes

Un entorno que declara un proveedor y aporta además la credencial de otro.

**Esperado**: apto, con un aviso `llm_key_unused` por cada credencial sobrante (FR-033).

### 3.4 La validación con red es opcional

```bash
pnpm instance:check <entorno>                        # local, sin red (SC-009)
pnpm instance:check <entorno> --validar-credencial   # con llamada real
```

| Caso | Esperado |
|---|---|
| Credencial buena, con bandera | apto, sin incidencias |
| Credencial revocada, con bandera | **no apto**, `llm_key_rejected` |
| Sin red, con bandera | **apto**, aviso `llm_key_unverified` |
| Sin red, sin bandera | apto, **sin** mención a la validación |

Las dos últimas filas son la prueba de que «no se comprobó» y «no se pudo comprobar» no se
confunden (FR-030a).

## 4. La credencial rechazada degrada en vez de matar (US2.7, SC-010)

Necesita una credencial real revocada o caducada del proveedor declarado.

1. Arranca la instancia con esa credencial.
2. **Esperado**: arranca. No hay bucle de reinicio. En el panel hay un aviso **crítico** de
   credencial rechazada, y un cliente del chat web recibe **solo el contacto del negocio**.
3. Pon la credencial buena **sin reiniciar**.
4. **Esperado**: en 5 minutos como mucho, la instancia sale del degradado sola, el aviso desaparece
   y el bot vuelve a contestar. Una línea de registro al entrar en degradado y una al salir; **no**
   una por petición.

Y el caso contrario, sin red al arrancar:

5. Arranca sin salida a internet. **Esperado**: arranca con normalidad, **no** degradado, con una
   línea de registro de que la comprobación no concluyó (FR-005c).

## 5. El consumo no medido no se confunde con cero (US3, SC-005, SC-012)

Con los dobles, en la suite, se cubre la lógica. A mano, en el panel, se comprueba la presentación:

| Qué mirar | Esperado |
|---|---|
| Escritura de caché con Gemini u OpenAI | **«sin dato»**, no `0`, con nota que **no** nombra al proveedor |
| Lectura de caché | un número en los tres |
| Totales con un concepto «sin dato» | marcados como incompletos, sin sumar el hueco como cero |
| Respuestas no medidas | recuento visible |
| Aviso de consumo no medido | **crítico** solo con el tope activado y el negocio activo; normal en los demás casos |

Y el caso del cambio de proveedor:

```bash
# Cambia LLM_PROVIDER y LLM_MODEL a otro proveedor y arranca
```

**Esperado**: salta el aviso de «modelo sin precio» que ya existía y los clientes reciben solo el
contacto, hasta que el operador registre el precio del modelo nuevo (FR-027, US3.4). El histórico
del proveedor anterior **no** se recalcula.

## 6. La evaluación, por proveedor (US5, FR-035)

**Obligatoria en esta feature.** Según `docs/operacion-multicliente.md` §5.1, una versión que toca
`src/conversation`, `src/knowledge`, los prompts o el modelo exige evaluación; esta los toca todos.

```bash
# Una corrida por proveedor, con su modelo y el esfuerzo por defecto
pnpm test:eval
```

Para cada proveedor hay que anotar en `docs/operacion-multicliente.md`: proveedor, modelo, esfuerzo,
fecha y veredicto.

**Si un proveedor no alcanza el criterio** (FR-036): se le da un `LLM_EFFORT` por defecto propio,
razonado, y se reevalúa. Si sigue sin alcanzarlo, **no se declara elegible** en esta versión, y eso
se escribe.

> Esto cuesta dinero y está fuera de `pnpm test` a propósito. Ninguna de las dos cosas es
> negociable en esta feature.

---

## Resultado del recorrido (T080) - 2026-10-23

Recorrido con el alcance que decidio el usuario: **Gemini** como proveedor nuevo a probar contra su
API real, **OpenAI pendiente** hasta que un cliente lo pida.

### 0. Antes de empezar

Nada que instalar: el entorno ya estaba montado del tramo anterior.

**Hallazgo resuelto**: `/health` respondia `degraded`. No era la feature: la BD de desarrollo habia
aplicado una version distinta del fichero `0009_unmeasured_usage.sql` -se aplico en el tramo 1 y
despues T021a le anadio el comentario de cabecera-, y `sameSchema` compara indice, etiqueta **y
hash**. El esquema aplicado era el correcto, verificado columna a columna. Con el visto bueno del
usuario se actualizo el hash de esa fila de `drizzle.__drizzle_migrations`; `/health` paso a `ok`.

### 1. La costura es un punto unico (SC-008) - CORRECTO

| Comprobacion | Resultado |
|---|---|
| Variables de credencial en `src/` | Solo en `src/llm/provider.ts` y en la **excepcion documentada** `src/config/env.ts` |
| SDK de proveedor en `src/` | Solo en `src/llm/`; el unico `@google/genai` de `capabilities.ts` esta en un comentario, no en un importe |

`pnpm test` **no se lanzo en este recorrido**; su resultado esta en la seccion «Estado real de la
puerta de calidad» de [tasks.md](tasks.md).

### 2. El bot responde con Gemini - CORRECTO

`LLM_PROVIDER=gemini`, `LLM_MODEL=gemini-3.5-flash-lite`, negocio real cargado en la BD de
desarrollo. Las tres preguntas, en una sola respuesta agrupada:

| Que se pregunto | Que contesto |
|---|---|
| Dato registrado: «A que hora abris los lunes?» | «Los lunes abrimos de 09:00 a 20:00» CORRECTO |
| Dato no registrado: «Haceis fisioterapia?» | «No disponemos del servicio de fisioterapia» CORRECTO (Principio IV) |
| «Quiero hablar con una persona» | Dio el contacto del negocio CORRECTO (Principio V) |

Y la comprobacion del arranque: **el vigilante no dejo ninguna linea**, y solo calla cuando el
veredicto es `accepted`. La credencial de Gemini se verifico contra su API real al arrancar.

**Hallazgo del SDK, comprobado, y no es un fallo.** `@google/genai` imprime
«Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY» cuando las dos estan en el
entorno -en esta maquina `GOOGLE_API_KEY` esta definida a nivel de sistema-. El aviso es
**enganoso**: el SDK resuelve `options.apiKey ?? envApiKey`, asi que la credencial que le pasa el
adaptador **gana**. Comprobado con una prueba, no deducido: con la declarada invalida y la del
sistema valida, la llamada **falla**. `GOOGLE_API_KEY` no actua de respaldo (FR-004, FR-005).

**Lo que queda para el usuario**: la mirada al panel. Claude no tiene la contrasena del operador.

### 3. La comprobacion previa caza la credencial equivocada - CORRECTO, con un fallo encontrado y corregido

Con entornos sinteticos y un inventario de usar y tirar, fuera del repositorio. Ninguna credencial
real.

| Caso | Resultado |
|---|---|
| 3.1 Credencial de Gemini formato `AQ.` en `ANTHROPIC_API_KEY` | **NO APTO**, `llm_key_other_provider`, «parece una credencial de gemini», sin mostrar el valor |
| 3.2 Forma no reconocida | **APTO** con aviso `llm_key_format` (R3: no se rechaza lo desconocido) |
| 3.3 Credenciales sobrantes | **APTO** con un `llm_key_unused` por cada una (FR-033) |
| Control: `gemini` con su credencial y su modelo | **APTO**, sin incidencias |
| Extra: `gemini` **sin** `LLM_MODEL` | **NO APTO**: «LLM_MODEL es obligatoria con LLM_PROVIDER=gemini» (FR-001) |
| 3.4 Sin bandera | **APTO**, y **sin una palabra** sobre la validacion (SC-009) |
| 3.4 Con `--validar-credencial` y credencial inventada | **NO APTO**, `llm_key_rejected`, «el proveedor la rechaza» (FR-030) |

El ultimo caso **demuestra el arreglo de T053 en la orden real**: Gemini responde 400 a una clave
invalida, y antes del arreglo eso habria salido como `llm_key_unverified` -un aviso- y el entorno
habria quedado **apto**.

El caso «sin red, con bandera» no se recorrio: no se simulo el corte de red. Lo cubren los tests
unitarios de `credential-probe` (5xx, fallo de red, DNS y plazo agotado dan `inconclusive`).

#### Fallo encontrado recorriendo 3.1, y corregido

Una clave **clasica** de Gemini (`AIza...`) tiene **39** caracteres y el minimo de la variable de
Anthropic es **40**. Al pegarla en `ANTHROPIC_API_KEY` saltaba `secret_too_short`, y una supresion
heredada de la 007 -«no apiles hallazgos sobre una variable que ya fallo», en
`src/provisioning/check.ts`- impedia que `llm_key_other_provider` **se emitiera**. Ni en `--json`.

El agujero seguia cerrado -el entorno quedaba **no apto**- pero el mensaje decia «es demasiado
corta», asi que el operador se iba a buscar una clave mas larga del proveedor equivocado en lugar
de enterarse de que la habia puesto en la variable que no era. Es el error **mas probable**, porque
`AIza...` es el formato de la mayoria de las claves de Gemini en circulacion, y pasaba justo en la
comprobacion que existe para cazarlo.

Corregido: un error de calidad ya no silencia el diagnostico de proveedor equivocado, que es el que
**explica** la longitud. La supresion sigue en pie para todo lo demas. Dos pruebas de regresion en
`tests/unit/provisioning/check.test.ts`.

### 5. El consumo no medido no se confunde con cero - CORRECTO en los datos

Una llamada real de Gemini por el **canal medido** (chat web) dejo esta fila:

| `calls` | `unmeasured_calls` | `input` | `output` | `cache_write` | `cache_read` | `currency` |
|---|---|---|---|---|---|---|
| 1 | 0 | 4302 | 763 | **NULL** | **0** | NULL |

Es FR-024 de punta a punta: **NULL** donde el proveedor no informa del concepto y **0** donde si
informa y fue cero. Y la insercion **no fallo** con el nulo dentro, que es la trampa de T022a -el
`coalesce` del coste- aguantando en condiciones reales. `currency` nulo porque
`gemini-3.5-flash-lite` no tiene precio registrado: es el camino de «modelo sin precio» (FR-027).

**Aviso para quien lo mire**: `pnpm bot:chat` **no** registra consumo -es una herramienta de
conversacion, no un canal medido-, asi que para ver filas hay que hablar por el chat web o por el
panel.

**Lo que queda para el usuario**: la presentacion en el panel («sin dato» frente a `0`, la nota
generica, el recuento de respuestas no medidas). La cubre el test de contrato
`tests/contract/admin/usage-no-data.test.ts`, pero la mirada a mano sigue pendiente.

### 4 y 6. No recorridos, con razon

- **4** (credencial rechazada degrada): necesita una credencial real revocada del proveedor
  declarado. No se revoco ninguna. El ciclo completo -degradado, aviso critico, recuperacion sola,
  una linea al entrar y una al salir- lo cubre `tests/integration/llm/credential-degraded.test.ts`
  con el vigilante real.
- **6** (evaluacion por proveedor): **por decision del usuario**, Gemini y OpenAI no se evaluan
  hasta que un cliente los pida, igual que el canal de WhatsApp y los audios. La medida parcial de
  Gemini del 2026-10-14 esta en `docs/operacion-multicliente.md` 4.3.

### Pregunta abierta: FR-008 y el nombre del modelo de Gemini

FR-008 dice que el panel **no** debe mostrar el nombre del proveedor en ninguna pantalla. El test
`tests/contract/admin/no-provider-leak.test.ts` lo vigila con una lista de prohibidos que incluye
los tres nombres de proveedor, y documenta una excepcion deliberada: **el nombre del modelo si puede
aparecer**, porque la tabla de precios esta indexada por el y es un valor que el operador escribio.

Con Anthropic y con OpenAI la excepcion no choca: `claude-...` y `gpt-...` no contienen «anthropic»
ni «openai». **Con Gemini si**: `gemini-3.5-flash-lite` contiene literalmente «gemini», asi que una
instancia de Gemini muestra el nombre del proveedor en la pantalla de consumo.

El test no lo detecta porque corre con un modelo de prueba de nombre neutro, asi que **da confianza
de mas** para las instancias de Gemini. No es una fuga de secretos -el proveedor no es un secreto-
pero o FR-008 se matiza por escrito («el panel no nombra al proveedor *como tal*; de la
configuracion del operador se puede inferir») o hay que decidir ocultar el nombre del modelo, lo que
romperia la pantalla de precios. **Sin decidir.**

### Estado del entorno al terminar

- `.env` quedo en **`LLM_PROVIDER=gemini`** con `LLM_MODEL=gemini-3.5-flash-lite`, para que se
  pueda mirar el panel con el caso interesante. **Antes de cerrar la feature hay que devolverlo a
  Anthropic** (condicion (c) de T043a). Hay copia del original en el scratchpad de la sesion.
- Servidor de desarrollo **levantado** en `http://localhost:3000/admin`.

---

## 7. Antes de dar la feature por cerrada

- [ ] `pnpm lint && pnpm typecheck && pnpm test` en verde
- [ ] §1 a §3 recorridos
- [ ] §4 recorrido con una credencial rechazada real
- [ ] §5 comprobado en el panel
- [ ] §6 con una corrida por proveedor y sus resultados anotados
- [ ] Tabla de capacidades por proveedor escrita en `docs/operacion-multicliente.md` (FR-021), con
      prueba por fila
- [ ] `docs/operacion-multicliente.md` §9.1 (tabla de specs realizadas, con fecha), §9.2 (la 017
      adelanta a P7, con su razón) y las secciones de operación que cambien
- [ ] `README.md` actualizado, **avisando antes al usuario**
- [ ] Al desplegar la 0.1.3, comprobar de paso que la preferencia de tema del panel sobrevive a la
      actualización (lo que quedó pendiente en la T030 de la 014)
