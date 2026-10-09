/**
 * Vigilante del corte (016, T005; data-model §1, research R3): el registro de un corte no crece
 * con el número de peticiones ni con su duración (FR-014, SC-008), y ninguna anotación lleva
 * nada de la dirección de la base de datos (FR-012).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotEvent, EventContext } from '../../../src/conversation/activity-log.js';
import { createOutageWatcher, SUMMARY_INTERVAL_MS, PROBE_INTERVAL_MS } from '../../../src/db/outage.js';

const coded = (code: string, message = 'fallo'): Error =>
  Object.assign(new Error(message), { code });

interface Recorded {
  event: BotEvent;
  context?: EventContext;
}

/** Vigilante con reloj y sondeo falsos: el test decide el tiempo y si la base contesta. */
function setup({ up = false }: { up?: boolean } = {}) {
  const events: Recorded[] = [];
  let now = new Date('2026-10-09T10:00:00Z').getTime();
  let alive = up;
  const probe = vi.fn(async () => {
    if (!alive) throw coded('ECONNREFUSED');
  });
  const watcher = createOutageWatcher({
    probe,
    now: () => new Date(now),
  });
  watcher.attachLogger({
    log: (event, context) => events.push({ event, context }),
    pseudonym: () => 'abc123abc123',
  });
  return {
    events,
    probe,
    watcher,
    names: () => events.map((e) => e.event.event),
    /**
     * Avanza el reloj y los temporizadores **a la vez**, en pasos de un sondeo: si el reloj
     * saltara de golpe, los cientos de sondeos del intervalo verían todos el mismo instante y
     * el recuento de resúmenes no significaría nada.
     */
    advance: async (ms: number) => {
      const step = PROBE_INTERVAL_MS;
      for (let left = ms; left > 0; left -= step) {
        const chunk = Math.min(step, left);
        now += chunk;
        await vi.advanceTimersByTimeAsync(chunk);
      }
    },
    revive: () => {
      alive = true;
    },
  };
}

describe('vigilante del corte', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it('registra el inicio del corte una sola vez', async () => {
    const t = setup();
    t.watcher.note(coded('ECONNREFUSED'));
    t.watcher.note(coded('ECONNRESET'));
    t.watcher.note(coded('08006'));
    expect(t.names()).toEqual(['db_outage_started']);
    expect(t.watcher.state()).toBe('down');
    t.watcher.close();
  });

  it('cien fallos durante el corte no añaden ninguna anotación', async () => {
    const t = setup();
    for (let i = 0; i < 100; i++) t.watcher.note(coded('ECONNREFUSED'));
    expect(t.names()).toEqual(['db_outage_started']);
    t.watcher.close();
  });

  it('un error que no es de indisponibilidad no abre corte', async () => {
    const t = setup();
    t.watcher.note(coded('42601'));
    t.watcher.note(new Error('sin código'));
    expect(t.events).toEqual([]);
    expect(t.watcher.state()).toBe('up');
    t.watcher.close();
  });

  it('emite un resumen cada 5 minutos, con el tiempo y los fallos agrupados', async () => {
    const t = setup();
    t.watcher.note(coded('ECONNREFUSED'));
    t.watcher.note(coded('ECONNREFUSED'));
    await t.advance(SUMMARY_INTERVAL_MS);
    const summary = t.events.at(-1)?.event;
    expect(summary).toEqual({
      event: 'db_outage_ongoing',
      elapsedMs: SUMMARY_INTERVAL_MS,
      failures: 2,
    });
    t.watcher.close();
  });

  it('registra la recuperación con duración y fallos, y vuelve a up', async () => {
    const t = setup();
    t.watcher.note(coded('ECONNREFUSED'));
    t.revive();
    await t.advance(PROBE_INTERVAL_MS);
    expect(t.watcher.state()).toBe('up');
    expect(t.events.at(-1)?.event).toEqual({
      event: 'db_outage_recovered',
      durationMs: PROBE_INTERVAL_MS,
      failures: 1,
    });
    t.watcher.close();
  });

  it('un corte de una hora deja exactamente 13 anotaciones', async () => {
    const t = setup();
    t.watcher.note(coded('ECONNREFUSED'));
    // 55 min de corte: 11 resúmenes (5, 10, … 55).
    await t.advance(55 * 60_000);
    t.revive();
    await t.advance(5 * 60_000);
    expect(t.watcher.state()).toBe('up');
    // 1 inicio + 11 resúmenes + 1 recuperación.
    expect(t.events).toHaveLength(13);
    expect(t.names().filter((n) => n === 'db_outage_ongoing')).toHaveLength(11);
    t.watcher.close();
  });

  it('solo sale de down con un sondeo correcto, no por tiempo', async () => {
    const t = setup();
    t.watcher.note(coded('ECONNREFUSED'));
    await t.advance(30 * 60_000);
    expect(t.watcher.state()).toBe('down');
    t.watcher.close();
  });

  it('al recuperar vacía la memoria de avisos', async () => {
    const t = setup();
    t.watcher.note(coded('ECONNREFUSED'));
    expect(t.watcher.markNotified('wa:34600000000')).toBe(true);
    expect(t.watcher.markNotified('wa:34600000000')).toBe(false);
    t.revive();
    await t.advance(PROBE_INTERVAL_MS);
    t.watcher.note(coded('ECONNREFUSED'));
    expect(t.watcher.markNotified('wa:34600000000')).toBe(true);
    t.watcher.close();
  });

  it('ninguna anotación lleva la dirección de la base de datos (FR-012)', async () => {
    const t = setup();
    const url = 'postgres://operador:secreta@/chatbot?host=/var/run/postgresql';
    t.watcher.note(coded('ECONNREFUSED', `could not connect to ${url}`));
    await t.advance(SUMMARY_INTERVAL_MS);
    t.revive();
    await t.advance(PROBE_INTERVAL_MS);
    const dump = JSON.stringify(t.events);
    for (const secret of ['operador', 'secreta', 'chatbot', '/var/run/postgresql', 'postgres://']) {
      expect(dump).not.toContain(secret);
    }
    t.watcher.close();
  });

  it('sin registro enganchado no escribe nada y no se rompe', () => {
    const watcher = createOutageWatcher({ probe: async () => undefined });
    expect(() => {
      watcher.note(coded('ECONNREFUSED'));
    }).not.toThrow();
    expect(watcher.state()).toBe('down');
    watcher.close();
  });
});
