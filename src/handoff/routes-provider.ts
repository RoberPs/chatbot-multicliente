/**
 * Vías de aviso disponibles ahora (005, R16): lee los destinos de `handoff_alerts` sin caché en
 * cada uso y los cruza con lo que la instancia puede enviar. En el playground solo existe la
 * vía simulada (FR-021).
 */
import type { DbOrTx } from '../conversation/repositories/customer.js';
import type { AlertRoute, AlertRoutesProvider } from './ports.js';
import { availability, readHandoffAlerts } from './settings.js';

export interface AlertRoutesProviderDeps {
  /** Vía WhatsApp hacia un número (solo si la instancia tiene canal de WhatsApp). */
  whatsapp?: ((to: string) => AlertRoute) | null;
  /** Vía email hacia una dirección (solo con SMTP y PUBLIC_BASE_URL). */
  email?: ((to: string) => AlertRoute) | null;
  simulated: AlertRoute;
}

export function createAlertRoutesProvider(deps: AlertRoutesProviderDeps): AlertRoutesProvider {
  const instance = { whatsapp: Boolean(deps.whatsapp), email: Boolean(deps.email) };
  return {
    async available(tx: DbOrTx, { simulate }) {
      if (simulate) return [deps.simulated];
      const alerts = await readHandoffAlerts(tx);
      const usable = availability(alerts, instance);
      const routes: AlertRoute[] = [];
      if (usable.whatsapp && alerts.whatsapp && deps.whatsapp) {
        routes.push(deps.whatsapp(alerts.whatsapp));
      }
      if (usable.email && alerts.email && deps.email) routes.push(deps.email(alerts.email));
      return routes;
    },
  };
}
