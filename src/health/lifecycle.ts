/**
 * Ciclo de vida de la instancia (009, research R3): `starting` hasta que el arranque termina
 * (servidor, bot y tareas), `ready` mientras atiende y `stopping` desde que empieza el cierre.
 * Sin estado persistente; de `stopping` no se vuelve a `ready`.
 */
export type LifecycleState = 'starting' | 'ready' | 'stopping';

export interface Lifecycle {
  readonly state: LifecycleState;
  markReady(): void;
  markStopping(): void;
}

export function createLifecycle(): Lifecycle {
  let state: LifecycleState = 'starting';
  return {
    get state() {
      return state;
    },
    markReady() {
      if (state === 'starting') state = 'ready';
    },
    markStopping() {
      state = 'stopping';
    },
  };
}
