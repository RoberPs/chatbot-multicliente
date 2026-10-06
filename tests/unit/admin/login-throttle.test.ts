/**
 * Freno del login del operador (012, US4, R16; contracts/public-routes-and-login.md § Login):
 * retardo creciente por los fallos de 15 min, cola de verificaciones con prioridad para el
 * navegador conocido y su cookie firmada.
 */
import { describe, expect, it } from 'vitest';
import {
  createLoginThrottle,
  delayFor,
  deviceKey,
  signDeviceCookie,
  verifyDeviceCookie,
} from '../../../src/admin/auth/login-throttle.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('retardo', () => {
  it.each([
    [0, 0],
    [5, 0],
    [6, 250],
    [10, 1250],
    [25, 5000],
    [500, 5000],
  ])('%i fallos → %i ms', (failures, ms) => {
    expect(delayFor(failures)).toBe(ms);
  });

  it('cuenta los fallos de los últimos 15 min y vuelve a cero al vaciarse la ventana', () => {
    let now = 0;
    const throttle = createLoginThrottle({ now: () => now });
    for (let i = 0; i < 8; i++) throttle.failure();
    expect(throttle.delayMs()).toBe(750);
    now += 15 * MINUTE + 1;
    expect(throttle.delayMs()).toBe(0);
  });
});

describe('cola de verificaciones', () => {
  /** Tarea que termina cuando se la libera. */
  function gate() {
    let open: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { done, open };
  }

  it('2 a la vez y 50 esperando; con la cola llena se rechaza sin ejecutar', async () => {
    const throttle = createLoginThrottle();
    const g = gate();
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await g.done;
      running -= 1;
      return 'ok';
    };
    const accepted = Array.from({ length: 52 }, () => throttle.run(task, false));
    const rejected = await throttle.run(task, false);
    expect(rejected).toBe('full');
    expect(throttle.stats()).toMatchObject({ active: 2, queued: 50 });
    g.open();
    expect(await Promise.all(accepted)).toEqual(Array(52).fill('ok'));
    expect(peak).toBe(2);
    expect(throttle.stats().rejected).toBe(1);
  });

  it('el navegador conocido pasa delante y nunca se rechaza por cola llena', async () => {
    const throttle = createLoginThrottle();
    const g = gate();
    const order: string[] = [];
    const task = (name: string) => async () => {
      await g.done;
      order.push(name);
      return name;
    };
    const busy = [throttle.run(task('a'), false), throttle.run(task('b'), false)];
    const waiting = Array.from({ length: 50 }, (_, i) =>
      throttle.run(task(`w${String(i)}`), false),
    );
    const known = throttle.run(task('conocido'), true);
    expect(await throttle.run(task('x'), false)).toBe('full');
    g.open();
    await Promise.all([...busy, ...waiting, known]);
    // Tras las dos que ya estaban en marcha, la del navegador conocido es la primera.
    expect(order.indexOf('conocido')).toBe(2);
  });
});

describe('cookie de navegador conocido', () => {
  const key = deviceKey('secreto-de-sesion-de-prueba-con-32-caracteres');
  const other = deviceKey('otro-secreto-de-sesion-de-prueba-con-32-car');

  it('v1.<caducidad>.<hmac> con 90 días; válida hasta caducar', () => {
    const cookie = signDeviceCookie(key, 1_000);
    expect(cookie).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
    expect(cookie.split('.')[1]).toBe(String(1_000 + 90 * DAY));
    expect(verifyDeviceCookie(key, cookie, 1_000 + 89 * DAY)).toBe(true);
    expect(verifyDeviceCookie(key, cookie, 1_000 + 90 * DAY + 1)).toBe(false);
  });

  it('manipulada, de otra clave o mal formada → inválida', () => {
    const cookie = signDeviceCookie(key, 0);
    const [v, exp, mac] = cookie.split('.');
    expect(verifyDeviceCookie(other, cookie, 0)).toBe(false);
    expect(
      verifyDeviceCookie(key, `${String(v)}.${String(Number(exp) + 1)}.${String(mac)}`, 0),
    ).toBe(false);
    for (const bad of ['', 'v1', 'v2.1.abc', 'v1.x.abc', undefined]) {
      expect(verifyDeviceCookie(key, bad, 0)).toBe(false);
    }
  });
});
