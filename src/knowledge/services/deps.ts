import type { CountryCode } from 'libphonenumber-js';
import type { Db } from '../../db/client.js';

/** Dependencias de los casos de uso: la BD de la instancia y su región telefónica por defecto. */
export interface KnowledgeDeps {
  db: Db;
  phoneRegion: CountryCode;
}
