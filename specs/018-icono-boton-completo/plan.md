# Implementation Plan: Icono del botón a tamaño completo y datos que el bot no ha guardado

**Branch**: `018-icono-boton-completo` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/018-icono-boton-completo/spec.md`

## Summary

Dos cambios pequeños del núcleo que salen juntos en la **0.1.4**:

1. **Icono a tamaño completo** (US1): solo CSS en `src/channels/web/assets/frame.css`. El icono
   propio pasa a cubrir todo el botón (`object-fit: cover`, recortado con el `border-radius` del
   botón) y un anillo de 3 px del color principal se dibuja **encima** del borde de la imagen con un
   pseudoelemento del botón, de modo que el grosor es exacto con las tres formas. Sin icono, nada
   cambia. La vista previa del panel usa el mismo `frame.css` (011), así que no hay que tocarla.
2. **Regla de los datos no guardados** (US2): una regla nueva en las reglas comunes del prompt
   (`src/llm/prompt.ts`, `RULES`), con prueba unitaria del texto y un caso de evaluación con el
   modelo real.

Sin migración, sin datos nuevos, sin cambio de `formatVersion` ni de rutas.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node.js 22; CSS y JS del iframe sin compilar

**Primary Dependencies**: Fastify 5 (sirve `frame.css` tal cual), Eta (plantilla del frame, sin cambios)

**Storage**: N/A (no cambia la BD)

**Testing**: Vitest — unitario del prompt (`tests/unit/llm/prompt.test.ts`), contrato del CSS servido
(`tests/contract/web-chat-design.test.ts`) y evaluación con el modelo real (`tests/eval/`, fuera de
`pnpm test`, con coste)

**Target Platform**: navegadores actuales en la web del negocio (iframe del chat); servidor Linux en Docker

**Project Type**: servicio web (instancia por cliente)

**Performance Goals**: N/A (una regla de CSS y una frase más en el prompt, ~70 tokens)

**Constraints**: no cambiar tamaño ni posición del botón ni del iframe (72 px cerrado); sin icono, el
botón idéntico al de antes; regla sin nombres de sector ni de cliente (`sector-neutrality.test.ts`)

**Scale/Scope**: 2 ficheros de `src/`, 3 de pruebas; versión 0.1.4 desplegada en las 3 instancias

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Cumple | Cómo |
|---|---|---|
| I. Base común única | Sí | Cambios genéricos del núcleo; ningún nombre ni rama por cliente o sector (lo vigila `sector-neutrality.test.ts`) |
| II. Configuración antes que código | Sí, justificado | El tamaño del icono no se hace configurable: hoy todos los iconos propios son logos y las instancias sin icono no cambian. Si un negocio necesitara el icono pequeño, la opción se añade con otra spec (ver Complexity Tracking) |
| III. Personalizaciones aisladas | Sí | No hay extensión; nada específico de un cliente |
| IV. Solo información registrada | **Refuerza** | La regla nueva prohíbe afirmar un hecho falso (datos guardados, contacto prometido); con prueba unitaria y evaluación |
| V. Siempre hay salida a una persona | **Refuerza** | En lugar de una promesa vacía, el bot remite al negocio y marca `offerContact`, que añade el contacto o la oferta de derivación; el flujo de derivación no cambia |
| VI. El operador registra la información | Sí | No se expone nada al negocio |
| Flujo: comportamientos IV y V probados | Sí | Prueba unitaria de la regla + caso de evaluación (SC-003) + derivación de prueba en el chat real (SC-004) |

**Post-diseño**: sin cambios; el diseño no añade datos ni flujos.

## Project Structure

### Documentation (this feature)

```text
specs/018-icono-boton-completo/
├── plan.md              # este fichero
├── research.md          # decisiones de diseño (Fase 0)
├── quickstart.md        # cómo validarlo (Fase 1)
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

No hay `data-model.md` ni `contracts/`: no hay entidades ni interfaces nuevas. El CSS servido en
`/chat/assets/frame.css` ya está cubierto por las pruebas de contrato de la 011.

### Source Code (repository root)

```text
src/
├── channels/web/assets/frame.css   # US1: .toggle .design-icon a tamaño completo + anillo
└── llm/prompt.ts                   # US2: regla nueva en RULES

tests/
├── contract/web-chat-design.test.ts   # US1: el CSS servido lleva la regla del icono y el anillo
├── unit/llm/prompt.test.ts            # US2: el prompt lleva la regla
└── eval/sc-unsaved-contact.test.ts    # US2: SC-003 con el modelo real (pnpm test:eval)

package.json                         # versión 0.1.4
docs/operacion-multicliente.md       # §2.6 (icono, tono), §9.1 (spec realizada)
docs/alta-cliente-paso-a-paso.md     # el párrafo del tono pasa a opcional; icono resuelto
```

**Structure Decision**: proyecto único existente; solo se tocan los ficheros de arriba.

## Complexity Tracking

| Decisión | Por qué | Alternativa descartada |
|---|---|---|
| Cambio de aspecto sin opción en el panel (Principio II) | Ninguna instancia actual con icono propio lo quiere pequeño; las que no tienen icono no cambian | Opción por instancia (borrador anterior de esta spec): migración, `formatVersion`, formulario y exportación para un caso que hoy no existe |
