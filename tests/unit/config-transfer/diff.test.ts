/* eslint-disable @typescript-eslint/no-non-null-assertion -- los elementos existen por construcción del ejemplo; si no, el test debe fallar */
/** Diff por secciones y destacados (008, research R8). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffConfig, type DiffOptions } from '../../../src/config-transfer/diff.js';
import type { ConfigDocument } from '../../../src/config-transfer/format.js';
import { validateConfigFile } from '../../../src/config-transfer/parse.js';

function load(name: string): ConfigDocument {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'config', name), 'utf8'),
  ) as unknown;
  const result = validateConfigFile(raw, 'ES');
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
}

const base = (): ConfigDocument => structuredClone(load('valid-full-with-alerts.json'));
const OPTS: DiffOptions = {
  destinationWebChatEnabled: false,
  sameInstance: null,
  fileIncludesAlerts: false,
};

function diffOf(change: (doc: ConfigDocument) => void, opts: Partial<DiffOptions> = {}) {
  const before = base();
  const after = base();
  change(after);
  return diffConfig(before, after, { ...OPTS, ...opts });
}

const section = (d: ReturnType<typeof diffOf>, key: string) =>
  d.sections.find((s) => s.section === key);

describe('diffConfig', () => {
  it('documentos iguales → sin secciones', () => {
    const d = diffOf(() => undefined);
    expect(d.sections).toEqual([]);
    expect(d.highlights.timezoneChanged).toBeNull();
    expect(d.highlights.currencyChanged).toBeNull();
  });

  it('servicios emparejados por nombre normalizado: cambiar mayúsculas o espacios es modificar', () => {
    const d = diffOf((doc) => {
      const s = doc.services[0];
      if (s) s.name = '  servicio   A ';
    });
    const services = section(d, 'services');
    expect(services?.added).toEqual([]);
    expect(services?.removed).toEqual([]);
    expect(services?.modified).toEqual([
      {
        label: '  servicio   A ',
        fields: [
          { field: 'name', fieldLabel: 'Nombre', before: 'Servicio A', after: '  servicio   A ' },
        ],
      },
    ]);
  });

  it('añadidos, eliminados y campos con valores formateados (importe con moneda, minutos)', () => {
    const d = diffOf((doc) => {
      doc.services.push({ ...doc.services[0]!, name: 'Servicio C' });
      doc.services.splice(1, 1);
      doc.services[0]!.priceCents = 3050;
      doc.services[0]!.durationMinutes = 120;
    });
    const services = section(d, 'services');
    expect(services?.added).toEqual([{ label: 'Servicio C' }]);
    expect(services?.removed).toEqual([{ label: 'Servicio B' }]);
    expect(services?.modified[0]?.fields).toEqual([
      // Intl separa el importe del símbolo con un espacio no separable.
      { field: 'priceCents', fieldLabel: 'Precio', before: '25,00 €', after: '30,50 €' },
      { field: 'durationMinutes', fieldLabel: 'Duración', before: '30 min', after: '2 horas' },
    ]);
  });

  it('preguntas por pregunta normalizada y, entre repetidas, por orden', () => {
    const before = base();
    before.faqs = [
      { question: '¿Dudas?', answer: 'Primera' },
      { question: '¿Dudas?', answer: 'Segunda' },
    ];
    const after = structuredClone(before);
    after.faqs[1]!.answer = 'Segunda cambiada';
    const d = diffConfig(before, after, OPTS);
    expect(section(d, 'faqs')?.modified).toEqual([
      {
        label: '¿Dudas?',
        fields: [
          {
            field: 'answer',
            fieldLabel: 'Respuesta',
            before: 'Segunda',
            after: 'Segunda cambiada',
          },
        ],
      },
    ]);
  });

  it('cierres por fechas y horas, con el motivo como campo', () => {
    const d = diffOf((doc) => {
      doc.closures[1]!.reason = 'Vacaciones';
      doc.closures[0]!.endTime = '13:00';
    });
    const closures = section(d, 'closures');
    expect(closures?.modified).toEqual([
      {
        label: '24/12/2026 – 26/12/2026',
        fields: [{ field: 'reason', fieldLabel: 'Motivo', before: 'Navidad', after: 'Vacaciones' }],
      },
    ]);
    expect(closures?.added).toEqual([{ label: '02/11/2026 09:00–13:00' }]);
    expect(closures?.removed).toEqual([{ label: '02/11/2026 09:00–12:00' }]);
  });

  it('medios de derivación por tipo y valor', () => {
    const d = diffOf((doc) => {
      doc.handoff!.channels[1] = { type: 'whatsapp', value: '+34600123456' };
    });
    expect(section(d, 'handoff')).toMatchObject({
      added: [{ label: 'WhatsApp +34600123456' }],
      removed: [{ label: 'Email atencion@example.com' }],
    });
  });

  it('franjas comparadas por día', () => {
    const d = diffOf((doc) => {
      doc.openingHours[0]!.end = '13:30';
      doc.openingHours.push({ weekday: 5, start: '10:00', end: '12:00' });
      doc.openingHours = doc.openingHours.filter((h) => h.weekday !== 6);
    });
    const hours = section(d, 'openingHours');
    expect(hours?.modified).toEqual([
      {
        label: 'lun',
        fields: [
          {
            field: 'hours',
            fieldLabel: 'Franjas',
            before: 'lun 09:00–14:00, 16:00–20:00',
            after: 'lun 09:00–13:30, 16:00–20:00',
          },
        ],
      },
    ]);
    expect(hours?.added).toEqual([{ label: 'vie 10:00–12:00' }]);
    expect(hours?.removed).toEqual([{ label: 'sáb 10:00–14:00' }]);
  });

  it('filas únicas campo a campo y null ↔ objeto', () => {
    const d = diffOf((doc) => {
      doc.policies!.cancellationNoticeMinutes = 2880;
      doc.tone = null;
      doc.business.email = null;
    });
    expect(section(d, 'policies')?.modified[0]?.fields).toEqual([
      {
        field: 'cancellationNoticeMinutes',
        fieldLabel: 'Aviso para cancelar',
        before: '1 día',
        after: '2 días',
      },
    ]);
    expect(section(d, 'tone')?.removed).toEqual([{ label: 'Tono' }]);
    expect(section(d, 'business')?.modified[0]?.fields).toEqual([
      { field: 'email', fieldLabel: 'Email', before: 'hola@example.com', after: '—' },
    ]);
    const back = diffConfig({ ...base(), policies: null }, base(), OPTS);
    expect(section(back, 'policies')?.added).toEqual([{ label: 'Políticas' }]);
  });

  it('solo cambio de orden → reordered sin otros cambios', () => {
    const d = diffOf((doc) => doc.services.reverse());
    expect(d.sections).toEqual([
      {
        section: 'services',
        sectionLabel: 'Servicios',
        added: [],
        modified: [],
        removed: [],
        reordered: true,
      },
    ]);
  });

  it('destacados: zona horaria, moneda, misma instancia y destinos incluidos', () => {
    const d = diffOf(
      (doc) => {
        doc.business.timezone = 'Atlantic/Canary';
        doc.business.currency = 'USD';
      },
      { sameInstance: true, fileIncludesAlerts: true },
    );
    expect(d.highlights).toMatchObject({
      timezoneChanged: { before: 'Europe/Madrid', after: 'Atlantic/Canary' },
      currencyChanged: { before: 'EUR', after: 'USD' },
      sameInstance: true,
      alertDestinationsIncluded: true,
      webChat: null,
    });
    // El importe se formatea con la moneda de cada lado.
    expect(diffOf(() => undefined, { sameInstance: false }).highlights.sameInstance).toBe(false);
  });

  it('con el chat web del destino activado: webs quitadas y añadidas y cambio de topes', () => {
    const d = diffOf(
      (doc) => {
        doc.webChat.allowedOrigins = ['https://nueva.example.com'];
        doc.webChat.dailyCap = 100;
      },
      { destinationWebChatEnabled: true },
    );
    expect(d.highlights.webChat).toEqual({
      destinationEnabled: true,
      removedOrigins: ['https://www.example.com'],
      addedOrigins: ['https://nueva.example.com'],
      capsChanged: true,
    });
    expect(diffOf(() => undefined, { destinationWebChatEnabled: true }).highlights.webChat).toEqual(
      {
        destinationEnabled: true,
        removedOrigins: [],
        addedOrigins: [],
        capsChanged: false,
      },
    );
  });
});

describe('diffConfig: diseño del chat (011, data-model §6)', () => {
  const withDesign = (): ConfigDocument => structuredClone(load('v2-chat-design.json'));
  const design = (doc: ConfigDocument) => doc.chatDesign!;
  const diff = (before: ConfigDocument, after: ConfigDocument) =>
    section(diffConfig(before, after, OPTS), 'chatDesign');
  const fields = (d: ReturnType<typeof diff>) =>
    Object.fromEntries(
      (d?.modified[0]?.fields ?? []).map((f) => [f.fieldLabel, [f.before, f.after]]),
    );

  it('mismo diseño → sin cambios', () => {
    expect(diff(withDesign(), withDesign())).toBeUndefined();
  });

  it('destino sin diseño y fichero con diseño → añadido, con los campos efectivos que cambian', () => {
    const d = diff(base(), withDesign());
    expect(d?.sectionLabel).toBe('Diseño del chat');
    expect(d?.added).toEqual([{ label: 'Diseño del chat' }]);
    const f = fields(d);
    expect(f['Color principal']).toEqual(['#1f5fbf', '#0b6e4f']);
    expect(f.Forma).toEqual(['Redondeada', 'Suave']);
    expect(f['Posición']).toEqual(['Abajo a la derecha', 'Abajo a la izquierda']);
    expect(f['Tamaño']).toEqual(['Mediano', 'Grande']);
    expect(f['Nombre del chat']).toEqual(['—', 'Atención al cliente']);
    expect(f.Logo).toEqual(['—', 'Imagen (PNG, 64 × 64)']);
    expect(f.Avatar).toEqual(['—', 'Imagen (JPEG, 64 × 64)']);
    expect(f['Icono del botón']).toEqual(['—', 'Imagen (WebP, 64 × 64)']);
    // Lo que no cambia respecto del original no aparece.
    expect(f['Texto sobre el principal']).toBeUndefined();
  });

  it('destino con diseño y fichero sin él → "vuelve al aspecto original"', () => {
    const d = diff(withDesign(), base());
    expect(d?.removed).toEqual([{ label: 'Diseño del chat (vuelve al aspecto original)' }]);
    expect(fields(d).Logo).toEqual(['Imagen (PNG, 64 × 64)', '—']);
  });

  it('cambios campo a campo con sus etiquetas; imágenes por huella', () => {
    const after = withDesign();
    design(after).shape = 'square';
    design(after).sendLabel = 'Mandar';
    design(after).images.avatar = null;
    const png = design(after).images.logo!;
    // Otra imagen PNG de 64 × 64: misma descripción, distinta huella.
    design(after).images.logo = {
      type: 'image/png',
      data: readFileSync(
        join(import.meta.dirname, '..', '..', 'fixtures', 'images', 'animated.png'),
      ).toString('base64'),
    };
    const f = fields(diff(withDesign(), after));
    expect(f.Forma).toEqual(['Suave', 'Recta']);
    expect(f['Botón Enviar']).toEqual(['—', 'Mandar']);
    expect(f.Avatar).toEqual(['Imagen (JPEG, 64 × 64)', '—']);
    expect(f.Logo).toEqual(['Imagen (PNG, 64 × 64)', 'Imagen (PNG, 64 × 64), otra imagen']);
    expect(png.type).toBe('image/png');
  });
});
