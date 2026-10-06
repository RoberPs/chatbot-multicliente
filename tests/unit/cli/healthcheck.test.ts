import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeHealth } from '../../../src/cli/healthcheck.js';

interface Seen {
  url?: string;
  host?: string;
  headers?: IncomingHttpHeaders;
}

let server: Server | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  const s = server;
  server = null;
  if (s) {
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
    });
  }
});

/** Servidor de prueba en `127.0.0.1` con la respuesta dada (o ninguna). */
async function serve(
  respond: ((res: import('node:http').ServerResponse) => void) | null,
  seen: Seen = {},
): Promise<number> {
  server = createServer((req, res) => {
    seen.url = req.url;
    seen.host = req.socket.localAddress;
    seen.headers = req.headers;
    if (respond) respond(res);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const json = (status: number, body: string) => (res: import('node:http').ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};

describe('probeHealth (013, contracts/image-and-repo.md)', () => {
  it('200 con {"status":"ok"} → 0, a 127.0.0.1/health y sin Authorization', async () => {
    const seen: Seen = {};
    const port = await serve(json(200, '{"status":"ok","coreVersion":"0.1.0"}'), seen);
    expect(await probeHealth({ port })).toBe(0);
    expect(seen.url).toBe('/health');
    expect(seen.host).toBe('127.0.0.1');
    expect(seen.headers?.authorization).toBeUndefined();
  });

  it.each([
    ['503 not_ready', 503, '{"status":"not_ready"}'],
    ['503 degraded', 503, '{"status":"degraded"}'],
    ['429', 429, '{"error":"too_many_requests"}'],
    ['200 con otro estado', 200, '{"status":"degraded"}'],
    ['200 con JSON no válido', 200, 'no es json'],
    ['500', 500, '{"status":"ok"}'],
  ])('%s → 1', async (_name, status, body) => {
    const port = await serve(json(status, body));
    expect(await probeHealth({ port })).toBe(1);
  });

  it('servidor que no responde dentro del plazo → 1', async () => {
    const port = await serve(null);
    const started = Date.now();
    expect(await probeHealth({ port, timeoutMs: 200 })).toBe(1);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('puerto cerrado → 1', async () => {
    const port = await serve(json(200, '{"status":"ok"}'));
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = null;
    expect(await probeHealth({ port })).toBe(1);
  });

  it('sin PORT usa 3000', async () => {
    const urls: string[] = [];
    const fakeFetch: typeof fetch = (url) => {
      urls.push(url instanceof Request ? url.url : url.toString());
      return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
    };
    vi.stubEnv('PORT', undefined);
    expect(await probeHealth({ fetch: fakeFetch })).toBe(0);
    vi.stubEnv('PORT', '8080');
    expect(await probeHealth({ fetch: fakeFetch })).toBe(0);
    vi.unstubAllEnvs();
    expect(urls).toEqual(['http://127.0.0.1:3000/health', 'http://127.0.0.1:8080/health']);
  });

  it('no escribe nada en la salida', async () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const port = await serve(json(503, '{"status":"degraded"}'));
    await probeHealth({ port });
    await probeHealth({ port: 1, timeoutMs: 100 });
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
