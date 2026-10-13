/**
 * La costura del proveedor del modelo (017, contracts/llm-provider.md). Punto **único** donde se
 * decide quién atiende: el tipo cerrado, la tabla de descriptores, el clasificador de formas de
 * credencial y las dos fábricas. Nadie fuera de `src/llm/` nombra una variable de credencial de un
 * proveedor concreto ni importa el SDK de ninguno (FR-006, FR-023, SC-008).
 *
 * Este módulo **no importa ningún SDK**: lo necesitan el arranque, la comprobación previa y las
 * reglas de secretos, y una herramienta de aprovisionamiento no tiene por qué cargar tres clientes
 * de modelo para leer una tabla. Las dos fábricas, que sí construyen adaptadores, viven en
 * `./factory.js`, dentro de la misma frontera de `src/llm/`.
 */
export type LlmProvider = 'anthropic' | 'gemini' | 'openai';

/** Los tres elegibles, en orden estable: es el orden en que los nombran los mensajes. */
export const LLM_PROVIDERS: readonly LlmProvider[] = ['anthropic', 'gemini', 'openai'] as const;

export interface ProviderDescriptor {
  provider: LlmProvider;
  /** Variable de entorno que lleva la credencial de este proveedor. */
  keyVariable: string;
  /**
   * Patrones de forma de credencial, en el orden en que se evalúan. El orden importa entre
   * proveedores, no dentro de uno: ver `classifyKeyShape`.
   */
  keyPatterns: readonly RegExp[];
  /**
   * `LLM_MODEL` es obligatoria salvo en Anthropic, que conserva su valor por defecto para no
   * romper los entornos ya desplegados (FR-003, R2). Un valor por defecto para Gemini u OpenAI
   * envejecería dentro del código, y un nombre de modelo equivocado se parece mucho a un fallo del
   * proveedor: mejor que lo declare el entorno.
   */
  modelRequired: boolean;
  /** Modelo por defecto, solo donde `modelRequired` es `false`. */
  defaultModel?: string;
  /**
   * Longitud mínima de la credencial para la regla de calidad de secretos (FR-011). Es **por
   * proveedor a propósito**: las claves clásicas de Gemini tienen 39 caracteres, así que un mínimo
   * común de 40 declararía no apta una credencial perfectamente válida y bloquearía un despliegue
   * legítimo, que es el error que R3 pide no cometer.
   */
  keyMinLength: number;
}

/**
 * Tabla única de R1. Actualizar un prefijo que el proveedor haya cambiado es una línea aquí.
 *
 * Los patrones son **conservadores a propósito** (R3): cubren los prefijos conocidos el día que se
 * escriben y nada más. Una forma que no encaje con ninguno no da veredicto, porque los proveedores
 * cambian de formato —Gemini está pasando de `AIza` a `AQ.`— y un clasificador que se equivoca
 * hacia el rechazo bloquea despliegues legítimos.
 */
const DESCRIPTORS: Readonly<Record<LlmProvider, ProviderDescriptor>> = {
  anthropic: {
    provider: 'anthropic',
    keyVariable: 'ANTHROPIC_API_KEY',
    // El segmento `api03` es la versión de la API, no parte estable del prefijo (R3).
    keyPatterns: [/^sk-ant-/],
    modelRequired: false,
    defaultModel: 'claude-sonnet-5-5',
    // El valor que ya tenía la regla antes de la 017: no cambia para los entornos desplegados.
    keyMinLength: 40,
  },
  gemini: {
    provider: 'gemini',
    keyVariable: 'GEMINI_API_KEY',
    // `AIza` en las clásicas; `AQ.` en las nuevas de AI Studio (R3, trampa 2).
    keyPatterns: [/^AIza/, /^AQ\./],
    modelRequired: true,
    keyMinLength: 32,
  },
  openai: {
    provider: 'openai',
    keyVariable: 'OPENAI_API_KEY',
    // `sk-proj-` en las nuevas; `sk-` a secas en las antiguas, que siguen siendo válidas.
    keyPatterns: [/^sk-proj-/, /^sk-/],
    modelRequired: true,
    keyMinLength: 40,
  },
};

export function providerDescriptor(provider: LlmProvider): ProviderDescriptor {
  // La búsqueda se hace con el tipo abierto a propósito: si llega un valor que no es de la tabla
  // —de un entorno, de un inventario—, el mensaje nombra los tres en lugar de dar `undefined`.
  const descriptor: ProviderDescriptor | undefined = (
    DESCRIPTORS as Partial<Record<string, ProviderDescriptor>>
  )[provider];
  if (!descriptor) throw new Error(ineligibleMessage(provider));
  return descriptor;
}

/** Nombre de la variable de credencial del proveedor. */
export function keyVariableOf(provider: LlmProvider): string {
  return providerDescriptor(provider).keyVariable;
}

/** Las tres variables de credencial, en el orden estable de `LLM_PROVIDERS`. */
export const LLM_KEY_VARIABLES: readonly string[] = LLM_PROVIDERS.map(keyVariableOf);

/**
 * Longitud mínima de cada variable de credencial, para las reglas de calidad de secretos. Que
 * salga de aquí es lo que permite que `src/config/secret-rules.ts` aplique la regla a la variable
 * del proveedor declarado sin nombrar ninguna (FR-011, regla C1).
 */
export const LLM_KEY_MINIMUMS: Readonly<Record<string, number>> = Object.fromEntries(
  LLM_PROVIDERS.map((p) => [keyVariableOf(p), providerDescriptor(p).keyMinLength]),
);

/**
 * Proveedor **dueño** de una variable de credencial, o `null` si la variable no es de ninguno.
 *
 * Es lo que permite comprobar «este valor no va en esta variable» sin saber cuál es el proveedor
 * declarado: una clave de Anthropic en `GEMINI_API_KEY` está mal puesta diga lo que diga
 * `LLM_PROVIDER` (FR-028).
 */
export function providerOfKeyVariable(variable: string): LlmProvider | null {
  return LLM_PROVIDERS.find((p) => keyVariableOf(p) === variable) ?? null;
}

/** Mensaje de un proveedor no elegible: nombra los tres (FR-002, regla C5). */
export function ineligibleMessage(value: unknown): string {
  return `LLM_PROVIDER debe ser ${LLM_PROVIDERS.join(', ')}; recibido: ${String(value)}`;
}

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === 'string' && (LLM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Clasificador conservador de la forma de una credencial (R3, regla C4).
 *
 * **El orden de evaluación es la regla, no un detalle**: `sk-ant-` es un subconjunto de `sk-`, así
 * que Anthropic se comprueba antes que OpenAI. Al revés, toda clave de Anthropic se clasificaría
 * como de OpenAI y la comprobación previa acusaría al entorno correcto de estar equivocado.
 *
 * Devuelve `null` ante cualquier forma que no reconozca: nunca un proveedor «probable».
 */
export function classifyKeyShape(value: string): LlmProvider | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  for (const provider of LLM_PROVIDERS) {
    for (const pattern of providerDescriptor(provider).keyPatterns) {
      if (pattern.test(trimmed)) return provider;
    }
  }
  return null;
}
