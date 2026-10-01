import { describe, expect, it } from 'vitest';
import { createLifecycle } from '../../../src/health/lifecycle.js';

describe('ciclo de vida de la instancia (009, R3)', () => {
  it('empieza en starting', () => {
    expect(createLifecycle().state).toBe('starting');
  });

  it('starting → ready → stopping', () => {
    const lifecycle = createLifecycle();
    lifecycle.markReady();
    expect(lifecycle.state).toBe('ready');
    lifecycle.markStopping();
    expect(lifecycle.state).toBe('stopping');
  });

  it('stopping no vuelve a ready', () => {
    const lifecycle = createLifecycle();
    lifecycle.markStopping();
    lifecycle.markReady();
    expect(lifecycle.state).toBe('stopping');
  });
});
