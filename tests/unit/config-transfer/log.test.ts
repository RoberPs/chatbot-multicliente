/** Catálogo de registros de exportación e importación (008, contracts/transfer-log.md). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SectionDiff } from '../../../src/config-transfer/format.js';
import {
  changesOf,
  configExported,
  configImportApplied,
  configImportCancelled,
  configImportPreviewed,
  configImportRejected,
  countsOf,
  type ConfigLogger,
} from '../../../src/config-transfer/log.js';
import { validateConfigFile } from '../../../src/config-transfer/parse.js';

function capture() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
  const logger: ConfigLogger = {
    info: (obj, msg) => lines.push({ level: 'info', obj: obj as Record<string, unknown>, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj: obj as Record<string, unknown>, msg }),
  };
  return { logger, lines };
}

const file = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'config', 'valid-full-with-alerts.json'), 'utf8'),
) as unknown;
const parsed = validateConfigFile(file, 'ES');
if (!parsed.ok) throw new Error('fixture no válido');
const doc = parsed.document;
const counts = countsOf(doc);

const diff: SectionDiff[] = [
  {
    section: 'services',
    sectionLabel: 'Servicios',
    added: [{ label: 'Servicio C' }],
    modified: [{ label: 'Servicio A', fields: [] }],
    removed: [],
    reordered: false,
  },
];
const changes = changesOf(diff);

const onlyNumbers = (value: unknown): boolean =>
  typeof value === 'number' ||
  (typeof value === 'object' && value !== null && Object.values(value).every(onlyNumbers));

describe('countsOf y changesOf', () => {
  it('solo devuelven números por sección', () => {
    expect(counts).toEqual({
      business: 1,
      openingHours: 4,
      closures: 2,
      services: 2,
      resources: 1,
      faqs: 2,
      policies: 1,
      tone: 1,
      handoff: 1,
      webChat: 1,
      chatDesign: 0,
      alertDestinations: 1,
    });
    expect(changes.services).toEqual({ added: 1, modified: 1, removed: 0 });
    expect(changes.faqs).toEqual({ added: 0, modified: 0, removed: 0 });
    expect(onlyNumbers(counts)).toBe(true);
    expect(onlyNumbers(changes)).toBe(true);
  });
});

describe('eventos del catálogo', () => {
  it('config_exported', () => {
    const { logger, lines } = capture();
    configExported(logger, { includesAlerts: true, counts });
    expect(lines).toEqual([
      {
        level: 'info',
        msg: 'config_exported',
        obj: { channel: 'config', event: 'config_exported', includesAlerts: true, counts },
      },
    ]);
  });

  it('config_import_previewed', () => {
    const { logger, lines } = capture();
    configImportPreviewed(logger, {
      sourceInstance: 'demo-01',
      formatVersion: 1,
      sameInstance: null,
      counts,
      changes,
      outcome: 'blocked_critical',
    });
    expect(lines[0]).toEqual({
      level: 'info',
      msg: 'config_import_previewed',
      obj: {
        channel: 'config',
        event: 'config_import_previewed',
        sourceInstance: 'demo-01',
        formatVersion: 1,
        sameInstance: null,
        counts,
        changes,
        outcome: 'blocked_critical',
      },
    });
  });

  it('config_import_applied', () => {
    const { logger, lines } = capture();
    configImportApplied(logger, {
      sourceInstance: null,
      formatVersion: 1,
      includesAlerts: false,
      changes,
      criticalWarnings: 0,
      warnings: 2,
    });
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'config_import_applied' });
    expect(Object.keys(lines[0]?.obj ?? {}).sort()).toEqual(
      ['channel', 'event', 'sourceInstance', 'formatVersion', 'includesAlerts', 'changes', 'criticalWarnings', 'warnings'].sort(),
    );
  });

  it('config_import_rejected (warn) con stage, reason e issues', () => {
    const { logger, lines } = capture();
    configImportRejected(logger, { stage: 'upload', reason: 'invalid', issues: 3, sourceInstance: 'demo-01' });
    configImportRejected(logger, { stage: 'confirm', reason: 'changed' });
    expect(lines.map((l) => [l.level, l.obj])).toEqual([
      [
        'warn',
        { channel: 'config', event: 'config_import_rejected', stage: 'upload', reason: 'invalid', issues: 3, sourceInstance: 'demo-01' },
      ],
      ['warn', { channel: 'config', event: 'config_import_rejected', stage: 'confirm', reason: 'changed', sourceInstance: null }],
    ]);
  });

  it('config_import_cancelled', () => {
    const { logger, lines } = capture();
    configImportCancelled(logger, { reason: 'expired', sourceInstance: 'demo-01' });
    expect(lines[0]?.obj).toEqual({
      channel: 'config',
      event: 'config_import_cancelled',
      reason: 'expired',
      sourceInstance: 'demo-01',
    });
  });

  it('un sourceInstance que no cumple INSTANCE_ID_PATTERN sale como null', () => {
    const { logger, lines } = capture();
    configImportCancelled(logger, { reason: 'operator', sourceInstance: 'Negocio de ejemplo +34910123456' });
    configImportRejected(logger, { stage: 'upload', reason: 'future_version', sourceInstance: 'a b' });
    expect(lines.map((l) => l.obj.sourceInstance)).toEqual([null, null]);
  });

  it('reason y stage fuera del catálogo no compilan', () => {
    const { logger } = capture();
    // @ts-expect-error: motivo que no está en el catálogo
    configImportRejected(logger, { stage: 'upload', reason: 'otro' });
    // @ts-expect-error: fase que no está en el catálogo
    configImportRejected(logger, { stage: 'preview', reason: 'invalid' });
    // @ts-expect-error: motivo de cancelación que no está en el catálogo
    configImportCancelled(logger, { reason: 'timeout', sourceInstance: null });
    // @ts-expect-error: ningún campo de texto libre
    configExported(logger, { includesAlerts: false, counts, fileName: 'x.json' });
  });
});

describe('diseño del chat en los registros (011)', () => {
  const v2 = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'config', 'v2-chat-design.json'), 'utf8'),
  ) as unknown;
  const withDesign = validateConfigFile(v2, 'ES');
  if (!withDesign.ok) throw new Error('fixture no válido');

  it('counts.chatDesign es 0 o 1 y changes.chatDesign solo lleva números', () => {
    expect(countsOf(withDesign.document).chatDesign).toBe(1);
    expect(countsOf(doc).chatDesign).toBe(0);
    const diffWithDesign: SectionDiff[] = [
      {
        section: 'chatDesign',
        sectionLabel: 'Diseño del chat',
        added: [{ label: 'Diseño del chat' }],
        modified: [{ label: 'Diseño del chat', fields: [] }],
        removed: [],
        reordered: false,
      },
    ];
    expect(changesOf(diffWithDesign).chatDesign).toEqual({ added: 1, modified: 1, removed: 0 });
  });

  it('ningún registro lleva textos, colores ni bytes del diseño', () => {
    const { logger, lines } = capture();
    const counts2 = countsOf(withDesign.document);
    configExported(logger, { includesAlerts: false, counts: counts2 });
    configImportPreviewed(logger, {
      sourceInstance: 'demo-01',
      formatVersion: 2,
      sameInstance: false,
      counts: counts2,
      changes: changesOf([]),
      outcome: 'will_apply',
    });
    const text = JSON.stringify(lines);
    const design = withDesign.document.chatDesign;
    if (!design?.chatName || !design.welcomeText || !design.images.logo) throw new Error('fixture');
    const secrets = [design.chatName, design.welcomeText, design.primaryColor, design.images.logo.data.slice(0, 20)];
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});
