# Contrato: el tema en `app.css`

Forma que debe tener [src/admin/views/app.css](../../../src/admin/views/app.css) después de la
feature. Lo que aquí se afirma se comprueba leyendo el fichero en
`tests/unit/admin/theme-css.test.ts`, salvo lo marcado como validación manual.

## 1. Estructura: una paleta y cuatro bloques de mapeo

```css
:root {
  /* Paleta clara (la de hoy) — cada color, una sola vez. */
  --c-light-bg: #f6f7f9;  /* … 16 tokens … */
  /* Paleta oscura. */
  --c-dark-bg: #11151b;   /* … los mismos 16 … */
  /* Colores que no cambian con el tema (R8). */
  --fixed-sample: #fff;
  --fixed-canvas-a: #f6f7f9;
  --fixed-canvas-b: #eef0f3;

  /* Mapeo 1 de 4: claro por omisión. */
  color-scheme: light;
  --bg: var(--c-light-bg);
  /* … los 16 tokens de trabajo … */
}

/* Mapeo 2 de 4: oscuro si lo pide el sistema y el operador no ha forzado claro. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --bg: var(--c-dark-bg);
    /* … los mismos 16 … */
  }
}

/* Mapeo 3 de 4: oscuro forzado por el operador. */
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: var(--c-dark-bg);
  /* … los mismos 16 … */
}

/* Mapeo 4 de 4: al imprimir, siempre claro (FR-021). */
@media print {
  :root {
    color-scheme: light;
    --bg: var(--c-light-bg);
    /* … los mismos 16 … */
  }
}
```

## 2. Reglas que el test comprueba

1. **Mismo conjunto de tokens en los cuatro mapeos**: los cuatro declaran exactamente los 16 tokens
   de trabajo de [data-model.md §2.1](../data-model.md), ni uno más ni uno menos. Es lo que impide
   que un token nuevo se olvide en uno de los bloques y deje una zona del tema contrario (FR-018).
2. **Ningún literal en los mapeos**: en los cuatro bloques, el valor de cada token es
   `var(--c-light-*)` o `var(--c-dark-*)`. Los colores solo aparecen en la paleta.
3. **`color-scheme` en los cuatro**: `light` en los claros, `dark` en los oscuros (R7).
4. **Sin literales fuera de la paleta**: no queda ningún color escrito a mano en el resto del
   fichero, salvo los tres tokens fijos y los dos usos del cuadriculado. En concreto desaparecen
   los trece de hoy: `#e8f5ec`, `#b7dcc4`, `#fdecea`, `#f1b7b2`, los seis `#fff` de campos y
   botones, el `#fff` del texto sobre el color primario y el par del cuadriculado, que pasa a
   `--fixed-canvas-a/-b`.
5. **Paleta clara idéntica a la de hoy** (FR-005): los 16 valores `--c-light-*` son exactamente los
   que el panel usa antes de la feature.
6. **Contrastes**: todas las parejas de [data-model.md §2.4](../data-model.md) cumplen su mínimo con
   `contrastRatio` de `src/webchat/design/contrast.ts` (4,5 para texto, 3 para bordes y foco).
7. **Foco visible**: existe una regla `:focus-visible` con `outline` de 2 px y
   `outline-offset`, en color `var(--accent)` (FR-015).

## 3. Reglas nuevas o cambiadas, además de los tokens

| Regla | Cambio |
|---|---|
| `input`, `select`, `textarea` | `background: var(--field)`; `border-color: var(--control-line)` |
| `button`, `a.button` | `color: var(--on-accent)` |
| `button.secondary`, `button.danger`, `a.button.secondary`, `a.button.danger` | `background: var(--field)` |
| `.msg-operator .bubble` | `color: var(--on-accent)` |
| `.flash` | `background: var(--flash-bg)`; `border-color: var(--flash-line)` |
| `.general-error` | `background: var(--error-bg)`; `border-color: var(--error-line)` |
| `.preview-frames iframe` | cuadriculado con `var(--fixed-canvas-a)` y `var(--fixed-canvas-b)` |
| `.design-image img`, `.color-pair input[type='color']` | `background: var(--fixed-sample)` |
| `:focus-visible` | nueva: `outline: 2px solid var(--accent); outline-offset: 2px` |
| `.theme-switch` | nueva: el control en la barra superior y en la pantalla de acceso |

## 4. Lo que no cambia

- Ninguna medida, tipografía, radio ni disposición: la feature solo toca color (FR-005).
- `frame.css` del chat web y la hoja del diseño del negocio: otro documento, otro origen de estilos
  (FR-019, FR-023).
- El resto de la hoja conserva su `Cache-Control: public, max-age=3600`: es la misma hoja para los
  dos temas.

## 5. Validación manual (quickstart)

Ningún test juzga la apariencia: que el oscuro resulte cómodo, que los avisos críticos sigan
saltando a la vista y que no quede ninguna zona rara se comprueban a ojo con la lista de
[quickstart.md](../quickstart.md).
