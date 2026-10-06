/**
 * Coste y duración de una transcripción (012, research R6). Enteros exactos, como el resto del
 * consumo (010, R4): el precio va en millonésimas de la moneda por minuto de audio y el coste en
 * billonésimas. 1 millonésima por minuto = 10⁶ billonésimas / 60 000 ms = 50/3 por ms.
 */

/** Coste de `audioMs` milisegundos, redondeado hacia arriba; `null` sin precio (010, R5). */
export function transcriptionCostPico(audioMs: number, microsPerMinute: bigint | null): bigint | null {
  if (microsPerMinute === null) return null;
  const numerator = BigInt(Math.max(0, Math.ceil(audioMs))) * microsPerMinute * 50n;
  return (numerator + 2n) / 3n;
}

/** Muestras por segundo de la `granule_position` de Opus (siempre 48 kHz, RFC 7845). */
const OPUS_RATE = 48_000n;
const PAGE_HEADER = 27;

/**
 * Duración de una nota de voz Ogg/Opus (como las de WhatsApp) por la `granule_position` de su
 * última página. `null` si no es un Ogg con flujo Opus, si está cortado o si la última página no
 * tiene posición: quien llama usa entonces otra fuente, sin infraestimar.
 */
export function oggOpusDurationMs(bytes: Buffer): number | null {
  let offset = 0;
  let first = true;
  let last: bigint | null = null;
  while (offset < bytes.length) {
    if (offset + PAGE_HEADER > bytes.length) return null;
    if (bytes.toString('latin1', offset, offset + 4) !== 'OggS') return null;
    const segments = bytes.readUInt8(offset + 26);
    const lacingEnd = offset + PAGE_HEADER + segments;
    if (lacingEnd > bytes.length) return null;
    let size = 0;
    for (let i = offset + PAGE_HEADER; i < lacingEnd; i++) size += bytes.readUInt8(i);
    const end = lacingEnd + size;
    if (end > bytes.length) return null;
    if (first) {
      if (bytes.toString('latin1', lacingEnd, lacingEnd + 8) !== 'OpusHead') return null;
      first = false;
    }
    last = bytes.readBigInt64LE(offset + 6);
    offset = end;
  }
  if (last === null || last <= 0n) return null;
  return Number((last * 1000n + OPUS_RATE - 1n) / OPUS_RATE);
}

/**
 * Duración que se registra: la del proveedor; si no la da, la del Ogg/Opus; si tampoco se puede,
 * el máximo permitido (se sobreestima, nunca se infraestima).
 */
export function resolveAudioMs(
  providerSeconds: number | null | undefined,
  bytes: Buffer | null,
  audioMaxSeconds: number,
): number {
  if (typeof providerSeconds === 'number' && Number.isFinite(providerSeconds) && providerSeconds >= 0) {
    return Math.ceil(providerSeconds * 1000);
  }
  const fromOgg = bytes ? oggOpusDurationMs(bytes) : null;
  return fromOgg ?? audioMaxSeconds * 1000;
}
