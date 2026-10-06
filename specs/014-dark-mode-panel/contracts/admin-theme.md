# Contrato: tema del panel (HTTP y HTML)

Interfaz que el panel expone al operador para el tema. Todo lo que aquí se afirma se comprueba en
`tests/contract/admin/theme.test.ts` con `fastify.inject`, salvo lo marcado como validación manual.

## 1. El tema en el HTML de cada página

Toda página del panel, **incluida `/admin/login`**, se sirve con:

```html
<html lang="es" data-theme="dark">   <!-- cookie kb_theme=dark -->
<html lang="es" data-theme="light">  <!-- cookie kb_theme=light -->
<html lang="es">                     <!-- sin cookie, o cookie con valor desconocido: automático -->
```

- El atributo lo escribe el servidor: no hay script que lo ponga (la CSP del panel no permite
  `inline`), así que la primera pintura ya llega con el tema (FR-003).
- El valor se escapa como cualquier otro dato de plantilla; solo puede ser `light` o `dark`.
- Las páginas del panel conservan `Cache-Control: no-store`, así que no hace falta `Vary: Cookie`.
- **Excepción**: la vista previa de «Diseño del chat» (`/admin/chat-design/preview…`) es un documento
  propio que no carga `app.css` y **no** recibe `data-theme` del panel; su atributo lo sigue poniendo
  el tema del chat del negocio (FR-019, FR-020).

## 2. El control

Parcial `partials/theme-switch.eta`, presente en la barra superior del panel y en la pantalla de
acceso:

```html
<form class="theme-switch" method="post" action="/admin/theme"
      hx-post="/admin/theme" hx-swap="none">
  <input type="hidden" name="_csrf" value="…">
  <input type="hidden" name="next" value="/admin/hours">
  <fieldset>
    <legend>Tema</legend>
    <label><input type="radio" name="theme" value="auto"  checked> Automático</label>
    <label><input type="radio" name="theme" value="light">       Claro</label>
    <label><input type="radio" name="theme" value="dark">        Oscuro</label>
  </fieldset>
  <button type="submit" class="small">Aplicar</button>
</form>
```

- `checked` marca la opción activa, derivada de la cookie (FR-006).
- `next` es la ruta actual (`it.layout.path`), para volver a ella sin JavaScript.
- El botón «Aplicar» solo hace falta sin JavaScript; con JavaScript el cambio se aplica al cambiar
  la opción y el botón queda como respaldo visible.
- La agrupación usa `fieldset`/`legend` para que un lector de pantalla anuncie «Tema».

## 3. `POST /admin/theme`

Registrada en el ámbito `/admin`, **fuera** del ámbito del operador, con `csrfOnPost` aplicado: el
control funciona también en la pantalla de acceso.

**Cuerpo** (`application/x-www-form-urlencoded`):

| Campo | Obligatorio | Valores |
|---|---|---|
| `theme` | sí | `auto`, `light` o `dark` |
| `next` | no | ruta del panel a la que volver |
| `_csrf` | sí | token de la página (o cabecera `x-csrf-token`) |

**Respuestas**:

| Caso | Código | Cuerpo y cabeceras |
|---|---|---|
| `theme=light` o `dark`, petición de htmx | `204` | sin cuerpo; `Set-Cookie: kb_theme=…` |
| `theme=auto`, petición de htmx | `204` | sin cuerpo; `Set-Cookie: kb_theme=; Max-Age=0` |
| igual, petición normal (sin `HX-Request`) | `303` | `Location: <next validado>`; misma cookie |
| `theme` ausente o con otro valor | `422` | sin cookie |
| sin token CSRF o con token inválido | `403` | sin cookie (lo devuelve `@fastify/csrf-protection`) |
| método distinto de POST | `404` | — |

**`Set-Cookie`** (R4): `kb_theme=<valor>; Path=/admin; Max-Age=31536000; HttpOnly; SameSite=Lax`, más
`Secure` cuando `NODE_ENV === 'production'`. Para `auto`: mismo nombre y atributos con `Max-Age=0` y
valor vacío.

**Validación de `next`** (evita una redirección abierta): se acepta solo si empieza por `/admin`, no
contiene `//` ni `:` y no empieza por `/admin//`. Cualquier otro valor, y la ausencia de `next`,
redirigen a `/admin`.

**Lo que esta ruta NO hace**: no consulta la base de datos, no lee ni escribe configuración del
negocio, no crea ni toca la sesión del operador, no registra actividad y no depende de que haya
sesión iniciada (FR-013).

## 4. Comportamiento en el navegador

| Situación | Resultado |
|---|---|
| Con JavaScript, el operador cambia la opción | `app.js` pone o quita `data-theme` en `<html>` al momento y htmx envía el POST en segundo plano; no se recarga y no se pierde nada escrito (FR-007) |
| Sin JavaScript | el formulario se envía como POST normal y el `303` devuelve a la misma pantalla con el tema puesto (FR-012) |
| Opción **Automático** y el sistema cambia de preferencia | el atributo no existe, así que la media query aplica el cambio sola, en caliente (FR-004) |
| Dos pestañas abiertas | la que no cambió conserva su tema hasta recargar o recibir contenido nuevo; ninguna queda a medias |

## 5. Validación manual (quickstart)

No se comprueban con `inject`, porque dependen de un navegador real o de la percepción:

- que no haya destello del tema contrario al cargar;
- que ninguna de las 15 secciones muestre una zona del tema contrario;
- que los avisos críticos sigan destacando;
- que la vista previa del chat se vea idéntica en los dos temas;
- que al imprimir salga sobre fondo claro.
