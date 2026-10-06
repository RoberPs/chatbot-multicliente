# Contrato: vista del bot y uso del enlace a mapa

**Feature**: `003-admin-panel-clarity` | Amplía [001 knowledge-reader.md](../../001-business-knowledge-base/contracts/knowledge-reader.md) y [002 chat-model.md](../../002-whatsapp-faq-bot/contracts/chat-model.md)

## `KnowledgeSnapshot.business`

```ts
business: {
  name: string;
  address: string | null;
  directions: string | null;
  mapUrl: string | null;   // 003, FR-014: enlace https a un mapa; null si no hay
  phone: string | null;
  email: string | null;
  timezone: string;
  currency: string;
}
```

- `getSnapshot()` sigue leyendo de la BD en cada llamada (FR-021 de la 001): un enlace
  guardado o borrado se aplica en la siguiente respuesta (SC-005).
- `pnpm kb:snapshot` y "Probar el bot" lo muestran sin cambios propios.
- `tests/contract/snapshot-shape.test.ts` (objeto estricto) añade `mapUrl`.

## Verificador de cifras (002)

`buildAllowedFacts` extrae los valores de todos los textos del snapshot, así que la URL de
`mapUrl` queda permitida sin código nuevo. Garantía que se prueba: una respuesta que copia el
enlace guardado pasa el verificador; una que da otro enlace sigue rechazándose.

## Prompt del modelo (002)

Cambios en `src/llm/prompt.ts`:

- Regla general: "No escribas datos de contacto (teléfonos, correos, enlaces) salvo la
  dirección del negocio **y su enlace a mapa (DATOS_DEL_NEGOCIO.business.mapUrl)**: el sistema
  añade el bloque de contacto cuando hace falta."
- Regla nueva de ubicación: "Ubicación: si preguntan dónde está el negocio o cómo llegar, da
  `business.address` y `business.directions` si existen y, si hay `business.mapUrl`, copia el
  enlace tal cual, sin acortarlo ni cambiarlo. No escribas ningún otro enlace."
  Lo que falte sigue la regla 2 de la 002 (información no registrada).

La spec de la 002 (US1, escenario 4) y su `contracts/chat-model.md` se actualizan con este
comportamiento.
