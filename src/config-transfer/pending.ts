/**
 * Ficheros validados pendientes de confirmar (008, research R10): en memoria del proceso, con
 * un identificador aleatorio de 128 bits, la época de la sesión del operador y caducidad de
 * 30 minutos; como máximo 5 (la sexta entrada desplaza a la más antigua). Un reinicio o un
 * cierre de sesión obliga a subir el fichero otra vez.
 */
import { randomBytes } from 'node:crypto';
import type { ConfigDocument, ConfigFileEnvelope } from './format.js';

export const PENDING_TTL_MS = 30 * 60 * 1000;
export const PENDING_MAX = 5;

export interface PendingData<R> {
  document: ConfigDocument;
  envelope: ConfigFileEnvelope;
  /** `INSTANCE_ID` de origen validado, para los registros. */
  sourceInstance: string | null;
  /** Resultado de la aplicación: tras aplicar, la entrada solo sirve para mostrarlo. */
  result?: R;
}

export interface PendingImport<R> extends PendingData<R> {
  id: string;
  epoch: string;
  createdAt: number;
  previewed: boolean;
}

export interface PendingImportsOptions<R> {
  now?: () => number;
  newId?: () => string;
  ttlMs?: number;
  max?: number;
  /** Se llama al descartar una entrada no aplicada por caducidad o desplazamiento. */
  onExpire?: (entry: PendingImport<R>, reason: 'expired') => void;
}

export class PendingImports<R = unknown> {
  private readonly entries = new Map<string, PendingImport<R>>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly onExpire: (entry: PendingImport<R>, reason: 'expired') => void;

  constructor(opts: PendingImportsOptions<R> = {}) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => randomBytes(16).toString('base64url'));
    this.ttlMs = opts.ttlMs ?? PENDING_TTL_MS;
    this.max = opts.max ?? PENDING_MAX;
    this.onExpire = opts.onExpire ?? (() => undefined);
  }

  get size(): number {
    return this.entries.size;
  }

  private drop(entry: PendingImport<R>): void {
    this.entries.delete(entry.id);
    if (entry.result === undefined) this.onExpire(entry, 'expired');
  }

  private purge(): void {
    const limit = this.now() - this.ttlMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.createdAt <= limit) this.drop(entry);
    }
  }

  /** Guarda un fichero validado para la sesión `epoch`. */
  add(epoch: string, data: PendingData<R>): PendingImport<R> {
    this.purge();
    while (this.entries.size >= this.max) {
      const oldest = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.drop(oldest);
    }
    const entry: PendingImport<R> = {
      ...data,
      id: this.newId(),
      epoch,
      createdAt: this.now(),
      previewed: false,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** La entrada de esta sesión, si existe y no ha caducado. */
  get(id: string, epoch: string): PendingImport<R> | undefined {
    this.purge();
    const entry = this.entries.get(id);
    return entry && entry.epoch === epoch ? entry : undefined;
  }

  /** Quita la entrada (cancelación del operador); devuelve la que había. */
  remove(id: string): PendingImport<R> | undefined {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    return entry;
  }

  /** `true` solo la primera vez que se muestra la vista previa (para registrarla una vez). */
  markPreviewed(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.previewed) return false;
    entry.previewed = true;
    return true;
  }

  /** Se puede confirmar: existe y todavía no se ha aplicado. */
  canApply(id: string, epoch: string): boolean {
    const entry = this.get(id, epoch);
    return entry !== undefined && entry.result === undefined;
  }

  /** Guarda el resultado de la aplicación; la entrada ya no admite otra confirmación. */
  markApplied(id: string, result: R): void {
    const entry = this.entries.get(id);
    if (entry) entry.result = result;
  }

  getResult(id: string, epoch: string): R | undefined {
    return this.get(id, epoch)?.result;
  }
}
