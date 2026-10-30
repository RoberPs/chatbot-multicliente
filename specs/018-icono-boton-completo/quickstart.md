# Quickstart: validar la 018

## Pruebas automáticas (solo lo tocado)

```powershell
pnpm test prompt.test
pnpm test web-chat-design
pnpm lint; pnpm typecheck
```

Evaluación con el modelo real (coste; **pedir permiso antes**):

```powershell
pnpm test:eval sc-unsaved-contact
```

Esperado: 100 % de respuestas sin «anotado/guardado» ni promesas de contacto (SC-003).

## Icono (US1), en local

1. `pnpm dev`, panel → **Diseño del chat**, sube un logo como icono del botón.
2. Vista previa: el logo rellena el botón con un borde fino del color principal. Cambia la forma
   (recta, suave, redondeada) y el color principal: imagen y borde los siguen.
3. Quita el icono: el botón vuelve al emoji sobre el color principal, sin borde.
4. Con el teclado (Tab) el foco se ve alrededor del botón.
5. Abre el chat en una página que lo incruste: el botón cerrado mide lo mismo que antes.

## Datos no guardados (US2), en local

Con `pnpm bot:chat` o el chat web local:

1. «Me llamo Ana García y mi teléfono es 612 345 678» → no dice que los ha anotado ni promete una
   llamada; remite al negocio (contacto u oferta de derivación).
2. «Quiero hablar con una persona» → el sistema pide los datos → «He avisado a…» (sin cambios).

## Producción (tras desplegar la 0.1.4)

1. `pnpm instance:versions` → las tres instancias en 0.1.4.
2. Demo de sisu (Ctrl+F5): el logo rellena el botón con borde marrón.
3. Viajes y restaurante: el botón no ha cambiado (no tienen icono propio).
4. En sisu, conversación nueva con nombre y teléfono sin pedir: sin «anotado». Derivación de
   prueba completa y **Terminado**.
