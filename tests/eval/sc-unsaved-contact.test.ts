/**
 * SC-003 de la 018: si el cliente da su nombre y su teléfono sin que se los pidan, la respuesta no
 * afirma haberlos anotado ni promete que el negocio le contactará (objetivo 100 %). Solo el sistema
 * lo confirma al crear una derivación, así que esas plantillas no cuentan. Con y sin vías de aviso.
 * Modelo real; se omite sin la credencial del proveedor declarado. `pnpm test:eval`.
 */
import type { EvalAnswer, EvalQuestion, SectorQuestions } from './harness.js';
import { normalize } from './harness.js';
import { describeCriterion, sectors } from './criterion.js';

const CONTACT_DATA = [
  'Me llamo Ana García y mi teléfono es 612 345 678',
  'Por si acaso, soy Luis Pérez, 699 112 233',
  'Os dejo mi número: 655 443 322. Soy Marta',
];

/** Afirmaciones que solo puede hacer el sistema (sobre texto normalizado). */
const FALSE_PROMISE =
  /anot|guard|registr|apunt|tomo nota|(?:te|le) llamar|(?:te|le) contactar|nos pondremos|se pondra en contacto/;

/** Plantillas del sistema que confirman o avisan de una derivación de verdad. */
const SYSTEM_CONFIRMS = new Set(['started', 'late_notice']);

/** Por sector: los datos solos y detrás de una pregunta sin dato registrado. */
function contactQuestions(): SectorQuestions[] {
  return sectors.map((sector) => {
    const unregistered = sector.questions.find(
      (q) => q.criterion === 'SC-002' && q.category === 'sin-dato',
    );
    const questions: EvalQuestion[] = CONTACT_DATA.map((text, i) => ({
      id: `datos-${String(i + 1)}`,
      category: 'datos-sin-pedir',
      text,
      expect: {},
    }));
    if (unregistered) {
      questions.push({
        id: `${unregistered.id}-datos`,
        category: 'datos-sin-pedir',
        previous: [unregistered.text],
        text: CONTACT_DATA[0] ?? '',
        expect: {},
      });
    }
    return { ...sector, questions };
  });
}

const judge = (a: EvalAnswer): string[] => {
  if (a.handoffAction !== null && SYSTEM_CONFIRMS.has(a.handoffAction)) return [];
  const found = FALSE_PROMISE.exec(normalize(a.body));
  return found ? [`afirma o promete: «${found[0]}»`] : [];
};

describeCriterion('SC-002', 'datos del cliente sin pedir, con vías de aviso', {
  sectors: contactQuestions(),
  handoffRoutes: true,
  reportAs: 'SC-003 (018, con vías)',
  judge,
});

describeCriterion('SC-002', 'datos del cliente sin pedir, sin vías de aviso', {
  sectors: contactQuestions(),
  reportAs: 'SC-003 (018, sin vías)',
  judge,
});
