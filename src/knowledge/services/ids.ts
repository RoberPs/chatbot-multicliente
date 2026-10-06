import { z } from 'zod';
import { formList } from '../schemas/common.js';
import { NotFoundError } from '../errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

/** Lanza `NotFoundError` si el id no tiene formato de uuid (evita errores de tipo en la BD). */
export function assertId(id: string, what: string): void {
  if (!isUuid(id)) throw new NotFoundError(what);
}

/** Formulario de reordenación: `ids[]` en el nuevo orden. */
export const reorderSchema = z.object({ ids: formList(z.string().trim()) });

export function parseReorder(input: unknown, what: string): string[] {
  const { ids } = reorderSchema.parse(input);
  ids.forEach((id) => {
    assertId(id, what);
  });
  return ids;
}
