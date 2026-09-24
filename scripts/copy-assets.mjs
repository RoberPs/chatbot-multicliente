// Copia las plantillas y migraciones a dist/ tras compilar con tsc.
import { cpSync } from 'node:fs';

cpSync('src/admin/views', 'dist/src/admin/views', { recursive: true });
cpSync('src/db/migrations', 'dist/src/db/migrations', { recursive: true });
