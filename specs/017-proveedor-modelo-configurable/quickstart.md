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
