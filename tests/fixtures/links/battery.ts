/**
 * Batería de enlaces de la 012 (SC-008 y SC-011; contracts/link-rule.md y handoff-limits.md).
 *
 * Cada caso da lo que deben devolver `displayLinks` (lo que el chat web y «Probar el bot» pintan
 * como enlace), `linkCandidates` (lo que el verificador trata como dirección) y `customerQuote`
 * (el texto del cliente con las direcciones desactivadas en los avisos al negocio).
 */
import type { LinkMatch } from '../../../src/conversation/link-rule.js';

export interface LinkCase {
  name: string;
  text: string;
  display: LinkMatch[];
  /** Ordenados por `start`. */
  candidates: LinkMatch[];
  quote: string;
}

/** Posición de `url` en `text` (la primera a partir de `from`). */
function at(text: string, url: string, from = 0): LinkMatch {
  const start = text.indexOf(url, from);
  if (start < 0) throw new Error(`«${url}» no está en «${text}»`);
  return { start, end: start + url.length, url };
}

/** Caso en que lo que se pinta y lo que se verifica coinciden. */
function same(name: string, text: string, urls: string[], quote: string): LinkCase {
  const matches = urls.map((u) => at(text, u));
  return { name, text, display: matches, candidates: matches, quote };
}

/** Caso sin enlace pintado, con candidatos para el verificador. */
function candidatesOnly(name: string, text: string, urls: string[], quote: string): LinkCase {
  return { name, text, display: [], candidates: urls.map((u) => at(text, u)), quote };
}

/** Caso sin ninguna dirección: el texto no cambia. */
function plain(name: string, text: string): LinkCase {
  return { name, text, display: [], candidates: [], quote: text };
}

const nested = 'mira http://x.es/https://y.es';
const twoLinks = 'Uno https://a.example.com y otro b.example.com/x';

export const LINK_CASES: LinkCase[] = [
  // Con protocolo
  same('https con ruta', 'mira https://ejemplo.com/oferta', ['https://ejemplo.com/oferta'], 'mira ejemplo[.]com/oferta'),
  same('https solo', 'https://a.es', ['https://a.es'], 'a[.]es'),
  candidatesOnly('http no se pinta', 'Ver http://ejemplo.es/a', ['http://ejemplo.es/a'], 'Ver ejemplo[.]es/a'),
  candidatesOnly('esquema en mayúsculas (http)', 'HTTP://EJEMPLO.COM', ['HTTP://EJEMPLO.COM'], 'EJEMPLO[.]COM'),
  same('esquema en mayúsculas (https)', 'Visita HTTPS://Ejemplo.ES/Ruta', ['HTTPS://Ejemplo.ES/Ruta'], 'Visita Ejemplo[.]ES/Ruta'),
  candidatesOnly('ftp', 'ftp://ejemplo.es/fichero', ['ftp://ejemplo.es/fichero'], 'ejemplo[.]es/fichero'),
  // Sin borde de palabra delante: lo que se pinta lo ve también el verificador.
  same('xhttps:// pegado a una palabra', 'xhttps://otra.web', ['https://otra.web'], 'xotra[.]web'),
  // Signos pegados
  same('paréntesis', '(https://a.es)', ['https://a.es'], '(a[.]es)'),
  same('punto final', 'https://a.es.', ['https://a.es'], 'a[.]es.'),
  same('comillas latinas', '«https://a.es»', ['https://a.es'], '«a[.]es»'),
  same('varios signos al final', '¿Es https://a.es/abc?!', ['https://a.es/abc'], '¿Es a[.]es/abc?!'),
  // Credenciales, puertos y hosts raros
  candidatesOnly('usuario y contraseña', 'https://u:p@a.es', ['https://u:p@a.es'], 'u:p[@]a[.]es'),
  candidatesOnly(
    'host de otro dominio tras la arroba',
    'https://a.es@evil.com/x',
    ['https://a.es@evil.com/x'],
    'a[.]es[@]evil[.]com/x',
  ),
  same('puerto', 'https://a.es:8443/x', ['https://a.es:8443/x'], 'a[.]es:8443/x'),
  candidatesOnly('host sin punto', 'https://localhost/abc', ['https://localhost/abc'], 'localhost/abc'),
  plain('esquema sin dominio', 'https://'),
  plain('javascript:', 'javascript:alert(1)'),
  plain('mailto: sin dominio con punto', 'mailto:hola'),
  // IDN y ancho completo
  same('IDN con protocolo', 'https://café.es/menú', ['https://café.es/menú'], 'café[.]es/menú'),
  candidatesOnly('IDN sin protocolo', 'café.es', ['café.es'], 'café[.]es'),
  same(
    'letras de ancho completo',
    'https://ｅｊｅｍｐｌｏ.es',
    ['https://ｅｊｅｍｐｌｏ.es'],
    'ｅｊｅｍｐｌｏ[.]es',
  ),
  same('punto de ancho completo', 'https://ejemplo．com', ['https://ejemplo．com'], 'ejemplo[.]com'),
  // Sin protocolo
  candidatesOnly('www.', 'www.ejemplo.es', ['www.ejemplo.es'], 'www[.]ejemplo[.]es'),
  candidatesOnly(
    'www. con ruta y coma',
    'Más info en www.Ejemplo.es/reservas, gracias',
    ['www.Ejemplo.es/reservas'],
    'Más info en www[.]Ejemplo[.]es/reservas, gracias',
  ),
  candidatesOnly('www. con TLD inventado', 'www.ejemplo.invalido', ['www.ejemplo.invalido'], 'www[.]ejemplo[.]invalido'),
  candidatesOnly('dominio suelto', 'la web es peluqueria.es', ['peluqueria.es'], 'la web es peluqueria[.]es'),
  candidatesOnly('dominio suelto con punto final', 'ejemplo.com.', ['ejemplo.com'], 'ejemplo[.]com.'),
  candidatesOnly('dominio suelto con puerto', 'a.es:8080/x', ['a.es:8080/x'], 'a[.]es:8080/x'),
  candidatesOnly('dominio suelto en mayúsculas', 'WWW.EJEMPLO.ES', ['WWW.EJEMPLO.ES'], 'WWW[.]EJEMPLO[.]ES'),
  plain('dominio suelto con TLD inventado', 'mira ejemplo.invalido'),
  // Falso positivo asumido: «me» es un dominio de primer nivel y WhatsApp lo enlazaría.
  candidatesOnly('frase pegada con TLD real', 'Hola.Me interesa', ['Hola.Me'], 'Hola[.]Me interesa'),
  // Correos (solo los desactiva customerQuote; el verificador los trata como correo)
  { ...plain('correo', 'escribe a ana@ejemplo.com'), quote: 'escribe a ana[@]ejemplo[.]com' },
  { ...plain('correo en mayúsculas', 'Correo: INFO@EJEMPLO.ES'), quote: 'Correo: INFO[@]EJEMPLO[.]ES' },
  {
    name: 'correo y dominio suelto',
    text: 'nombre.apellido@correo.es y web.es',
    display: [],
    candidates: [at('nombre.apellido@correo.es y web.es', 'web.es')],
    quote: 'nombre.apellido[@]correo[.]es y web[.]es',
  },
  // Varios y anidados
  {
    name: 'dos enlaces, uno con protocolo',
    text: twoLinks,
    display: [at(twoLinks, 'https://a.example.com')],
    candidates: [at(twoLinks, 'https://a.example.com'), at(twoLinks, 'b.example.com/x')],
    quote: 'Uno a[.]example[.]com y otro b[.]example[.]com/x',
  },
  {
    name: 'un https dentro de la ruta de un http',
    text: nested,
    display: [at(nested, 'https://y.es')],
    candidates: [at(nested, 'http://x.es/https://y.es'), at(nested, 'https://y.es')],
    quote: 'mira x[.]es/y[.]es',
  },
  // Falsos positivos que no son direcciones
  plain('decimal', '3.5 kg'),
  plain('abreviatura', 'p.ej. esto'),
  plain('versión', 'versión v1.2.3'),
  plain('importe', 'son 1.250,50 €'),
  plain('hora', 'a las 10.30'),
  plain('fecha', 'el 25.12.2026'),
  plain('sin direcciones', 'Abrimos a las 10:00.'),
  plain('texto vacío', ''),
];
