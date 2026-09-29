/**
 * `pnpm handoff:templates`: imprime el JSON de las tres plantillas de WhatsApp de los avisos de
 * derivación (005, R6) para darlas de alta con `POST /{waba-id}/message_templates`. Categoría
 * UTILITY, idioma de WHATSAPP_TEMPLATE_LANG (por defecto `es`) y los botones «Le atiendo» y
 * «Terminado». Los ejemplos son genéricos: Meta los pide para revisar la plantilla.
 */
import { HANDOFF_BUTTONS, HANDOFF_TEMPLATES } from '../channels/whatsapp/template-sender.js';
import { loadDotEnvIfPresent } from '../config/env.js';

const EXAMPLES: Record<keyof typeof HANDOFF_TEMPLATES, string[]> = {
  alert: [
    'Lucía',
    '+34 611 22 23 33',
    'WhatsApp',
    'quiere hablar con una persona',
    'Pregunta por un precio y quiere hablar con alguien.',
  ],
  reminder: ['Lucía', '+34 611 22 23 33', 'hoy a las 10:15', 'Pregunta por un precio.'],
  forward: ['Lucía', '+34 611 22 23 33', 'Al final puedo pasarme mañana por la tarde'],
};

/** Cuerpo de `POST /{waba-id}/message_templates` de cada plantilla. */
export function templateDefinitions(language: string) {
  return (Object.keys(HANDOFF_TEMPLATES) as Array<keyof typeof HANDOFF_TEMPLATES>).map((key) => ({
    name: HANDOFF_TEMPLATES[key].name,
    language,
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: HANDOFF_TEMPLATES[key].body,
        example: { body_text: [EXAMPLES[key]] },
      },
      {
        type: 'BUTTONS',
        buttons: HANDOFF_BUTTONS.map((text) => ({ type: 'QUICK_REPLY', text })),
      },
    ],
  }));
}

const isMain = /cli\/handoff-templates\.[jt]s$/.test(process.argv[1]?.replaceAll('\\', '/') ?? '');
if (isMain) {
  loadDotEnvIfPresent();
  const language = process.env.WHATSAPP_TEMPLATE_LANG?.trim() || 'es';
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) {
    console.error('WHATSAPP_TEMPLATE_LANG debe tener el formato xx o xx_XX');
    process.exit(1);
  }
  console.log(JSON.stringify(templateDefinitions(language), null, 2));
}
