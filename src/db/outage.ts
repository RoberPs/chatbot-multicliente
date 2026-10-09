/**
 * Vigilante del corte de la base de datos (016, data-model §1, research R3).
 *
 * Problema que resuelve: durante un corte, **cada** conexión que se cae y **cada** petición que
 * falla produce un error. Registrarlos todos llena el registro de miles de líneas iguales y hace
 * que su volumen crezca con el tráfico y con la duración del corte (FR-014, SC-008). Aquí se
 * agrupan: una anotación al empezar, un resumen cada 5 min y una al recuperar.
 *
 * El estado vive **en memoria del proceso** y nunca se guarda: durante un corte, por definición,
 * no se puede escribir en la base de datos.
 *
 * De `down` solo se sale por un sondeo correcto —ni por tiempo ni por intervención—, porque es
 * la única prueba de que la base volvió. Ese mismo sondeo es lo que permite que la instancia se
 * recupere sola, sin reiniciar el proceso (FR-004).
 *
 * Por omisión es **silencioso**: las órdenes de `src/cli` lo usan sin que escriba nada inesperado
 * en su salida. El arranque le entrega el registro de la instancia con `attachLogger()`.
 */
import { isDbUnavailable } from './client.js';
import type { ActivityLog } from '../conversation/activity-log.js';

/** Cada cuánto se sondea la base mientras está caída. SC-003 pide recuperar en menos de 30 s. */
export const PROBE_INTERVAL_MS = 10_000;
/** Cada cuánto se resume un corte en curso. Un corte de una hora deja 13 anotaciones. */
export const SUMMARY_INTERVAL_MS = 5 * 60_000;

export interface OutageWatcherOptions {
  /** Comprueba si la base responde; lanza si no. En producción, un `select 1`. */
  probe: () => Promise<unknown>;
  /** Reloj, inyectable para las pruebas. */
  now?: () => Date;
  probeIntervalMs?: number;
  summaryIntervalMs?: number;
}

export interface OutageWatcher {
  /**
   * Recibe un error de la base de datos. Si es de indisponibilidad y estábamos `up`, abre el
   * corte; si ya estábamos `down`, solo cuenta. Un error que no es de indisponibilidad no cambia
   * nada: no se inventan cortes.
   */
  note: (error: unknown) => void;
  state: () => 'up' | 'down';
  /**
   * Reserva el aviso degradado de un cliente: `true` la primera vez en este corte, `false`
   * después. Así el aviso llega una vez por cliente y corte y no con cada reintento de la
   * plataforma (FR-002, cadencia de los canales asincrónicos).
   */
  markNotified: (channelUserId: string) => boolean;
  attachLogger: (log: ActivityLog) => void;
  /** Para el sondeo. El arranque lo llama en `stop()`. */
  close: () => void;
}

export function createOutageWatcher(options: OutageWatcherOptions): OutageWatcher {
  const now = options.now ?? (() => new Date());
  const probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const summaryIntervalMs = options.summaryIntervalMs ?? SUMMARY_INTERVAL_MS;

  let state: 'up' | 'down' = 'up';
  let since: Date | null = null;
  let failures = 0;
  let lastSummaryAt: Date | null = null;
  let notified = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let log: ActivityLog | null = null;
  let closed = false;

  const stopProbe = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const recover = () => {
    const at = now();
    const durationMs = since ? at.getTime() - since.getTime() : 0;
    const total = failures;
    state = 'up';
    since = null;
    failures = 0;
    lastSummaryAt = null;
    notified = new Set();
    stopProbe();
    log?.log({ event: 'db_outage_recovered', durationMs, failures: total });
  };

  const tick = async () => {
    if (state !== 'down' || closed) return;
    try {
      await options.probe();
      recover();
      return;
    } catch {
      // Sigue caída: no se registra nada por sondeo, solo el resumen cuando toca.
    }
    const at = now();
    const reference = lastSummaryAt ?? since;
    if (reference && at.getTime() - reference.getTime() >= summaryIntervalMs) {
      lastSummaryAt = at;
      log?.log({
        event: 'db_outage_ongoing',
        elapsedMs: since ? at.getTime() - since.getTime() : 0,
        failures,
      });
    }
  };

  const startProbe = () => {
    if (timer) return;
    timer = setInterval(() => void tick(), probeIntervalMs);
    // No mantiene el proceso vivo por sí solo: el servidor HTTP ya lo hace.
    timer.unref();
  };

  return {
    state: () => state,
    note(error) {
      if (closed || !isDbUnavailable(error)) return;
      failures += 1;
      if (state === 'down') return;
      state = 'down';
      since = now();
      lastSummaryAt = null;
      // Sin campos: el error no viaja al registro, para que no lleve la dirección (FR-012).
      log?.log({ event: 'db_outage_started' });
      startProbe();
    },
    markNotified(channelUserId) {
      if (notified.has(channelUserId)) return false;
      notified.add(channelUserId);
      return true;
    },
    attachLogger(next) {
      log = next;
    },
    close() {
      closed = true;
      stopProbe();
    },
  };
}
