/**
 * Tabla de capacidades por proveedor (017, FR-021; data-model.md §1).
 *
 * Esto no es documentación con forma de código: es la **declaración** de lo que cada proveedor
 * conserva, traduce o no tiene, y es lo que `tests/unit/llm/capabilities.test.ts` compara contra
 * el comportamiento real de los tres adaptadores **y** contra la tabla de
 * `docs/operacion-multicliente.md`. Las tres cosas —código, prueba y documento— no pueden
 * separarse sin que algo falle, que es justo lo que FR-021 pide.
 *
 * Vive en `src/llm/` porque nombra proveedores, y fuera de aquí nadie los nombra (regla C1).
 */
import { LLM_PROVIDERS, type LlmProvider } from './provider.js';

/** Cómo obliga el proveedor a que la salida tenga la forma del esquema. */
export type SchemaEnforcement =
  /** Admite el esquema tal cual, con propiedades opcionales. */
  | 'tolerant'
  /** Modo estricto: no admite opcionales, de ahí el dialecto propio (R7). */
  | 'strict';

/** Si el mando de esfuerzo está siempre, o depende del modelo configurado. */
export type EffortSupport = 'always' | 'per_model';

/** Qué hace el proveedor con su razonamiento interno. */
export type ReasoningSupport =
  | 'always'
  /** Existe y en algunos modelos **no se puede apagar del todo** (R8). */
  | 'always_on'
  | 'per_model';

/** De dónde sale el rechazo de cada proveedor (R10). */
export type RefusalSignal =
  /** Anthropic: `stop_reason: 'refusal'`. */
  | 'stop_reason'
  /** Gemini: bloqueo de seguridad, del prompt o del candidato. */
  | 'safety_block'
  /** OpenAI: elemento de contenido de tipo rechazo, con el estado en `completed`. */
  | 'content_item';

export interface ProviderCapabilities {
  schema: SchemaEnforcement;
  effort: EffortSupport;
  reasoning: ReasoningSupport;
  /** ¿Hay que marcar la caché explícitamente en la petición? (FR-019, R9). */
  explicitCacheMark: boolean;
  reportsCacheRead: boolean;
  /**
   * **Corregido durante la implementación (R11)**: `openai` 7.32.0 declara
   * `input_tokens_details.cache_write_tokens` y no es opcional, así que OpenAI **sí** informa.
   * El `null` del panel queda solo para Gemini, confirmado contra `@google/genai` 2.29.0.
   */
  reportsCacheWrite: boolean;
  refusal: RefusalSignal;
}

export const PROVIDER_CAPABILITIES: Readonly<Record<LlmProvider, ProviderCapabilities>> = {
  anthropic: {
    schema: 'tolerant',
    effort: 'always',
    reasoning: 'always',
    explicitCacheMark: true,
    reportsCacheRead: true,
    reportsCacheWrite: true,
    refusal: 'stop_reason',
  },
  gemini: {
    schema: 'tolerant',
    effort: 'always',
    reasoning: 'always_on',
    explicitCacheMark: false,
    reportsCacheRead: true,
    reportsCacheWrite: false,
    refusal: 'safety_block',
  },
  openai: {
    schema: 'strict',
    effort: 'per_model',
    reasoning: 'per_model',
    explicitCacheMark: false,
    reportsCacheRead: true,
    reportsCacheWrite: true,
    refusal: 'content_item',
  },
};

// ---------------------------------------------------------------------------
// La misma tabla, en el texto que publica la documentación
// ---------------------------------------------------------------------------

/**
 * Una fila de la tabla de capacidades: su etiqueta y la celda de cada proveedor.
 *
 * El texto de la celda **se deriva** de los valores de arriba, nunca se escribe aparte: así la
 * documentación no puede decir una cosa y el código otra. La prueba compara este texto, carácter a
 * carácter, con la tabla de `docs/operacion-multicliente.md`.
 */
export interface CapabilityRow {
  label: string;
  cells: Readonly<Record<LlmProvider, string>>;
}

const yesNo = (value: boolean): string => (value ? 'sí' : 'no');

const SCHEMA_TEXT: Record<SchemaEnforcement, string> = {
  tolerant: 'sí (tolerante)',
  strict: 'sí (modo estricto)',
};

const EFFORT_TEXT: Record<EffortSupport, string> = {
  always: 'sí',
  per_model: 'según modelo',
};

const REASONING_TEXT: Record<ReasoningSupport, string> = {
  always: 'sí',
  always_on: 'sí (no siempre apagable)',
  per_model: 'según modelo',
};

const REFUSAL_TEXT: Record<RefusalSignal, string> = {
  stop_reason: 'sí (motivo de parada)',
  safety_block: 'sí (bloqueo de seguridad)',
  content_item: 'sí (elemento de contenido)',
};

const row = (label: string, cell: (c: ProviderCapabilities) => string): CapabilityRow => ({
  label,
  cells: Object.fromEntries(
    LLM_PROVIDERS.map((p) => [p, cell(PROVIDER_CAPABILITIES[p])]),
  ) as Record<LlmProvider, string>,
});

/** Las siete filas de data-model.md §1, en su orden. */
export const CAPABILITY_TABLE: readonly CapabilityRow[] = [
  row('Esquema de salida obligado', (c) => SCHEMA_TEXT[c.schema]),
  row('Mando de esfuerzo', (c) => EFFORT_TEXT[c.effort]),
  row('Razonamiento interno', (c) => REASONING_TEXT[c.reasoning]),
  row('Marca explícita de caché', (c) => yesNo(c.explicitCacheMark)),
  row('Tokens de lectura de caché', (c) => yesNo(c.reportsCacheRead)),
  row('Tokens de escritura de caché', (c) => yesNo(c.reportsCacheWrite)),
  row('Señal propia de rechazo', (c) => REFUSAL_TEXT[c.refusal]),
];

/** La tabla en Markdown, con el formato exacto que publica la documentación. */
export function capabilityTableMarkdown(): string {
  const header = `| Capacidad | ${LLM_PROVIDERS.map((p) => `\`${p}\``).join(' | ')} |`;
  const divider = `|---|${LLM_PROVIDERS.map(() => '---|').join('')}`;
  const rows = CAPABILITY_TABLE.map(
    (r) => `| ${r.label} | ${LLM_PROVIDERS.map((p) => r.cells[p]).join(' | ')} |`,
  );
  return [header, divider, ...rows].join('\n');
}
