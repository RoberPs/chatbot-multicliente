/** Avisos de las vías de aviso de derivación (005, R16, contracts/admin-and-web.md). */
import { describe, expect, it } from 'vitest';
import type { KnowledgeState } from '../../../src/knowledge/types.js';
import { computeWarnings } from '../../../src/knowledge/warnings.js';
import { emptyState } from '../../helpers/state.js';

const ALL = { whatsapp: true, email: true };

function alertWarnings(handoffAlerts: KnowledgeState['handoffAlerts']) {
  return computeWarnings(emptyState({ handoffAlerts })).filter(
    (w) => w.target.kind === 'handoff_alerts',
  );
}

describe('avisos de las vías de aviso de derivación', () => {
  it('sin destinos → HANDOFF_ALERTS_NONE, normal y con enlace a la página', () => {
    const [warning, ...rest] = alertWarnings({ whatsapp: null, email: null, routes: ALL });
    expect(rest).toEqual([]);
    expect(warning).toEqual({
      code: 'HANDOFF_ALERTS_NONE',
      severity: 'normal',
      target: { kind: 'handoff_alerts', label: 'Avisos al negocio' },
      field: 'alerts',
      message:
        'No hay ninguna vía para avisar al negocio de las derivaciones; el bot dará el contacto de derivación.',
    });
  });

  it('destinos configurados pero la instancia no puede enviar → cuentan como no disponibles', () => {
    const codes = alertWarnings({
      whatsapp: '+34611000111',
      email: 'avisos@ejemplo.com',
      routes: { whatsapp: false, email: false },
    }).map((w) => w.code);
    expect(codes).toEqual(['HANDOFF_ALERTS_NONE']);
  });

  it('solo WhatsApp → HANDOFF_ALERTS_SINGLE que nombra el email', () => {
    const [warning] = alertWarnings({ whatsapp: '+34611000111', email: null, routes: ALL });
    expect(warning).toMatchObject({
      code: 'HANDOFF_ALERTS_SINGLE',
      severity: 'normal',
      field: 'email',
    });
    expect(warning?.message).toBe(
      'Los avisos de derivación solo llegan por WhatsApp; configura también el email para que quede registro en las dos.',
    );
  });

  it('solo email (el WhatsApp configurado no se puede usar) → SINGLE que nombra el WhatsApp', () => {
    const [warning] = alertWarnings({
      whatsapp: '+34611000111',
      email: 'avisos@ejemplo.com',
      routes: { whatsapp: false, email: true },
    });
    expect(warning?.code).toBe('HANDOFF_ALERTS_SINGLE');
    expect(warning?.message).toBe(
      'Los avisos de derivación solo llegan por email; configura también el WhatsApp para que quede registro en las dos.',
    );
  });

  it('las dos vías → ningún aviso', () => {
    expect(
      alertWarnings({ whatsapp: '+34611000111', email: 'avisos@ejemplo.com', routes: ALL }),
    ).toEqual([]);
  });

  it('ninguno es crítico: no bloquean activar el negocio', () => {
    for (const state of [
      { whatsapp: null, email: null, routes: ALL },
      { whatsapp: '+34611000111', email: null, routes: ALL },
    ]) {
      expect(alertWarnings(state).every((w) => w.severity === 'normal')).toBe(true);
    }
  });
});
