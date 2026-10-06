import type { CountryCode } from 'libphonenumber-js';
import type { Db } from '../../db/client.js';
import type { AlertRouteAvailability } from '../types.js';

/** Dependencias de los casos de uso: la BD de la instancia y su región telefónica por defecto. */
export interface KnowledgeDeps {
  db: Db;
  phoneRegion: CountryCode;
  /** Vías de aviso de derivación que la instancia puede usar (005); por defecto, ninguna. */
  alertRoutes?: AlertRouteAvailability;
}
