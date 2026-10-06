/**
 * Sonda de salud de la imagen (013, research R6, contracts/image-and-repo.md): la ejecuta el
 * `HEALTHCHECK` del Dockerfile como `node dist/src/cli/healthcheck.js`. Pide la vista pública de
 * `/health` (sin secreto, para que no aparezca en `docker inspect`) y sale con 0 solo si la
 * instancia responde 200 con `{"status":"ok"}`; con cualquier otra cosa, 1. No escribe nada: el
 * estado de Docker no debe llenarse de detalles. Usa `fetch` de Node, porque la imagen no trae
 * curl ni wget.
 */
import { pathToFileURL } from 'node:url';

export interface ProbeOptions {
  /** Puerto de la instancia; por defecto `PORT` del contenedor o 3000. */
  port?: number;
  fetch?: typeof globalThis.fetch;
  /** Plazo de la petición entera, por debajo del `--timeout` de 5 s del `HEALTHCHECK`. */
  timeoutMs?: number;
}

function defaultPort(): number {
  const raw = process.env.PORT?.trim();
  return raw === undefined || raw === '' ? 3000 : Number(raw);
}

export async function probeHealth(options: ProbeOptions = {}): Promise<0 | 1> {
  const port = options.port ?? defaultPort();
  const request = options.fetch ?? globalThis.fetch;
  try {
    const response = await request(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    });
    if (response.status !== 200) return 1;
    const body = (await response.json()) as { status?: unknown } | null;
    return body?.status === 'ok' ? 0 : 1;
  } catch {
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(await probeHealth());
}
