# Validación: Modo oscuro del panel del operador

Cómo comprobar que la feature funciona de punta a punta. La parte automática corre en la suite; la
manual necesita un navegador y un par de ojos, y es la que cierra SC-005, SC-006 y SC-008.

## 0. Requisitos

```bash
pnpm install
docker compose up -d db
pnpm db:migrate
pnpm dev                 # http://localhost:3000/admin
```

Un negocio con datos suficientes para que haya algo que mirar: al menos un servicio, un recurso, una
pregunta frecuente, un horario, una derivación y **un aviso crítico sin resolver** (por ejemplo, un
servicio sin precio), más un diseño de chat guardado con colores claros.

## 1. Automático

```bash
pnpm lint && pnpm typecheck
pnpm test:unit                                  # incluye theme.test.ts y theme-css.test.ts
pnpm test tests/contract/admin/theme.test.ts
pnpm test tests/contract/admin/chat-design.test.ts
pnpm test                                       # la suite completa, sin regresiones
```

Lo que cubren: la cookie y su cabecera, el atributo `data-theme` en panel y acceso, la ruta con sus
códigos y su CSRF, los 16 tokens en los cuatro bloques del CSS, la ausencia de literales y los
contrastes de la paleta oscura. No cubren nada de lo que se ve.

## 2. Tema automático (US1)

1. Pon el sistema en **oscuro** y abre `http://localhost:3000/admin` en una ventana nueva.
   - El panel aparece oscuro **desde el primer instante**: no hay un destello claro. Si lo hay,
     FR-003 está incumplido (y significa que el tema se está aplicando desde el navegador, no desde
     el servidor).
2. Cierra sesión y mira la pantalla de acceso: también oscura (FR-002).
3. Vuelve a entrar, abre **Datos del negocio** y escribe algo en un campo sin guardar. Cambia la
   preferencia del sistema a claro **sin tocar el navegador**.
   - El panel pasa a claro y lo que escribiste **sigue ahí** (FR-004).
4. Pon el sistema en claro y recarga: el panel se ve exactamente como antes de la feature. Compáralo
   con una captura previa si la tienes (FR-005).

## 3. Elegir el tema (US2)

1. Con el sistema en claro, elige **Oscuro** en el control de la barra superior.
   - Cambia al momento, sin recargar (mira que el campo a medio escribir siga intacto).
2. Recarga, navega a otra sección, cierra sesión: sigue oscuro, también en la pantalla de acceso
   (FR-009, US2-4).
3. Reinicia la instancia (`Ctrl+C` y `pnpm dev`) y vuelve: sigue oscuro.
4. Elige **Automático**: vuelve a seguir al sistema (FR-008).
5. Abre el panel en otro navegador o en una ventana privada: empieza en **Automático** (US2-7).
6. **Sin JavaScript**: desactívalo en el navegador, elige **Oscuro** y pulsa «Aplicar».
   - La página se recarga en oscuro y en la misma sección (FR-012).
7. Con las herramientas de desarrollo, cambia el valor de la cookie `kb_theme` a `morado` y recarga.
   - El panel se comporta como automático, sin error ni página en blanco (FR-011).

## 4. Recorrido completo en oscuro (US3, SC-005)

Con el tema en **Oscuro**, recorre las quince secciones y comprueba en cada una que no hay zonas del
tema contrario ni texto que cueste leer:

| Sección | Mirar en concreto |
|---|---|
| Portada | avisos críticos frente a no críticos: se distinguen y **destacan** (FR-017) |
| Datos | campos, textos de ayuda, enlace a mapa |
| Horario y cierres | líneas de puntos de los días, campos de hora (el selector del navegador también oscuro) |
| Servicios / Recursos | tablas, filas inactivas, botones secundarios y de borrar |
| Preguntas frecuentes | áreas de texto |
| Políticas / Tono | formularios largos |
| Derivación | recuadro «Contacto que usa el bot», y su variante sin contacto en rojo |
| Derivaciones | tabla y estados |
| Probar el bot | burbujas del bot y del operador, «escribiendo…», tabla de información técnica |
| Chat web | fragmento para copiar, `code` en línea, botón «Copiar» |
| **Diseño del chat** | **la vista previa mantiene los colores claros del negocio** y el cuadriculado de detrás sigue claro; las miniaturas del logotipo y del avatar siguen sobre fondo claro (FR-019) |
| Consumo | tablas con desplazamiento, columnas de números, banda del tope de gasto |
| Exportar e importar | diferencias en verde, rojo y gris; vista previa de la importación |
| Pie de versión | legible, y la etiqueta «Esquema distinto del esperado» si aparece |
| 404 | entra en `/admin/nada` |

Además:

1. Guarda un formulario: la banda verde de «Guardado» es legible y se distingue del fondo.
2. Envía un formulario con un campo mal rellenado: la banda de error y el mensaje del campo son
   legibles, y el mensaje **sigue estando en texto**, no solo en color (FR-016).
3. Recorre una pantalla entera con el tabulador: el elemento enfocado se ve siempre (FR-015).
4. Activa el aviso de contraste en **Diseño del chat** eligiendo dos colores parecidos: el aviso
   sale igual en claro y en oscuro, con el mismo texto y la misma razón (FR-020).
5. Imprime una sección (`Ctrl+P`) con el tema oscuro: la vista previa de impresión sale sobre fondo
   claro y legible (FR-021).
6. Repite el recorrido en **Claro** una vez: nada debe haber cambiado respecto a antes de la feature.

## 5. En producción (SC-008)

Después de desplegar la versión con la feature, por el procedimiento por tandas de la feature 009:

```bash
pnpm instance:versions            # confirma la versión nueva en la instancia
```

1. Entra en el panel real, elige el tema que prefieras y trabaja una jornada normal.
2. Comprueba que no te hace falta volver al otro tema para leer o verificar ninguna sección; si en
   algún punto sí, anota la sección: es un defecto de la feature, no una preferencia.
3. Comprueba que la preferencia sigue puesta al día siguiente y después de la actualización
   siguiente.
4. Comprueba que el chat web que ven los clientes finales **no ha cambiado nada**: abre el chat de la
   web del negocio y compáralo con cómo estaba (FR-023).

## 6. Señales de que algo está mal

| Síntoma | Causa probable |
|---|---|
| Destello claro al cargar en oscuro | el atributo `data-theme` no se está renderizando en el servidor, o la cookie no llega (revisa `Path=/admin`) |
| El tema no cambia hasta recargar | falta el código de `app.js` que pone el atributo; htmx solo sustituye `<body>` (R6) |
| Una zona se queda clara en oscuro | un token olvidado en el bloque de mapeo oscuro, o un color literal que no se tokenizó (lo detecta `theme-css.test.ts`) |
| Barras de desplazamiento o selectores de fecha claros | falta `color-scheme` en el bloque de mapeo (R7) |
| La vista previa del chat se ve oscura | alguien aplicó el tema del panel a `preview.eta` o a `frame.css`: no debe (FR-019) |
| La preferencia se pierde al cerrar sesión | se está guardando en la sesión en lugar de en la cookie (R3) |
