/**
 * Negocio de ejemplo expresado con los mismos formularios que usa el operador.
 * Los nombres de sector solo pueden aparecer en tests/fixtures (Principio I).
 */
export interface BusinessFixture {
  sector: string;
  business: Record<string, unknown>;
  hours: Array<[number, string, string]>;
  closures: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>>;
  /** `services` referencia servicios por nombre. */
  resources: Array<{
    name: string;
    services: string[];
    active?: boolean;
    hours: Array<[number, string, string]>;
    absences?: Array<Record<string, unknown>>;
  }>;
  faqs: Array<{ question: string; answer: string }>;
  policies: Record<string, unknown>;
  tone: Record<string, unknown>;
  handoff: {
    channels: Array<{ type: string; value: string }>;
    slots: Array<[number, string, string]>;
  };
}

export const weekdays = (
  days: number[],
  start: string,
  end: string,
): Array<[number, string, string]> => days.map((d) => [d, start, end]);
