/**
 * Tabla de casos del estado de protección (012, data-model §2.1 y §2.2): qué canal puede llamar
 * al modelo o transcribir con cada motivo, el orden de los motivos y los avisos que se calculan.
 */
import { describe, expect, it } from 'vitest';
import {
  canCallModel,
  canTranscribe,
  protectionWarnings,
} from '../../../src/usage/protection.js';
import type {
  ContactOnlyReason,
  ProtectionState,
  SpendCapLevel,
} from '../../../src/usage/types.js';

function state(
  opts: {
    production?: boolean;
    contactOnly?: ContactOnlyReason[];
    level?: SpendCapLevel;
    whatsappReached?: boolean;
    held?: number;
    /** 017: llamadas del mes cuyo consumo el modelo no informó. */
    unmeasured?: number;
  } = {},
): ProtectionState {
  const contactOnly = opts.contactOnly ?? [];
  const unreadable = contactOnly.includes('spend_unreadable');
  return {
    production: opts.production ?? true,
    contactOnly,
    spendCap: unreadable
      ? null
      : {
          level: opts.level ?? 'normal',
          spentPico: 0n,
          capCents: 1000,
          currency: 'USD',
          percent: 0,
        },
    whatsapp: unreadable
      ? null
      : { today: opts.whatsappReached ? 200 : 3, cap: 200, reached: opts.whatsappReached ?? false },
    handoffs: unreadable
      ? null
      : {
          started: 0,
          refused: 0,
          notices: 0,
          held: opts.held ?? 0,
          limits: { dailyMax: 20, forwardIntervalMinutes: 15, noticesDailyMax: 60 },
        },
    unmeasuredCalls: unreadable ? null : (opts.unmeasured ?? 0),
    unpricedModels: {
      llm: contactOnly.includes('model_unpriced') ? 'modelo-x' : null,
      stt: contactOnly.includes('stt_unpriced') ? 'whisper-1' : null,
    },
  };
}

describe('canCallModel y canTranscribe', () => {
  it.each([
    ['sin motivos', state(), { ok: true }, { ok: true }, { ok: true }],
    [
      'tope desactivado en producción',
      state({ contactOnly: ['cap_disabled'] }),
      { ok: false, reason: 'cap_disabled' },
      { ok: false, reason: 'cap_disabled' },
      { ok: false, reason: 'cap_disabled' },
    ],
    [
      'modelo sin precio',
      state({ contactOnly: ['model_unpriced'] }),
      { ok: false, reason: 'model_unpriced' },
      { ok: false, reason: 'model_unpriced' },
      { ok: false, reason: 'model_unpriced' },
    ],
    [
      'modelo de transcripción sin precio: solo los audios',
      state({ contactOnly: ['stt_unpriced'] }),
      { ok: true },
      { ok: true },
      { ok: false, reason: 'stt_unpriced' },
    ],
    [
      'gasto ilegible',
      state({ contactOnly: ['spend_unreadable'] }),
      { ok: false, reason: 'spend_unreadable' },
      { ok: false, reason: 'spend_unreadable' },
      { ok: false, reason: 'spend_unreadable' },
    ],
    [
      'gasto ilegible fuera de producción',
      state({ production: false, contactOnly: ['spend_unreadable'] }),
      { ok: false, reason: 'spend_unreadable' },
      { ok: false, reason: 'spend_unreadable' },
      { ok: false, reason: 'spend_unreadable' },
    ],
    [
      'tope de gasto alcanzado',
      state({ level: 'reached' }),
      { ok: false, reason: 'spend_cap' },
      { ok: false, reason: 'spend_cap' },
      { ok: false, reason: 'spend_cap' },
    ],
    [
      'fuera de producción sin tope ni precio no hay motivos',
      state({ production: false, level: 'none' }),
      { ok: true },
      { ok: true },
      { ok: true },
    ],
    [
      'tope diario de WhatsApp alcanzado: solo WhatsApp',
      state({ whatsappReached: true }),
      { ok: false, reason: 'whatsapp_daily' },
      { ok: true },
      { ok: false, reason: 'whatsapp_daily' },
    ],
  ])('%s', (_name, s, whatsapp, web, audio) => {
    expect(canCallModel(s, 'whatsapp')).toEqual(whatsapp);
    expect(canCallModel(s, 'web')).toEqual(web);
    expect(canTranscribe(s, 'whatsapp')).toEqual(audio);
  });

  it('con varios motivos da el primero del orden del contrato', () => {
    const all = state({
      contactOnly: ['stt_unpriced', 'model_unpriced', 'cap_disabled'],
      level: 'reached',
      whatsappReached: true,
    });
    expect(canCallModel(all, 'whatsapp')).toEqual({ ok: false, reason: 'cap_disabled' });
    expect(canTranscribe(state({ contactOnly: ['stt_unpriced'], level: 'reached' }), 'whatsapp'))
      .toEqual({ ok: false, reason: 'stt_unpriced' });
    expect(canCallModel(state({ level: 'reached', whatsappReached: true }), 'whatsapp')).toEqual({
      ok: false,
      reason: 'spend_cap',
    });
    expect(
      canCallModel(state({ contactOnly: ['model_unpriced', 'spend_unreadable'] }), 'web'),
    ).toEqual({ ok: false, reason: 'spend_unreadable' });
  });
});

describe('protectionWarnings', () => {
  const codes = (s: ProtectionState) => protectionWarnings(s).map((w) => [w.code, w.severity]);

  it('sin motivos, ningún aviso', () => {
    expect(protectionWarnings(state())).toEqual([]);
  });

  it('un crítico por motivo de solo contacto, de la instancia y con el modelo nombrado', () => {
    const s = state({ contactOnly: ['cap_disabled', 'model_unpriced', 'stt_unpriced'] });
    expect(codes(s)).toEqual([
      ['SPEND_CAP_REQUIRED', 'critical'],
      ['MODEL_UNPRICED', 'critical'],
      ['STT_MODEL_UNPRICED', 'critical'],
    ]);
    const warnings = protectionWarnings(s);
    for (const w of warnings) expect(w.target.kind).toBe('instance');
    expect(warnings[1]?.message).toContain('«modelo-x»');
    expect(warnings[2]?.message).toContain('«whisper-1»');
  });

  it('gasto ilegible: crítico', () => {
    expect(codes(state({ contactOnly: ['spend_unreadable'] }))).toEqual([
      ['SPEND_UNREADABLE', 'critical'],
    ]);
  });

  it('avisos retenidos hoy: aviso normal con el número', () => {
    const [w] = protectionWarnings(state({ held: 3 }));
    expect(w).toMatchObject({ code: 'BUSINESS_NOTICES_HELD', severity: 'normal' });
    expect(w?.message).toContain('3 avisos');
  });

  it('el tope alcanzado y el tope de WhatsApp no son avisos de protección (los da la banda de gasto)', () => {
    expect(protectionWarnings(state({ level: 'reached', whatsappReached: true }))).toEqual([]);
  });
});

/**
 * 017 (FR-025a, T061): severidad del aviso de consumo no medido.
 *
 * Es **crítico** solo cuando las dos cosas pasan a la vez: el tope de gasto está activado —y
 * entonces no se puede garantizar— y el negocio está activo —y entonces hay clientes delante—. En
 * cualquier otro caso es un aviso normal: saberlo importa, pero no hay nada que proteger.
 */
describe('aviso de consumo no medido (017, FR-025a)', () => {
  const codeOf = (warnings: ReturnType<typeof protectionWarnings>) =>
    warnings.filter((w) => w.code === 'USAGE_UNMEASURED').map((w) => w.severity);

  it('sin consumo no medido no hay aviso', () => {
    expect(codeOf(protectionWarnings(state(), { businessActive: true }))).toEqual([]);
    expect(codeOf(protectionWarnings(state({ unmeasured: 0 }), { businessActive: true }))).toEqual(
      [],
    );
  });

  it('crítico con el tope activado y el negocio activo', () => {
    const warnings = protectionWarnings(state({ unmeasured: 4, level: 'normal' }), {
      businessActive: true,
    });
    const [w] = warnings.filter((x) => x.code === 'USAGE_UNMEASURED');
    expect(w).toMatchObject({ severity: 'critical', target: { kind: 'instance' } });
    expect(w?.message).toContain('4 respuestas');
    expect(w?.message).toContain('tope');
  });

  const NORMAL_CASES: Array<[string, SpendCapLevel, boolean]> = [
    ['con el negocio inactivo', 'normal', false],
    ['sin tope activado', 'none', true],
    ['sin tope y sin negocio activo', 'none', false],
  ];

  it.each(NORMAL_CASES)('normal %s', (_name, level, businessActive) => {
    expect(codeOf(protectionWarnings(state({ unmeasured: 4, level }), { businessActive }))).toEqual(
      ['normal'],
    );
  });

  it('sin indicar el estado del negocio es normal: nadie afirma que haya clientes delante', () => {
    expect(codeOf(protectionWarnings(state({ unmeasured: 4 })))).toEqual(['normal']);
  });

  it('una sola llamada se nombra en singular', () => {
    const [w] = protectionWarnings(state({ unmeasured: 1 })).filter(
      (x) => x.code === 'USAGE_UNMEASURED',
    );
    expect(w?.message).toContain('1 respuesta del modelo no informó');
  });

  // El gasto ilegible ya degrada por su cuenta; «no se sabe» no puede inventarse un aviso.
  it('con el gasto ilegible no se afirma nada del consumo no medido', () => {
    expect(codeOf(protectionWarnings(state({ contactOnly: ['spend_unreadable'] })))).toEqual([]);
  });

  /**
   * FR-025a: **nunca revierte ninguna escritura del operador.** El aviso nace de una respuesta del
   * bot, no de una escritura, así que no entra en `computeWarnings` —que es lo que la regla de
   * revertir mira— y quien activa el negocio pasa `businessActive: false`, con lo que el aviso que
   * ve esa comprobación nunca es crítico.
   */
  it('no es crítico en el camino que decide si el negocio se puede activar', () => {
    const s = state({ unmeasured: 99, level: 'reached' });
    const seenByActivation = protectionWarnings(s, { businessActive: false });
    expect(seenByActivation.filter((w) => w.severity === 'critical').map((w) => w.code)).not.toContain(
      'USAGE_UNMEASURED',
    );
  });
});
