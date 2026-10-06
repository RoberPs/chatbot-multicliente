/**
 * Validación de la configuración del chat web (004 US2, data-model.md, research R8): orígenes
 * permitidos, enlace de privacidad, topes y las dos condiciones para poder activarlo (FR-015).
 */
import { describe, expect, it } from 'vitest';
import { webChatSettingsSchema } from '../../../src/webchat/schemas.js';

/** Formulario válido mínimo con el chat activado. */
const form = (over: Record<string, unknown> = {}) => ({
  enabled: 'on',
  allowed_origins: 'https://negocio.example',
  privacy_url: 'https://negocio.example/privacidad',
  daily_cap: '200',
  monthly_cap: '3000',
  ...over,
});

/** Errores por campo del esquema, con la ruta tal como se llama en el formulario. */
function errors(input: unknown): Record<string, string> {
  const result = webChatSettingsSchema.safeParse(input);
  if (result.success) throw new Error('Se esperaba un error de validación');
  const out: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_form';
    out[key] ??= issue.message;
  }
  return out;
}

const parsed = (input: unknown) => webChatSettingsSchema.parse(input);

describe('webChatSettingsSchema', () => {
  it('normaliza los orígenes a minúsculas, sin barra ni ruta, y quita las líneas vacías', () => {
    expect(
      parsed(
        form({
          allowed_origins: '  HTTPS://Negocio.Example/  \n\n https://otra.example:8443 \n',
        }),
      ).allowedOrigins,
    ).toEqual(['https://negocio.example', 'https://otra.example:8443']);
  });

  it('acepta http solo en localhost y 127.0.0.1', () => {
    expect(
      parsed(form({ allowed_origins: 'http://localhost:8080\nhttp://127.0.0.1:3000' }))
        .allowedOrigins,
    ).toEqual(['http://localhost:8080', 'http://127.0.0.1:3000']);
    expect(errors(form({ allowed_origins: 'http://negocio.example' }))).toEqual({
      allowed_origins: 'Línea 1: la web debe usar https',
    });
  });

  it('rechaza el origen con ruta y el que no es una dirección, indicando la línea', () => {
    expect(errors(form({ allowed_origins: 'https://negocio.example/tienda' }))).toEqual({
      allowed_origins: 'Línea 1: indica solo la dirección de la web, sin ruta ni parámetros',
    });
    expect(
      errors(form({ allowed_origins: 'https://negocio.example\nno-es-una-web' })).allowed_origins,
    ).toBe('Línea 2: no es una dirección de web válida');
  });

  it('rechaza el origen repetido tras normalizar mayúsculas y barra final', () => {
    expect(
      errors(form({ allowed_origins: 'https://negocio.example\nHTTPS://Negocio.example/' }))
        .allowed_origins,
    ).toBe('Línea 2: esa web está repetida');
  });

  it('rechaza más de 10 webs', () => {
    const many = Array.from({ length: 11 }, (_, i) => `https://w${i}.example`).join('\n');
    expect(errors(form({ allowed_origins: many })).allowed_origins).toBe(
      'Indica como máximo 10 webs',
    );
  });

  it('el enlace de privacidad tiene que ser https', () => {
    expect(errors(form({ privacy_url: 'http://negocio.example/privacidad' })).privacy_url).toBe(
      'El enlace a la política de privacidad debe empezar por https://',
    );
    expect(errors(form({ privacy_url: 'negocio.example/privacidad' })).privacy_url).toBe(
      'El enlace a la política de privacidad debe empezar por https://',
    );
  });

  it('los topes son enteros de al menos 1 y el mensual no puede ser menor que el diario', () => {
    expect(errors(form({ daily_cap: '0' })).daily_cap).toBe(
      'Indica un número entero de 1 o más respuestas',
    );
    expect(errors(form({ daily_cap: '1,5' })).daily_cap).toBe(
      'Indica un número entero de 1 o más respuestas',
    );
    expect(errors(form({ daily_cap: '200', monthly_cap: '100' })).monthly_cap).toBe(
      'El tope mensual no puede ser menor que el diario',
    );
    // Iguales sí se permite.
    expect(parsed(form({ daily_cap: '200', monthly_cap: '200' })).monthlyCap).toBe(200);
  });

  it('activar sin webs o sin enlace da un error por campo con el mensaje del panel (FR-015)', () => {
    expect(errors(form({ allowed_origins: '   ', privacy_url: '' }))).toEqual({
      allowed_origins: 'Indica al menos una web donde se mostrará el chat',
      privacy_url: 'Indica el enlace a la política de privacidad del negocio',
    });
  });

  it('desactivar siempre es válido y conserva los valores que haya', () => {
    const off = parsed(
      form({ enabled: undefined, allowed_origins: 'https://negocio.example', monthly_cap: '500' }),
    );
    expect(off).toEqual({
      enabled: false,
      allowedOrigins: ['https://negocio.example'],
      privacyUrl: 'https://negocio.example/privacidad',
      dailyCap: 200,
      monthlyCap: 500,
    });
    // Desactivado y sin nada registrado: también vale (estado inicial, FR-014).
    expect(
      parsed({ allowed_origins: '', privacy_url: '', daily_cap: '200', monthly_cap: '3000' }),
    ).toEqual({
      enabled: false,
      allowedOrigins: [],
      privacyUrl: null,
      dailyCap: 200,
      monthlyCap: 3000,
    });
  });
});
