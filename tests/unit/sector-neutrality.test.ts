/**
 * Principio I / FR-024: en `src/` no puede haber nombres de sectores ni de clientes.
 * Solo pueden aparecer en `tests/fixtures/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');
const FORBIDDEN = [
  /cl[ií]nica/i,
  /\bclinic/i,
  /peluquer/i,
  /\btaller/i,
  /inmobiliaria/i,
  /dentist/i,
  /\bsalon\b/i,
  /\bbarber/i,
  /\bmec[aá]nic/i,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('neutralidad sectorial del código', () => {
  it('el recorrido incluye las vistas y los assets del panel y del chat web (004, 003)', () => {
    const paths = files(SRC).map((f) => relative(SRC, f).replaceAll('\\', '/'));
    // Si alguien filtrase el recorrido por extensión, estas comprobaciones lo delatarían.
    expect(paths).toContain('channels/web/assets/widget.js');
    expect(paths).toContain('channels/web/assets/frame.js');
    expect(paths).toContain('channels/web/assets/frame.css');
    expect(paths).toContain('channels/web/views/frame.eta');
    expect(paths).toContain('admin/views/web-chat.eta');
    expect(paths).toContain('admin/views/playground.eta');
    // 003: textos nuevos del panel.
    expect(paths).toContain('admin/views/partials/handoff-effective.eta');
    expect(paths).toContain('admin/handoff-notice.ts');
    expect(paths).toContain('admin/section-summaries.ts');
    expect(paths.some((p) => p.startsWith('webchat/'))).toBe(true);
    // 005: derivación al negocio (dominio, email, enlaces con sus vistas y CSS, resumen y CLI).
    expect(paths).toContain('handoff/templates.ts');
    expect(paths).toContain('handoff/notices.ts');
    expect(paths).toContain('handoff/business-replies.ts');
    expect(paths).toContain('handoff/repositories/handoff.ts');
    expect(paths).toContain('mail/smtp-mailer.ts');
    expect(paths).toContain('channels/handoff-links/routes.ts');
    expect(paths).toContain('channels/handoff-links/views/page.eta');
    expect(paths).toContain('channels/handoff-links/views/handoff.css');
    expect(paths).toContain('llm/summary-prompt.ts');
    expect(paths).toContain('cli/handoff-templates.ts');
    expect(paths).toContain('admin/views/handoffs.eta');
    // 006: copias de seguridad (formato, operaciones, programador, comandos y arranque).
    expect(paths).toContain('backup/format.ts');
    expect(paths).toContain('backup/service.ts');
    expect(paths).toContain('backup/scheduler.ts');
    expect(paths).toContain('backup/dump.ts');
    expect(paths).toContain('cli/backup.ts');
    expect(paths).toContain('cli/backup-common.ts');
    expect(paths).toContain('startup.ts');
    // 007: herramientas de aprovisionamiento de instancias.
    expect(paths.some((p) => p.startsWith('provisioning/'))).toBe(true);
    expect(paths).toContain('provisioning/check.ts');
    expect(paths).toContain('provisioning/messages.ts');
    expect(paths).toContain('cli/instance.ts');
    // 008: exportar e importar la configuración (formato, validación, diff y vistas del panel).
    expect(paths).toContain('config-transfer/format.ts');
    expect(paths).toContain('config-transfer/schema.ts');
    expect(paths).toContain('config-transfer/diff.ts');
    expect(paths).toContain('admin/routes/config.ts');
    expect(paths).toContain('admin/views/config/index.eta');
    expect(paths).toContain('admin/views/config/preview.eta');
    expect(paths).toContain('admin/views/partials/config-diff.eta');
    // 011: diseño del chat (dominio, parciales del frame, vistas del panel y su script, con la
    // conversación de ejemplo de la vista previa).
    expect(paths).toContain('webchat/design/defaults.ts');
    expect(paths).toContain('webchat/design/theme.ts');
    expect(paths).toContain('webchat/design/images.ts');
    expect(paths).toContain('channels/web/views/partials/messages.eta');
    expect(paths).toContain('channels/web/views/partials/header.eta');
    expect(paths).toContain('admin/routes/chat-design.ts');
    expect(paths).toContain('admin/views/chat-design.eta');
    expect(paths).toContain('admin/views/chat-design.js');
    expect(paths).toContain('admin/views/chat-design/preview.eta');
    expect(paths).toContain('admin/views/chat-design/reset.eta');
  });

  it('ningún fichero de src/ contiene nombres de sector o cliente', () => {
    const hits: string[] = [];
    for (const file of files(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.some((re) => re.test(line)))
          hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
