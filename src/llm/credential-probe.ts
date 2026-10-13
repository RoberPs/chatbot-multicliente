/**
 * Verificación de la credencial del proveedor (017, R5, R6;
 * contracts/credential-verification.md).
 *
 * Un solo mecanismo con **dos** consumidores que toman decisiones distintas con el mismo
 * resultado: la comprobación previa al despliegue (opcional, bajo bandera) y la comprobación del
 * arranque (siempre, y nunca fatal).
 *
 * La petición es un `GET` al listado de modelos, que **no genera tokens** (FR-031): cuesta una
 * petición y no consume presupuesto del cliente.
 *
 * **Ningún carácter de la credencial sale de este módulo** (FR-032): ni en el veredicto, ni en una
 * línea de registro, ni en un mensaje de error. La credencial viaja en una cabecera y nunca en la
 * dirección, que es donde los registros de los intermediarios la verían.
 */
import { keyVariableOf, type LlmProvider } from './provider.js';

/**
 * `inconclusive` **nunca** es un veredicto sobre la credencial: es la ausencia de veredicto. Es la
 * distinción que impide degradar una instancia porque el proveedor tuvo un mal rato.
 */
export type CredentialVerdict = 'accepted' | 'rejected' | 'inconclusive';

/**
 * Plazo de la verificación. Corto a propósito: un `inconclusive` no es un problema en ninguno de
 * los dos consumidores, así que esperar más no compra nada.
 */
export const CREDENTIAL_PROBE_TIMEOUT_MS = 5_000;

/** Versión de la API de Anthropic que su cabecera exige declarar. */
const ANTHROPIC_VERSION = '2023-06-01';

interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Extremo de listado de modelos y cabecera de credencial de cada proveedor. Como la tabla de
 * `provider.ts`, actualizar uno es una línea.
 */
function probeRequest(provider: LlmProvider, apiKey: string): ProbeRequest {
  switch (provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      };
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'gemini':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        headers: { 'x-goog-api-key': apiKey },
      };
  }
}

export interface VerifyCredentialOptions {
  /** Señal de quien llama; se combina con el plazo propio. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** `fetch` inyectable: ninguna prueba hace red (FR-038). */
  fetch?: typeof globalThis.fetch;
  /** Destino de las líneas de registro. Nunca recibe ningún carácter de la credencial. */
  log?: (message: string) => void;
}

/**
 * Veredicto sobre una credencial. **Nunca lanza**: cualquier cosa que no sea una respuesta
 * clasificable es `inconclusive`.
 */
export async function verifyCredential(
  provider: LlmProvider,
  apiKey: string,
  options: VerifyCredentialOptions = {},
): Promise<CredentialVerdict> {
  const key = apiKey.trim();
  // Sin credencial no hay nada que verificar, y una petición sin ella no probaría nada: la
  // ausencia la detecta el entorno, que es quien la exige (FR-005).
  if (key === '') return 'inconclusive';
  if (options.signal?.aborted === true) return 'inconclusive';

  const doFetch = options.fetch ?? globalThis.fetch;
  const { url, headers } = probeRequest(provider, key);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? CREDENTIAL_PROBE_TIMEOUT_MS);
  const onAbort = () => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
    const status = response.status;
    if (status >= 200 && status < 300) return 'accepted';
    // Solo estos dos son un veredicto sobre la credencial. Un 400 es una petición mal formada por
    // nuestra parte y un 429 es un límite de ritmo: ninguno dice nada de si la clave sirve.
    if (status === 401 || status === 403) {
      options.log?.(
        `El proveedor rechazó la credencial de ${keyVariableOf(provider)} (HTTP ${String(status)}).`,
      );
      return 'rejected';
    }
    return 'inconclusive';
  } catch {
    // Red, DNS, plazo agotado o aborto: no hay veredicto. El error **no** se registra con su
    // texto, porque algunos clientes incluyen la petición —y con ella las cabeceras— en el mensaje.
    return 'inconclusive';
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Vigilante del estado de la credencial (R6, contracts/credential-verification.md §3)
// ---------------------------------------------------------------------------

/**
 * Cadencia del reintento mientras la credencial está rechazada.
 *
 * 5 minutos son, en el peor caso, 288 peticiones al día que no generan tokens, y acotan la
 * recuperación automática a «como mucho 5 minutos después de arreglar la clave». Un minuto no
 * compra nada —arreglar una credencial no es instantáneo— y una hora convierte la recuperación en
 * una llamada de soporte.
 */
export const CREDENTIAL_RETRY_INTERVAL_MS = 5 * 60_000;

export interface CredentialWatcherOptions {
  provider: LlmProvider;
  apiKey: string;
  /** Verificación inyectable (pruebas); por defecto, la real. */
  verify?: (provider: LlmProvider, apiKey: string) => Promise<CredentialVerdict>;
  log?: (message: string) => void;
  retryIntervalMs?: number;
}

export interface CredentialWatcher {
  /**
   * `rejected` es el único estado que degrada. `ok` cubre tanto «aceptada» como «no se pudo
   * comprobar»: la ausencia de veredicto no puede degradar nada.
   */
  state: () => 'ok' | 'rejected';
  /**
   * Comprueba la credencial una vez y ajusta el estado. **Nunca lanza.** La devuelve para quien
   * quiera anotar el arranque; el arranque la llama sin esperarla (FR-005a).
   */
  check: () => Promise<CredentialVerdict>;
  /** Para el reintento. El arranque lo llama en `stop()`. */
  close: () => void;
}

/**
 * Vigilante de dos estados, con la forma de `src/db/outage.ts` (016).
 *
 * Lo que se cuida aquí es el **volumen del registro**: una línea al entrar en degradado y una al
 * salir, nunca una por petición ni una por reintento. Un degradado de un día con reintentos cada
 * 5 minutos deja dos líneas, no 288.
 *
 * De `rejected` solo se sale por una verificación **aceptada**: ni por tiempo ni por intervención.
 * Es la única prueba de que la credencial volvió a servir, y es lo que permite que la instancia se
 * recupere sola sin reiniciar el proceso (FR-005b).
 *
 * El estado vive en memoria del proceso y **no se persiste**: se recalcula al arrancar, igual que
 * los avisos, que nunca se guardan.
 */
export function createCredentialWatcher(options: CredentialWatcherOptions): CredentialWatcher {
  const verify = options.verify ?? ((p, k) => verifyCredential(p, k));
  const retryIntervalMs = options.retryIntervalMs ?? CREDENTIAL_RETRY_INTERVAL_MS;
  const variable = keyVariableOf(options.provider);

  let state: 'ok' | 'rejected' = 'ok';
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  /** Tras un `await`, `closed` puede haber cambiado: se lee por función para no estrecharlo. */
  const isClosed = () => closed;

  const stopRetry = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const startRetry = () => {
    if (timer || closed) return;
    timer = setInterval(() => void check(), retryIntervalMs);
    // No mantiene el proceso vivo por sí solo: el servidor HTTP ya lo hace.
    timer.unref();
  };

  const check = async (): Promise<CredentialVerdict> => {
    if (closed) return 'inconclusive';
    let verdict: CredentialVerdict;
    try {
      verdict = await verify(options.provider, options.apiKey);
    } catch {
      // La verificación no lanza, pero si alguien inyecta una que sí, no puede tumbar el proceso.
      verdict = 'inconclusive';
    }
    if (isClosed()) return verdict;
    if (verdict === 'rejected' && state === 'ok') {
      state = 'rejected';
      options.log?.(
        `La credencial de ${variable} no es válida para el proveedor configurado: la instancia ` +
          'queda degradada y los clientes reciben solo el contacto del negocio. Se reintenta cada ' +
          '5 minutos y sale del degradado sola en cuanto la credencial sirva.',
      );
      startRetry();
    } else if (verdict === 'accepted' && state === 'rejected') {
      state = 'ok';
      stopRetry();
      options.log?.(`La credencial de ${variable} vuelve a ser válida: fin del degradado.`);
    }
    // `inconclusive` no cambia de estado ni abre un reintento: la ausencia de veredicto no degrada
    // nada, y tampoco saca a nadie de un degradado que sí tenía veredicto.
    return verdict;
  };

  return {
    state: () => state,
    check,
    close() {
      closed = true;
      stopRetry();
    },
  };
}
