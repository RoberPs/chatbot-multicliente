// Copia las plantillas, assets y migraciones a dist/ tras compilar con tsc.
import { cpSync } from 'node:fs';

cpSync('src/admin/views', 'dist/src/admin/views', { recursive: true });
cpSync('src/channels/web/views', 'dist/src/channels/web/views', { recursive: true });
cpSync('src/channels/web/assets', 'dist/src/channels/web/assets', { recursive: true });
cpSync('src/channels/handoff-links/views', 'dist/src/channels/handoff-links/views', {
  recursive: true,
});
cpSync('src/db/migrations', 'dist/src/db/migrations', { recursive: true });
