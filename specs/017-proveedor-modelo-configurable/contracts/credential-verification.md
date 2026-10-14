# Contrato: verificación de la credencial del proveedor

**Feature**: `017-proveedor-modelo-configurable` | **Fecha**: 2026-10-13

Dos consumidores, un solo mecanismo. La comprobación previa al despliegue
(`pnpm instance:check`) y la comprobación del arranque de la instancia usan la **misma** función de
verificación y la **misma** clasificación, pero **toman decisiones distintas** con el resultado.

## 1. La verificación

`src/llm/credential-probe.ts`:

```text
verifyCredential(provider, apiKey, { signal, timeoutMs }): Promise<CredentialVerdict>
CredentialVerdict = 'accepted' | 'rejected' | 'inconclusive'
```

| Respuesta del proveedor | Veredicto |
|---|---|
| 2xx | `accepted` |
| 401, 403 | `rejected` |
| 400 **cuyo cuerpo dice que la credencial no vale** | `rejected` (medido en T053: Gemini responde así a una clave `AIza…` incorrecta) |
| 5xx, fallo de red, DNS, plazo agotado, otros 400, cualquier otra cosa | `inconclusive` |

- Petición: `GET` al extremo de **listado de modelos** del proveedor, que no genera tokens
  (FR-031).
- Cabeceras: `x-api-key` + `anthropic-version` (Anthropic), `Authorization: Bearer` (OpenAI),
  `x-goog-api-key` (Gemini).
- Plazo: 5 s. Un plazo corto, porque un `inconclusive` no es un problema en ninguno de los dos
  consumidores.
- **Nunca** registra ni devuelve ningún carácter de la credencial (FR-032).

**Requisito de implementación (R5)**: para cada proveedor hay que comprobar que una credencial
inválida devuelve 401 o 403 y fijarlo con una prueba. Si algún proveedor devolviera 2xx sin
credencial válida, para él se usa la petición de generación más pequeña posible y se anota el coste.

## 2. Consumidor A · La comprobación previa (`instance:check`)

### 2.1 Sin red, siempre: el clasificador de forma

Se ejecuta **siempre**, no necesita red, y es el que cierra el agujero real (FR-028).

| Caso | Código | Severidad | Efecto |
|---|---|---|---|
| La credencial encaja con el patrón de **otro** proveedor elegible | `llm_key_other_provider` | **error** | entorno **no apto** |
| La forma no se reconoce | `llm_key_format` | aviso | sigue apto |
| Hay credenciales de otros proveedores elegibles sin usar | `llm_key_unused` | aviso | sigue apto (FR-033) |

**Cambio respecto de hoy**: `llm_key_format` existe ya y se emite como **aviso** cuando la clave no
empieza por `sk-ant-` (`src/provisioning/secrets.ts:73`). Por eso una clave de Gemini en
`ANTHROPIC_API_KEY` **pasa** la comprobación hoy. El código nuevo `llm_key_other_provider` es el que
pasa a ser error; `llm_key_format` se queda como aviso para la forma no reconocida, que por R3 no
debe bloquear.

El mensaje nombra la variable y a qué proveedor parece pertenecer la credencial, y **nunca** muestra
su valor.

### 2.2 Con red, solo si se pide: `--validar-credencial`

La bandera es **opt-in**. Sin ella, `instance:check` sigue siendo local y sin red (FR-029, SC-009).

| Veredicto | Código | Severidad | Efecto |
|---|---|---|---|
| `accepted` | — | — | nada que decir |
| `rejected` | `llm_key_rejected` | **error** | entorno **no apto** (FR-030) |
| `inconclusive` | `llm_key_unverified` | aviso | **sigue apto** (FR-030a) |

`llm_key_unverified` tiene que ser **distinguible** de no haber pedido la validación: si no se pidió,
no se emite nada. «No se comprobó» y «no se pudo comprobar» no pueden confundirse (FR-030a).

La comprobación previa sigue sin escribir nada, ni en el entorno ni en el inventario (FR-034).

## 3. Consumidor B · El arranque de la instancia

Se ejecuta **siempre**, y **nunca** impide arrancar (FR-005a).

| Veredicto | Efecto |
|---|---|
| `accepted` | nada. La instancia funciona con normalidad |
| `rejected` | **degradado declarado**: los clientes reciben solo el contacto del negocio; aviso **crítico** para el operador; reintento cada 5 min; sale del degradado sola cuando pase a `accepted` (FR-005b) |
| `inconclusive` | arranca con normalidad, **no** degrada, deja una línea de registro (FR-005c) |

### 3.1 Por qué no es fatal

Es la lección del Fallo 1 de la 016: un proceso que muere al arrancar porque una dependencia no
está produce un bucle de reinicio y 502 para todo el mundo. Además, el Principio V exige salida a
una persona; el degradado la da y el bucle de reinicio no.

### 3.2 Cadencia del reintento

5 minutos. Son como mucho 288 peticiones al día que no generan tokens, y acotan la recuperación
automática a 5 minutos después de arreglar la credencial. **Una** línea de registro al entrar en
degradado y **una** al salir; nunca una por petición.

### 3.3 Dónde se engancha

- `src/usage/protection.ts`: estado nuevo de credencial rechazada, que ya sabe degradar a «solo
  contacto del negocio» (es lo que hace con el modelo sin precio).
- `computeWarnings`: aviso crítico, calculado y nunca guardado.
- `src/webchat/availability.ts`: el motivo `no_bot` que ya existe cubre el caso de cara al
  visitante.

## 4. Tabla de decisión completa

| Situación | `instance:check` sin bandera | `instance:check --validar-credencial` | Arranque |
|---|---|---|---|
| Credencial de otro proveedor elegible | **no apto** | **no apto** | no arranca con proveedor a medias |
| Forma no reconocida, credencial válida | apto (aviso) | apto | funciona |
| Credencial del proveedor correcto, rechazada | **apto** (no se puede saber sin red) | **no apto** | arranca **degradado** + aviso crítico |
| Credencial correcta, sin red | apto | apto (aviso «no se pudo comprobar») | arranca normal |
| Falta la credencial del proveedor declarado | **no apto** | **no apto** | **no arranca** |

La casilla «apto» de la tercera fila es la razón de que el arranque también compruebe: es el único
consumidor que siempre tiene red y siempre se ejecuta.
