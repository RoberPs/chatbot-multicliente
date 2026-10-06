import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../../../src/knowledge/snapshot.js';
import { emptyState, resource, service, slot } from '../../helpers/state.js';

describe('snapshot: recursos y agenda (US3)', () => {
  it('sin recursos → agenda única', () => {
    expect(buildSnapshot(emptyState()).scheduling).toEqual({ mode: 'single_agenda' });
  });

  it('con recursos → modo resources y solo servicios activos asignados', () => {
    const a = service({ name: 'A' });
    const b = service({ name: 'B', active: false });
    const r = resource({
      name: 'Profesional 1',
      serviceIds: [a.id, b.id],
      hours: [slot(1, '09:00', '14:00')],
    });
    const snap = buildSnapshot(emptyState({ services: [a, b], resources: [r] }));
    expect(snap.scheduling).toEqual({
      mode: 'resources',
      resources: [
        {
          id: r.id,
          name: 'Profesional 1',
          serviceIds: [a.id],
          hours: [slot(1, '09:00', '14:00')],
          absences: [],
        },
      ],
    });
    expect(snap.services[0]).toMatchObject({ name: 'A', bookable: true, resourceIds: [r.id] });
  });

  it('recurso inactivo excluido y no cuenta para resourceIds', () => {
    const a = service({ name: 'A' });
    const r1 = resource({ name: 'R1', serviceIds: [a.id] });
    const r2 = resource({ name: 'R2', serviceIds: [a.id], active: false });
    const snap = buildSnapshot(emptyState({ services: [a], resources: [r1, r2] }));
    expect(
      snap.scheduling.mode === 'resources' && snap.scheduling.resources.map((r) => r.name),
    ).toEqual(['R1']);
    expect(snap.services[0]?.resourceIds).toEqual([r1.id]);
  });

  it('todos los recursos inactivos → sigue en modo resources con lista vacía y nada reservable', () => {
    const a = service({ name: 'A' });
    const r = resource({ serviceIds: [a.id], active: false });
    const snap = buildSnapshot(emptyState({ services: [a], resources: [r] }));
    expect(snap.scheduling).toEqual({ mode: 'resources', resources: [] });
    expect(snap.services[0]).toMatchObject({ bookable: false, resourceIds: [] });
  });

  it('servicio reservable que no presta ningún recurso activo no es reservable', () => {
    const a = service({ name: 'A' });
    const c = service({ name: 'C' });
    const r = resource({ serviceIds: [a.id] });
    const snap = buildSnapshot(emptyState({ services: [a, c], resources: [r] }));
    expect(snap.services.map((s) => [s.name, s.bookable])).toEqual([
      ['A', true],
      ['C', false],
    ]);
  });

  it('las ausencias del recurso aparecen sin motivo', () => {
    const r = resource({
      absences: [
        {
          id: 'x',
          startDate: '2026-08-01',
          endDate: '2026-08-07',
          startTime: null,
          endTime: null,
          reason: null,
          updatedAt: 'x',
        },
      ],
    });
    const snap = buildSnapshot(emptyState({ resources: [r] }));
    expect(snap.scheduling.mode === 'resources' && snap.scheduling.resources[0]?.absences).toEqual([
      {
        startDate: '2026-08-01',
        endDate: '2026-08-07',
        startTime: null,
        endTime: null,
        reason: null,
      },
    ]);
  });
});
