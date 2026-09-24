import type { Warning } from './types.js';

/** El elemento pedido no existe. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} no encontrado`);
    this.name = 'NotFoundError';
  }
}

/** Dato válido en formato pero en conflicto con lo guardado (duplicado, referencia inexistente). */
export class FieldConflictError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'FieldConflictError';
  }
}

/** El cambio dejaría un negocio activo con un aviso crítico (FR-032). No se guarda nada. */
export class CriticalWarningError extends Error {
  constructor(readonly warnings: Warning[]) {
    super('El negocio está activo y se quedaría sin salida a una persona');
    this.name = 'CriticalWarningError';
  }
}

/** La activación se rechaza por avisos críticos (FR-031). */
export class ActivationBlockedError extends Error {
  constructor(readonly warnings: Warning[]) {
    super('No se puede activar el negocio mientras haya avisos críticos');
    this.name = 'ActivationBlockedError';
  }
}
