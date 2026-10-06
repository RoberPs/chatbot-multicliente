# Contrato: regla única de enlaces

**Feature**: 012 · US7 · FR-031 · research R12. Sustituye la regla duplicada de
[004 R15](../../004-web-channel/research.md) (`message-links.ts`, `links.js`) y la categoría `url`
de `grounding.ts` (002).

## Módulo `src/conversation/link-rule.ts`

```ts
interface LinkMatch { start: number; end: number; url: string }

/** Lo que el chat web y «Probar el bot» muestran como enlace. */
displayLinks(text: string): LinkMatch[]

/** Lo que el verificador trata como dirección web (superconjunto de displayLinks). */
linkCandidates(text: string): LinkMatch[]

/** Fuente de la expresión de displayLinks, para inyectarla en links.js. */
DISPLAY_LINK_RULE: { candidate: string; flags: string; trailing: string }
```

**`displayLinks`**: `https://` seguido de caracteres que no sean espacio, `<`, `>`, `"`, `'` ni `)`
(sin exigir borde de palabra delante); se quitan los signos finales `.,;:!?]}»`; vale si `URL` la
analiza con protocolo `https:`, host con punto y sin usuario ni contraseña.

**`linkCandidates`**: todo lo de `displayLinks` (mismos `start`, `end` y `url`) más `http://…`,
`www.…` y dominios sueltos `etiqueta(.etiqueta)*.tld[/ruta]` cuyo `tld` está en la lista IANA de
`src/conversation/tlds.ts`.

## Uso

| Sitio | Regla |
|---|---|
| `grounding.ts` (categoría `url`) | `linkCandidates`; vale si la URL normalizada, o host + ruta, es de una dirección registrada |
| `src/admin/message-links.ts` («Probar el bot», panel) | `displayLinks` |
| `src/channels/web/assets/links.js` (chat web) | expresión de `DISPLAY_LINK_RULE` inyectada al servir el fichero (marcador `/*__LINK_RULE__*/`) |
| `customerQuote` (avisos al negocio, R8) | `linkCandidates` |

## Batería (`tests/unit/conversation/link-rule.test.ts`)

Casos con y sin protocolo, `xhttps://…`, signos pegados (`(https://a.es)`, `https://a.es.`),
mayúsculas, credenciales, puertos, IDN y caracteres de ancho completo. Para todos:
`displayLinks(t) ⊆ linkCandidates(t)`, y `links.js` (ejecutado con la expresión inyectada) da lo
mismo que `displayLinks`.
