/**
 * Aritmética del consumo en enteros exactos (010, research R4). Sin coma flotante en ningún paso:
 * tokens × millonésimas por millón de tokens = billonésimas (10⁻¹²) de la moneda.
 */
import type { ModelPrice, SpendCapLevel, TokenUsage } from './types.js';

/** Billonésimas por céntimo (10⁻² / 10⁻¹²). */
const PICO_PER_CENT = 10_000_000_000n;
const MAX_PRICE_MICROS = 1_000_000_000_000n; // 1 000 000 por MTok
const MAX_CAP_CENTS = 1_000_000_000; // 10 000 000 de la moneda

/**
 * Coste exacto de unos tokens con un precio, en billonésimas.
 *
 * 017: un concepto **no informado** vale cero a efectos de coste —no hay tokens que valorar—, y
 * eso no lo convierte en un cero medido: el `null` se conserva en la columna del token, que es lo
 * que el panel lee para decir «sin dato» (FR-024).
 */
export function costPico(tokens: TokenUsage, price: ModelPrice): bigint {
  return (
    BigInt(tokens.input) * price.inputMicros +
    BigInt(tokens.output) * price.outputMicros +
    BigInt(tokens.cacheWrite ?? 0) * price.cacheWriteMicros +
    BigInt(tokens.cacheRead ?? 0) * price.cacheReadMicros
  );
}

/**
 * Decimal no negativo con coma o punto y como mucho `scale` decimales, en unidades de 10⁻scale.
 * Nulo si no es válido.
 */
function parseScaled(text: string, scale: number): bigint | null {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > scale) return null;
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
}

/** Precio por millón de tokens (hasta 6 decimales, ≤ 1 000 000) → millonésimas. */
export function parseMicrosPerMtok(text: string): bigint | null {
  const micros = parseScaled(text, 6);
  return micros === null || micros > MAX_PRICE_MICROS ? null : micros;
}

/** Tope mensual (> 0, hasta 2 decimales, ≤ 10 000 000) → céntimos. */
export function parseCapCents(text: string): number | null {
  const cents = parseScaled(text, 2);
  if (cents === null || cents <= 0n || cents > BigInt(MAX_CAP_CENTS)) return null;
  return Number(cents);
}

/** Parte entera con separador de miles español. */
const groupInteger = (n: bigint): string => new Intl.NumberFormat('es-ES').format(n);

/** Entero en unidades de 10⁻scale → texto con coma decimal y `scale` decimales. */
function formatScaled(value: bigint, scale: number): string {
  const unit = 10n ** BigInt(scale);
  const whole = value / unit;
  if (scale === 0) return groupInteger(whole);
  const fraction = (value % unit).toString().padStart(scale, '0');
  return `${groupInteger(whole)},${fraction}`;
}

/**
 * Coste en billonésimas con `decimals` decimales, redondeo a la mitad hacia arriba. Un coste
 * positivo que redondea a cero se muestra «< 0,0001» (FR-010).
 */
export function formatPico(pico: bigint, decimals = 4): string {
  const divisor = 10n ** BigInt(12 - decimals);
  const rounded = (pico + divisor / 2n) / divisor;
  if (rounded === 0n && pico > 0n) return `< ${formatScaled(1n, decimals)}`;
  return formatScaled(rounded, decimals);
}

/** Precio en millonésimas → decimal sin ceros sobrantes, tal como se escribe en el panel. */
export function formatMicros(micros: bigint): string {
  const whole = (micros / 1_000_000n).toString();
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole},${fraction}` : whole;
}

/** Céntimos → importe con dos decimales. */
export function formatCents(cents: number): string {
  return formatScaled(BigInt(cents), 2);
}

/** Nivel del tope (data-model §3), en este orden: none, reached, warning, normal. */
export function capLevel(
  spentPico: bigint,
  capCents: number | null,
  enabled: boolean,
): SpendCapLevel {
  if (!enabled || capCents === null) return 'none';
  const capPico = BigInt(capCents) * PICO_PER_CENT;
  if (spentPico >= capPico) return 'reached';
  if (spentPico * 100n >= capPico * 80n) return 'warning';
  return 'normal';
}

/** Porcentaje del tope consumido, redondeado hacia abajo; puede pasar de 100. */
export function capPercent(spentPico: bigint, capCents: number): number {
  return Number((spentPico * 100n) / (BigInt(capCents) * PICO_PER_CENT));
}
