# Contrato: comportamiento de la instancia durante un corte de la base de datos

**Feature**: 016-db-outage-resilience · Cubre FR-001 a FR-005, FR-012 y FR-014.

Este contrato describe qué hace cada parte de una instancia **ya arrancada** cuando su base de
datos deja de estar disponible, y qué hace cuando vuelve. El arranque sin base de datos no
cambia: sigue terminando el proceso.

---

## 1 · El proceso no termina

| Situación | Antes | Ahora |
|---|---|---|
| Conexión **ociosa** del pool principal que se cae | el pool emite `error` sin oyentes → el proceso termina | el oyente del pool lo recoge, avisa al vigilante y devuelve |
| Conexión ociosa del pool público | igual | igual |
| Conexión ociosa del pool del sondeo de salud | ya estaba recogido | además avisa al vigilante |
| Consulta **en vuelo** que falla | la promesa se rechaza | sin cambios: la promesa se rechaza |
| Cliente del cerrojo de instancia | oyente registrado tras conectar | oyente registrado al construirlo |
| Cliente de inspección de migraciones | sin oyente | con oyente |

**Garantía.** Ninguna construcción de `pg.Pool` ni de `pg.Client` en `src/` queda sin su oyente
de `error`. Se comprueba con una prueba estática del código, no solo con las de comportamiento
(criterio verificable de FR-005).

**Lo que no cambia.** El oyente del pool no responde a nadie y no reintenta: quien hizo la
consulta recibe su rechazo y decide, con las reglas que ya escribió la 012.

---

## 2 · Registro del corte

Un corte de cualquier duración deja **un número acotado** de anotaciones (FR-014, SC-008):

```text
db_outage_started                                     ← una vez, al detectarlo
db_outage_ongoing   { elapsedMs, failures }           ← una cada 5 min de corte
db_outage_recovered { durationMs, failures }          ← una vez, al volver
```

- Un corte de una hora deja 13 anotaciones; un corte de 20 s, dos.
- El volumen no crece con el número de peticiones ni de reintentos.
- Ningún evento lleva texto libre, dirección de base de datos, host ni credencial (FR-012).
- La recuperación la determina un sondeo propio (`select 1` cada 10 s), no la primera petición
  que acierte: así se registra aunque no llegue tráfico.

---

## 3 · Respuesta al cliente final, por canal (FR-002)

Las reglas de contacto son las que ya existen: el contacto del negocio si se puede leer su
información, y el **teléfono de emergencia de la instancia** si no. Durante un corte no se puede
leer, así que en la práctica se usa el de emergencia.

### 3.1 · Chat web

| Petición | Durante el corte |
|---|---|
| `POST /chat/api/messages` | **503** con `{ unavailable: { reason: 'no_bot', message, contact } }`; `contact` es el teléfono de emergencia |
| `GET /chat/api/state` | `503 { error: 'busy' }` o la respuesta `unavailable`, según dónde falle |
| `GET /chat/frame` | se sirve «no disponible» con el último contacto conocido |

La interfaz deja de indicar espera y muestra el aviso con el contacto en **menos de 10 s**
(SC-001). Esto ya estaba implementado por la 012; lo nuevo es que ahora se ejecuta, porque el
proceso vive.

### 3.2 · WhatsApp

| Paso | Comportamiento |
|---|---|
| Llega un mensaje y guardar falla por indisponibilidad | se envía al cliente, por el canal, `errorReply('tu')` + `emergencyContact(teléfono)` |
| El mismo cliente escribe otra vez en el mismo corte | **no** se repite el aviso |
| Meta reintenta el mismo mensaje | **no** se repite el aviso |
| Respuesta del webhook | **503**, como hasta ahora: Meta reintenta y, si la base vuelve a tiempo, el mensaje se procesa de verdad |
| La instancia no tiene teléfono de emergencia o el canal no tiene remitente | no se envía nada; se registra `db_degraded_reply_skipped` |
| El corte se recupera y vuelve a empezar | se vuelve a avisar: la memoria del aviso se vacía al recuperar |

El envío no toca la base de datos y, por tanto, **no se guarda** como mensaje saliente: queda en
el registro como `db_degraded_reply_sent` con el seudónimo del cliente, nunca su número.

### 3.3 · Ningún canal queda sin respuesta

Cualquier canal del núcleo que reciba mensajes del cliente final pasa por la recepción común y,
por tanto, por el envoltorio degradado. Añadir un canal nuevo sin respuesta durante el corte
exige saltarse la recepción común, que es lo que prohíbe FR-002.

---

## 4 · Comprobación de salud (`GET /health`)

| Estado | Código | Nivel público | Nivel completo |
|---|---|---|---|
| `ok` | 200 | `{ "status": "ok" }` | informe completo |
| `db_unavailable` | **200** | `{ "status": "db_unavailable" }` | informe con `schema.applied: null` y `spendCap: null` |
| `degraded` | 503 | `{ "status": "degraded" }` | informe |
| `not_ready` | 503 | `{ "status": "not_ready" }` | informe |

**Regla.** `db_unavailable` cuando la base de datos **no contesta** (conexión imposible o sondeo
fuera de plazo). `degraded` cuando **sí contesta** pero su esquema está vacío, es desconocido o
no es el esperado. La diferencia es la que importa al operador: lo primero pasa solo, lo segundo
hay que arreglarlo.

**Consecuencias en el despliegue.**

- La sonda de la imagen (`node dist/src/cli/healthcheck.js`) sale con **0** con `ok` y con
  `db_unavailable`; con cualquier otra cosa, 1. El contenedor **no pasa a `unhealthy`** por un
  corte de la base de datos, así que ninguna política de reinicio tiene motivo para reiniciarlo
  (FR-003, SC-002).
- `instance:versions` acepta el valor nuevo y lo muestra como estado propio; sin ese cambio daría
  `invalid_response` en toda instancia con la base caída.
- El resto del contrato de `/health` de la 009 no cambia: dos niveles, mismo 401 para cualquier
  credencial que no sea la de la instancia, `Cache-Control: no-store` y límite de 30 peticiones
  por minuto.

---

## 5 · Recuperación (FR-004)

| Lo que vuelve | Cómo |
|---|---|
| Las lecturas y escrituras del bot | el pool abre conexiones nuevas en la siguiente petición; sin reinicio |
| El panel del operador | igual; **las sesiones abiertas siguen valiendo**, porque el proceso nunca murió |
| El procesador de conversaciones | los lotes pendientes se reintentan con la espera creciente de la 012 |
| El registro | una anotación `db_outage_recovered` |

Todo ello **sin reiniciar el proceso y sin intervención del operador**, en menos de 30 s desde
que la base vuelve (SC-003).

**Fuera de alcance.** Que la base vuelva con otra identidad (restauración, cambio de servidor):
lo cubre la comprobación de esquema del arranque, no esta corrección.
