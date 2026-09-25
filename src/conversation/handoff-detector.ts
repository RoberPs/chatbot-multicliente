/**
 * Detector determinista de petición de persona (contracts/bot-replies.md, Principio V).
 *
 * Garantiza el bloque CONTACTO aunque el modelo no marque `handoffRequested`. La lista es de
 * uso general, sin términos de sector, y se aplica sobre el texto en minúsculas y sin tildes.
 */

/** Minúsculas, sin tildes y con los espacios simplificados. */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

const SOMEONE = String.raw`(?:una persona|alguien|un humano|una humana|un ser humano|una persona real|el encargado|la encargada|el responsable|la responsable|un empleado|una empleada|un agente|un operador|una operadora)`;
const MACHINE = String.raw`(?:un bot|un robot|una maquina|un contestador|un asistente automatico)`;

const PATTERNS: RegExp[] = [
  new RegExp(String.raw`\bhablar con ${SOMEONE}\b`),
  new RegExp(String.raw`\bno quiero hablar con ${MACHINE}\b`),
  /\bpersona real\b/,
  /\bser humano\b/,
  /\batencion (?:al cliente|personal|personalizada)\b/,
  /\bque me llamen?\b/,
  /\bme (?:podeis|puedes|puede|pueden) llamar\b/,
  /\bllamadme\b/,
  /\b(?:pasame|pasadme|pongame|ponme|ponedme|paseme) con\b/,
];

/** `true` si el texto pide hablar con una persona. */
export function detectsHandoffRequest(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return PATTERNS.some((re) => re.test(normalized));
}
