import { describe, expect, it } from 'vitest';
import { replyTraceSchema, type ReplyTrace } from '../../../src/conversation/types.js';

const base: ReplyTrace = {
  template: null,
  greeting: true,
  contact: { added: true, reason: 'handoff_requested' },
  groundingRejections: 1,
  modelMs: 3200,
  latencyMs: 6100,
};

describe('replyTraceSchema (data-model.md)', () => {
  it.each<[string, ReplyTrace]>([
    ['redactada por el modelo con contacto', base],
    ['sin contacto', { ...base, contact: { added: false, reason: null } }],
    ['plantilla sin modelo', { ...base, template: 'R-UNAVAILABLE', modelMs: null, contact: { added: true, reason: 'template' } }],
    ['R-SAFE tras dos rechazos', { ...base, template: 'R-SAFE', groundingRejections: 2, contact: { added: true, reason: 'template' } }],
  ])('acepta %s', (_name, trace) => {
    expect(replyTraceSchema.parse(trace)).toEqual(trace);
  });

  it('rechaza un motivo de contacto sin contacto', () => {
    const trace = { ...base, contact: { added: false, reason: 'offer_contact' } };
    expect(replyTraceSchema.safeParse(trace).success).toBe(false);
  });

  it.each([-1, 3, 1.5])('rechaza groundingRejections = %s', (n) => {
    expect(replyTraceSchema.safeParse({ ...base, groundingRejections: n }).success).toBe(false);
  });

  it('rechaza una plantilla desconocida', () => {
    expect(replyTraceSchema.safeParse({ ...base, template: 'R-OTRA' }).success).toBe(false);
  });
});
