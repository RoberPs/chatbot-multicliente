# Modelo de datos: Modo oscuro del panel del operador

**No hay tablas, ni migración, ni cambio de formato de configuración.** La feature no guarda nada en
la instancia: su único estado es una cookie en el navegador del operador (FR-010, R3). Este
documento describe ese estado y el conjunto de tokens de color, que es lo que sustituye al modelo de
datos en una feature de presentación.

## 1. Preferencia de tema

| Campo | Valor |
|---|---|
| Nombre de la cookie | `kb_theme` |
| Valores válidos | `light`, `dark` |
| Automático | **ausencia de cookie** (o valor no válido: se ignora, FR-011) |
| Ámbito | `Path=/admin` (cubre `/admin/login`) |
| Duración | `Max-Age=31536000` (un año) |
| Atributos | `HttpOnly`, `SameSite=Lax`, y `Secure` si `NODE_ENV === 'production'` |

### Tipo en TypeScript

```ts
/** Lo que el operador elige en el control. */
export type ThemeChoice = 'auto' | 'light' | 'dark';
/** Lo que se guarda en la cookie: 'auto' no se guarda, se borra. */
export type StoredTheme = 'light' | 'dark';
```

### Estados y transiciones

| Estado (cookie) | `<html>` | Qué manda | Al elegir `auto` | Al elegir `light` | Al elegir `dark` |
|---|---|---|---|---|---|
| ausente | sin atributo | preferencia del sistema | sigue igual | `kb_theme=light` | `kb_theme=dark` |
| `light` | `data-theme="light"` | claro siempre | cookie borrada (`Max-Age=0`) | sigue igual | `kb_theme=dark` |
| `dark` | `data-theme="dark"` | oscuro siempre | cookie borrada | `kb_theme=light` | sigue igual |
| valor desconocido | sin atributo | preferencia del sistema | cookie borrada | `kb_theme=light` | `kb_theme=dark` |

Reglas de validación:

- El valor se valida con un esquema Zod de la lista cerrada `['auto', 'light', 'dark']`; cualquier
  otra cosa en el formulario es `422` (contrato) y cualquier otra cosa en la cookie se trata como
  ausencia (FR-011).
- La cookie no se firma ni se cifra: no autoriza nada y su peor manipulación posible es que el
  operador vea el panel en el otro tema.
- La preferencia **no** se copia a la sesión, ni a la base de datos, ni al fichero de configuración,
  ni a las copias de seguridad.

## 2. Tokens de color

### 2.1 Tokens de trabajo (los que usan las reglas del CSS)

Nueve ya existen y siete son nuevos; los nuevos sustituyen colores que hoy están escritos a mano.

| Token | Para qué | Nuevo |
|---|---|---|
| `--bg` | fondo de la página y de las burbujas del bot | |
| `--card` | fondo de tarjetas, tablas, avisos y barra superior | |
| `--fg` | texto principal | |
| `--muted` | texto secundario, cabeceras de tabla, pie de versión | |
| `--line` | separadores y bordes de tarjeta | |
| `--accent` | enlaces, botones primarios, sección activa, foco | |
| `--ok` | estado correcto, añadido, activo | |
| `--warn` | aviso no crítico, borrador | |
| `--danger` | aviso crítico, error, acción destructiva | |
| `--on-accent` | texto sobre `--accent` (hoy `#fff` en 4 sitios) | ✅ |
| `--field` | fondo de campos y de botones secundarios (hoy `#fff` en 4 sitios) | ✅ |
| `--control-line` | borde de campos y controles | ✅ |
| `--flash-bg` / `--flash-line` | banda de «Guardado» (hoy `#e8f5ec` / `#b7dcc4`) | ✅ |
| `--error-bg` / `--error-line` | banda de error general (hoy `#fdecea` / `#f1b7b2`) | ✅ |

### 2.2 Paletas (cada color, escrito una sola vez)

| Token de trabajo | `--c-light-*` (= hoy) | `--c-dark-*` |
|---|---|---|
| `--bg` | `#f6f7f9` | `#11151b` |
| `--card` | `#ffffff` | `#181d26` |
| `--field` | `#ffffff` | `#0d1117` |
| `--fg` | `#1d2330` | `#e6e9ef` |
| `--muted` | `#5f6878` | `#a3adbd` |
| `--line` | `#d9dde4` | `#2c3442` |
| `--control-line` | `#d9dde4` | `#6b7686` |
| `--accent` | `#1f5fbf` | `#7fb0ff` |
| `--on-accent` | `#ffffff` | `#0b1017` |
| `--ok` | `#1f7a4a` | `#6cc98f` |
| `--warn` | `#9a6200` | `#e5b969` |
| `--danger` | `#b3261e` | `#ff9b91` |
| `--flash-bg` | `#e8f5ec` | `#102c1d` |
| `--flash-line` | `#b7dcc4` | `#3f8a5d` |
| `--error-bg` | `#fdecea` | `#331418` |
| `--error-line` | `#f1b7b2` | `#a85a60` |

### 2.3 Colores fijos (no cambian con el tema, R8)

| Token | Valor | Por qué |
|---|---|---|
| `--fixed-sample` | `#ffffff` | fondo de las miniaturas del logotipo y del avatar del negocio, y de `input[type='color']`: son imágenes y colores del cliente |
| `--fixed-canvas-a` | `#f6f7f9` | cuadriculado de detrás de la vista previa del chat: representa la web del negocio |
| `--fixed-canvas-b` | `#eef0f3` | la otra franja del cuadriculado |

### 2.4 Parejas con contraste comprobado

El test unitario `theme-css.test.ts` comprueba estas parejas en la paleta oscura con
`contrastRatio` ([src/webchat/design/contrast.ts](../../src/webchat/design/contrast.ts)).

| Pareja | Mínimo | Oscuro |
|---|---|---|
| `--fg` sobre `--bg` / `--card` / `--field` | 4,5 | 15,05 / 13,90 / 15,56 |
| `--muted` sobre `--bg` / `--card` | 4,5 | 8,08 / 7,46 |
| `--accent` sobre `--bg` / `--card` / `--field` | 4,5 | 8,33 / 7,69 / 8,61 |
| `--on-accent` sobre `--accent` | 4,5 | 8,68 |
| `--ok` sobre `--bg` / `--card` | 4,5 | 9,06 / 8,36 |
| `--warn` sobre `--bg` / `--card` | 4,5 | 10,01 / 9,24 |
| `--danger` sobre `--bg` / `--card` | 4,5 | 9,02 / 8,33 |
| `--ok` sobre `--flash-bg` | 4,5 | 7,42 |
| `--danger` sobre `--error-bg` | 4,5 | 8,25 |
| `--fg` sobre `--flash-bg` / `--error-bg` | 4,5 | 12,33 / 13,77 |
| `--control-line` sobre `--field` / `--bg` / `--card` | 3 | 4,11 / 3,98 / 3,67 |
| `--accent` (foco) sobre `--bg` | 3 | 8,33 |
| `--flash-line` / `--error-line` sobre `--bg` | 3 | 4,36 / 3,75 |

En la paleta clara solo se comprueba que los valores son **idénticos a los de hoy** (FR-005): el
contraste del modo claro no entra en el alcance y `--control-line` conserva su `#d9dde4`, que no
llega a 3:1 (R7).

## 3. Lo que esta feature no toca

- Ninguna tabla de `src/db`, ninguna migración, ningún `formatVersion`.
- `src/config-transfer`: la preferencia no es configuración del negocio, así que no hay sección
  nueva, ni actualizador, ni cambio en la cobertura de columnas.
- `src/webchat/design`: los cinco colores del chat, sus textos, sus imágenes y su aviso de contraste
  siguen igual, y se calculan sobre los colores del negocio, no sobre el tema del panel (FR-020).
- La sesión del operador, el CSRF, el límite de intentos y las cabeceras de seguridad.
