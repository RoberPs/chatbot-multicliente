/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- JSON crudo del fichero de ejemplo, manipulado a propósito */
/**
 * Esquema de la versión 1 del fichero (008, contracts/config-file-format.md): ficheros válidos,
 * objetos estrictos y una prueba por regla, con el mensaje del panel cuando la regla es la misma.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportIssue } from '../../../src/config-transfer/format.js';
import { validateConfigFile } from '../../../src/config-transfer/parse.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'config');

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const load = (name: string): Json =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Json;

/** `valid-full.json` con un cambio. */
function variant(change: (file: Json) => void, name = 'valid-full.json'): Json {
  const file = load(name);
  change(file);
  return file;
}

function issuesOf(file: Json): ImportIssue[] {
  const result = validateConfigFile(file, 'ES');
  return result.ok ? [] : result.issues;
}

/** Espera exactamente un error con estos campos. */
function expectIssue(file: Json, expected: Partial<Record<keyof ImportIssue, unknown>>): void {
  const issues = issuesOf(file);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject(expected);
}

describe('ficheros válidos', () => {
  it('valid-full.json devuelve el documento en la forma del dominio', () => {
    const result = validateConfigFile(load('valid-full.json'), 'ES');
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.envelope).toEqual({
      format: 'business-config',
      formatVersion: 2,
      exportedAt: '2026-09-30T10:15:00.000Z',
      source: { instanceId: 'demo-01', schema: '0005_config_transfer' },
      includesAlertDestinations: false,
      info: { businessStatus: 'active', webChatEnabled: true },
    });
    expect(result.document.services.map((s) => s.name)).toEqual(['Servicio A', 'Servicio B']);
    expect(result.document.resources[0]?.services).toEqual(['Servicio A']);
    expect(result.document.alertDestinations).toBeUndefined();
    expect(result.document.webChat.allowedOrigins).toEqual(['https://www.example.com']);
  });

  it('valid-full-with-alerts.json trae los destinos', () => {
    const result = validateConfigFile(load('valid-full-with-alerts.json'), 'ES');
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.document.alertDestinations).toEqual({
      whatsapp: '+34600123456',
      email: 'avisos@example.com',
    });
  });

  it('valid-empty.json (instancia recién migrada) se acepta', () => {
    const result = validateConfigFile(load('valid-empty.json'), 'ES');
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.document).toMatchObject({
      business: { name: '' },
      services: [],
      policies: null,
      tone: null,
      handoff: null,
    });
  });

  it('normaliza como el panel: email en minúsculas, orígenes y teléfonos', () => {
    const result = validateConfigFile(
      variant((f) => {
        f.business.email = 'Hola@Example.COM';
        f.business.phone = '910 123 456';
        f.webChat.allowedOrigins = ['HTTPS://WWW.Example.com'];
      }),
      'ES',
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.document.business.email).toBe('hola@example.com');
    expect(result.document.business.phone).toBe('+34910123456');
    expect(result.document.webChat.allowedOrigins).toEqual(['https://www.example.com']);
  });
});

describe('objetos estrictos (FR-010)', () => {
  it.each([
    ['sobre', (f: Json) => (f.extra = 1), { section: 'file', field: 'extra' }],
    ['source', (f: Json) => (f.source.extra = 1), { section: 'file', field: 'source.extra' }],
    ['info', (f: Json) => (f.info.extra = 1), { section: 'file', field: 'info.extra' }],
    ['business', (f: Json) => (f.business.extra = 1), { section: 'business', field: 'extra' }],
    [
      'un servicio',
      (f: Json) => (f.services[1].extra = 1),
      { section: 'services', item: '«Servicio B»', field: 'extra' },
    ],
    [
      'una franja de un recurso',
      (f: Json) => (f.resources[0].hours[0].extra = 1),
      { section: 'resources', item: '«Recurso 1»', field: 'hours[0].extra' },
    ],
    ['policies', (f: Json) => (f.policies.extra = 1), { section: 'policies', field: 'extra' }],
    ['webChat', (f: Json) => (f.webChat.extra = 1), { section: 'webChat', field: 'extra' }],
  ])('una clave desconocida en %s es un error con su ruta', (_name, change, expected) => {
    expectIssue(variant(change), { ...expected, message: 'Campo desconocido' });
  });

  it('una clave que falta es un error, aunque admita null', () => {
    expectIssue(
      variant((f) => delete f.business.address),
      { section: 'business', field: 'address', message: 'Falta este campo' },
    );
    expectIssue(
      variant((f) => delete f.policies),
      { section: 'policies', field: null, message: 'Falta este campo' },
    );
  });

  it('includesAlertDestinations ⇔ alertDestinations', () => {
    expectIssue(
      variant((f) => (f.includesAlertDestinations = true)),
      { section: 'alertDestinations' },
    );
    expectIssue(
      variant((f) => (f.includesAlertDestinations = false), 'valid-full-with-alerts.json'),
      { section: 'file', field: 'includesAlertDestinations' },
    );
  });

  it('info.businessStatus solo draft o active', () => {
    expectIssue(
      variant((f) => (f.info.businessStatus = 'paused')),
      { section: 'file', field: 'info.businessStatus' },
    );
  });
});

describe('reglas de cada sección (una prueba por regla)', () => {
  const max = (n: number) => 'x'.repeat(n + 1);
  /** Etiqueta de un elemento con un nombre demasiado largo: recortada a 60 caracteres. */
  const long = `«${'x'.repeat(60)}…»`;

  it.each([
    ['business.name', (f: Json) => (f.business.name = max(200)), 'business', null, 'name', 'Máximo 200 caracteres'],
    ['business.address', (f: Json) => (f.business.address = max(500)), 'business', null, 'address', 'Máximo 500 caracteres'],
    ['business.directions', (f: Json) => (f.business.directions = max(2000)), 'business', null, 'directions', 'Máximo 2000 caracteres'],
    ['services[].name', (f: Json) => (f.services[1].name = max(200)), 'services', long, 'name', 'Máximo 200 caracteres'],
    ['services[].description', (f: Json) => (f.services[0].description = max(4000)), 'services', '«Servicio A»', 'description', 'Máximo 4000 caracteres'],
    ['resources[].name', (f: Json) => (f.resources[0].name = max(200)), 'resources', long, 'name', 'Máximo 200 caracteres'],
    ['faqs[].question', (f: Json) => (f.faqs[0].question = max(500)), 'faqs', long, 'question', 'Máximo 500 caracteres'],
    ['faqs[].answer', (f: Json) => (f.faqs[0].answer = max(4000)), 'faqs', '«¿Hay aparcamiento?»', 'answer', 'Máximo 4000 caracteres'],
    ['closures[].reason', (f: Json) => (f.closures[0].reason = max(200)), 'closures', 'n.º 1', 'reason', 'Máximo 200 caracteres'],
    ['policies.cancellationText', (f: Json) => (f.policies.cancellationText = max(4000)), 'policies', null, 'cancellationText', 'Máximo 4000 caracteres'],
    ['policies.paymentMethods[]', (f: Json) => (f.policies.paymentMethods = [max(100)]), 'policies', null, 'paymentMethods[0]', 'Máximo 100 caracteres'],
    ['tone.styleDescription', (f: Json) => (f.tone.styleDescription = max(2000)), 'tone', null, 'styleDescription', 'Máximo 2000 caracteres'],
  ])('límite de longitud de %s', (_name, change, section, item, field, message) => {
    expectIssue(variant(change), { section: section, item, field, message });
  });

  it('enlaces: mapUrl no https y privacyUrl no https', () => {
    expectIssue(variant((f) => (f.business.mapUrl = 'http://maps.example.com/abc')), {
      section: 'business',
      field: 'mapUrl',
      message: 'Usa el enlace seguro, que empieza por https://',
    });
    expectIssue(variant((f) => (f.webChat.privacyUrl = 'http://www.example.com/privacidad')), {
      section: 'webChat',
      field: 'privacyUrl',
      message: 'El enlace a la política de privacidad debe empezar por https://',
    });
  });

  it('teléfono y email no válidos', () => {
    expectIssue(variant((f) => (f.business.phone = '123')), {
      section: 'business',
      field: 'phone',
      message: 'Teléfono no válido',
    });
    expectIssue(variant((f) => (f.business.email = 'no-es-un-email')), {
      section: 'business',
      field: 'email',
      message: 'Email no válido',
    });
  });

  it('zona horaria y moneda no válidas', () => {
    expectIssue(variant((f) => (f.business.timezone = 'Europa/Ninguna')), {
      field: 'timezone',
      message: 'Zona horaria no válida',
    });
    expectIssue(variant((f) => (f.business.currency = 'EURO')), {
      field: 'currency',
      message: 'Moneda no válida (código ISO de 3 letras)',
    });
  });

  it('franjas: weekday fuera de 1–7, fin ≤ inicio y solapes el mismo día', () => {
    expectIssue(variant((f) => (f.openingHours[0].weekday = 8)), {
      section: 'openingHours',
      item: 'n.º 1',
      field: 'weekday',
      message: 'Día no válido',
    });
    expectIssue(variant((f) => (f.openingHours[0].weekday = '1')), {
      field: 'weekday',
      message: 'Día no válido',
    });
    expectIssue(variant((f) => (f.openingHours[0].end = '08:00')), {
      section: 'openingHours',
      item: 'n.º 1',
      field: 'end',
      message: 'La hora de fin debe ser posterior a la de inicio',
    });
    expectIssue(variant((f) => (f.handoff.hours = [f.handoff.hours[0], { weekday: 1, start: '13:00', end: '15:00' }])), {
      section: 'handoff',
      field: 'hours[1]',
      message: 'La franja se solapa con otra del mismo día',
    });
  });

  it('bloques de fechas: fecha imposible, fin < inicio y una sola hora', () => {
    expectIssue(variant((f) => (f.closures[1].startDate = '2026-02-30')), {
      section: 'closures',
      item: 'n.º 2',
      field: 'startDate',
      message: 'Fecha no válida',
    });
    expectIssue(variant((f) => (f.closures[1].endDate = '2026-12-01')), {
      field: 'endDate',
      message: 'La fecha de fin no puede ser anterior a la de inicio',
    });
    expectIssue(variant((f) => (f.closures[0].endTime = null)), {
      field: 'endTime',
      message: 'Indica la hora de inicio y la de fin, o ninguna para el día completo',
    });
    expectIssue(variant((f) => (f.resources[0].absences[0].startTime = '10:00')), {
      section: 'resources',
      item: '«Recurso 1»',
      field: 'absences[0].endTime',
      message: 'Indica la hora de inicio y la de fin, o ninguna para el día completo',
    });
  });

  it('nombres de servicio y de recurso repetidos sin distinguir mayúsculas', () => {
    expectIssue(variant((f) => (f.services[1].name = ' servicio  a ')), {
      section: 'services',
      item: '«servicio  a»',
      field: 'name',
      message: 'Ya existe un servicio con ese nombre',
    });
    expectIssue(
      variant((f) => f.resources.push({ ...f.resources[0], name: 'RECURSO 1' })),
      { section: 'resources', item: '«RECURSO 1»', field: 'name', message: 'Ya existe un recurso con ese nombre' },
    );
  });

  it('resources[].services[] inexistente o repetido', () => {
    expectIssue(variant((f) => (f.resources[0].services = ['Servicio Z'])), {
      section: 'resources',
      item: '«Recurso 1»',
      field: 'services[0]',
      message: 'El servicio «Servicio Z» no está en el fichero',
    });
    expectIssue(variant((f) => (f.resources[0].services = ['Servicio A', 'servicio a'])), {
      field: 'services[1]',
      message: 'Hay servicios repetidos',
    });
  });

  it('pregunta o respuesta vacías', () => {
    expectIssue(variant((f) => (f.faqs[0].question = '  ')), {
      section: 'faqs',
      item: 'n.º 1',
      field: 'question',
      message: 'Este campo es obligatorio',
    });
    expectIssue(variant((f) => (f.faqs[1].answer = '')), {
      item: '«¿Se puede pagar con tarjeta?»',
      field: 'answer',
      message: 'Este campo es obligatorio',
    });
  });

  it('priceCents negativo, decimal o no null con on_request (◆)', () => {
    const message = 'El importe debe ser un número entero de céntimos, 0 o más';
    expectIssue(variant((f) => (f.services[0].priceCents = -1)), { item: '«Servicio A»', field: 'priceCents', message });
    expectIssue(variant((f) => (f.services[0].priceCents = 25.5)), { field: 'priceCents', message });
    expectIssue(variant((f) => (f.services[0].priceType = 'on_request')), {
      field: 'priceCents',
      message: 'Con precio «a consultar» el importe debe ser null',
    });
    expect(
      issuesOf(variant((f) => Object.assign(f.services[0], { priceType: 'on_request', priceCents: null }))),
    ).toEqual([]);
  });

  it('durationMinutes 0 y 1441', () => {
    const message = 'La duración debe ser un número entero de minutos entre 1 y 1440';
    expectIssue(variant((f) => (f.services[0].durationMinutes = 0)), { field: 'durationMinutes', message });
    expectIssue(variant((f) => (f.services[0].durationMinutes = 1441)), { field: 'durationMinutes', message });
  });

  it('políticas: minutos negativos, máxima 0 y mínima > máxima', () => {
    expectIssue(variant((f) => (f.policies.cancellationNoticeMinutes = -5)), {
      section: 'policies',
      field: 'cancellationNoticeMinutes',
      message: 'Indica un número entero mayor o igual que 0',
    });
    expectIssue(variant((f) => (f.policies.minAdvanceMinutes = -1)), {
      field: 'minAdvanceMinutes',
      message: 'Indica un número entero mayor o igual que 0',
    });
    expectIssue(variant((f) => (f.policies.maxAdvanceMinutes = 0)), {
      field: 'maxAdvanceMinutes',
      message: 'Indica un número entero mayor que 0',
    });
    expectIssue(variant((f) => (f.policies.minAdvanceMinutes = 50000)), {
      field: 'minAdvanceMinutes',
      message: 'La antelación mínima no puede ser mayor que la máxima',
    });
  });

  it('forma de pago repetida (◆: el panel la descarta, el fichero la rechaza)', () => {
    expectIssue(variant((f) => (f.policies.paymentMethods = ['Efectivo', 'efectivo'])), {
      section: 'policies',
      field: 'paymentMethods[1]',
      message: 'Forma de pago repetida',
    });
  });

  it('medio de derivación repetido y valor que no corresponde a su tipo', () => {
    expectIssue(
      variant((f) => f.handoff.channels.push({ type: 'phone', value: '910 123 456' })),
      { section: 'handoff', field: 'channels[2].value', message: 'Este medio está repetido' },
    );
    expectIssue(variant((f) => (f.handoff.channels[1].value = 'no-es-email')), {
      field: 'channels[1].value',
      message: 'Email no válido',
    });
  });

  it('webs: más de 10, con ruta, http fuera de localhost y repetidas', () => {
    expectIssue(
      variant((f) => (f.webChat.allowedOrigins = Array.from({ length: 11 }, (_, i) => `https://w${i}.example.com`))),
      { section: 'webChat', field: 'allowedOrigins', message: 'Indica como máximo 10 webs' },
    );
    expectIssue(variant((f) => (f.webChat.allowedOrigins = ['https://www.example.com/tienda'])), {
      field: 'allowedOrigins[0]',
      message: 'Indica solo la dirección de la web, sin ruta ni parámetros',
    });
    expectIssue(variant((f) => (f.webChat.allowedOrigins = ['http://www.example.com'])), {
      field: 'allowedOrigins[0]',
      message: 'La web debe usar https',
    });
    expect(issuesOf(variant((f) => (f.webChat.allowedOrigins = ['http://localhost:5173'])))).toEqual([]);
    expectIssue(
      variant((f) => (f.webChat.allowedOrigins = ['https://www.example.com', 'https://WWW.example.com'])),
      { field: 'allowedOrigins[1]', message: 'Esa web está repetida' },
    );
  });

  it('topes: menores que 1 y mensual < diario', () => {
    expectIssue(variant((f) => (f.webChat.dailyCap = 0)), {
      field: 'dailyCap',
      message: 'Indica un número entero de 1 o más respuestas',
    });
    expectIssue(variant((f) => (f.webChat.monthlyCap = 100)), {
      field: 'monthlyCap',
      message: 'El tope mensual no puede ser menor que el diario',
    });
  });

  it('destinos de avisos no válidos', () => {
    expectIssue(
      variant((f) => (f.alertDestinations.whatsapp = '12'), 'valid-full-with-alerts.json'),
      {
        section: 'alertDestinations',
        field: 'whatsapp',
        message: 'Indica un teléfono válido, con prefijo si no es de España',
      },
    );
    expectIssue(
      variant((f) => (f.alertDestinations.email = 'x'), 'valid-full-with-alerts.json'),
      { section: 'alertDestinations', field: 'email', message: 'Indica un email válido' },
    );
  });

  it('contacto de derivación sin medios: usar null', () => {
    expectIssue(variant((f) => (f.handoff.channels = [])), {
      section: 'handoff',
      field: 'channels',
      message: 'Indica al menos un medio de contacto, o deja la sección en null',
    });
  });

  it('◆ business.name vacío se acepta', () => {
    expect(issuesOf(variant((f) => (f.business.name = '')))).toEqual([]);
  });
});

describe('sección chatDesign (011, contracts/config-file-chat-design.md)', () => {
  const withDesign = (change: (design: Json) => void = () => undefined): Json => {
    const file = load('v2-chat-design.json');
    change(file.chatDesign as Json);
    return file;
  };
  const png = () => readFileSync(join(FIXTURES, '..', 'images', 'valid.png')).toString('base64');

  it('el fichero de ejemplo con diseño es válido y null también', () => {
    expect(issuesOf(withDesign())).toEqual([]);
    expect(issuesOf(variant((f) => (f.chatDesign = null)))).toEqual([]);
  });

  it('chatDesign es obligatorio (objeto o null)', () => {
    expectIssue(
      variant((f) => {
        delete f.chatDesign;
      }),
      { section: 'chatDesign', sectionLabel: 'Diseño del chat', field: null, message: 'Falta este campo' },
    );
  });

  it('objetos estrictos: una clave desconocida es un error', () => {
    expectIssue(withDesign((d) => (d.privacyNotice = '')), {
      section: 'chatDesign',
      field: 'privacyNotice',
      message: 'Campo desconocido',
    });
    expectIssue(withDesign((d) => (d.images.banner = null)), {
      section: 'chatDesign',
      field: 'images.banner',
    });
    expectIssue(withDesign((d) => (d.images.logo.name = 'logo.png')), {
      field: 'images.logo.name',
    });
  });

  it('las cuatro claves de images son obligatorias', () => {
    expectIssue(
      withDesign((d) => {
        delete d.images.icon;
      }),
      { field: 'images.icon', message: 'Falta este campo' },
    );
  });

  it('devuelve todos los errores a la vez, con la sección y el campo', () => {
    const issues = issuesOf(
      withDesign((d) => {
        d.textColor = '#aaaaaa';
        d.images.icon = { type: 'image/png', data: d.images.icon.data as string };
        d.images.avatar = { type: 'image/jpeg', data: 'no es base64!' };
        d.images.logo = { type: 'image/png', data: Buffer.alloc(300 * 1024, 1).toString('base64') };
        d.size = 'huge';
        d.welcomeText = 'x'.repeat(300);
      }),
    );
    const byField: Record<string, string> = Object.fromEntries(
      issues.map((i): [string, string] => [i.field ?? '', i.message]),
    );
    expect(issues.every((i) => i.section === 'chatDesign' && i.sectionLabel === 'Diseño del chat')).toBe(true);
    expect(byField).toEqual({
      textColor: expect.stringMatching(
        /^El texto (del chat )?sobre (el fondo|los mensajes del bot) tiene un contraste de \d,\d{2}:1; el mínimo es 4,5:1/,
      ) as unknown,
      size: 'Valor no válido; se admite: "small", "medium", "large"',
      welcomeText: 'Máximo 280 caracteres',
      'images.logo.data': 'La imagen supera el máximo de 256 KB',
      'images.avatar.data': 'La imagen no está en base64',
      'images.icon.type': 'El tipo declarado no coincide con el contenido de la imagen',
    });
  });

  it('una imagen que no es PNG, JPEG ni WebP se rechaza en su campo', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    expectIssue(withDesign((d) => (d.images.logo = { type: 'image/png', data: svg })), {
      field: 'images.logo.data',
      message: 'Formato no admitido: solo PNG, JPEG o WebP',
    });
    expectIssue(withDesign((d) => (d.images.logo = { type: 'image/svg+xml', data: png() })), {
      field: 'images.logo.type',
    });
  });

  it('los colores se normalizan a minúsculas', () => {
    const result = validateConfigFile(withDesign((d) => (d.primaryColor = '#0B6E4F')), 'ES');
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.document.chatDesign?.primaryColor).toBe('#0b6e4f');
  });
});
