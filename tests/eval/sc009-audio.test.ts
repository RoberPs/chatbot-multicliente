/**
 * SC-009 (audios): con AUDIO_TRANSCRIPTION=on, las preguntas con dato hechas por audio se
 * contestan igual que por escrito. Whisper y modelo reales, con las grabaciones de
 * tests/fixtures/audio/. Solo con `pnpm test:eval -- audio` (vitest.config.ts); se omite sin
 * ANTHROPIC_API_KEY, sin STT_API_KEY o si falta alguna grabación.
 */
import { existsSync } from 'node:fs';
import { audioQuestions } from '../fixtures/audio/questions.js';
import { describeCriterion } from './criterion.js';
import { AUDIO_DIR, hasSttKey } from './harness.js';

const missing = audioQuestions
  .flatMap((s) => s.questions)
  .map((q) => q.media?.file ?? '')
  .filter((file) => !existsSync(new URL(file, AUDIO_DIR)));

if (!hasSttKey) console.warn('SC-009 (audios) omitida: falta STT_API_KEY.');
if (missing.length > 0) {
  console.warn(
    `SC-009 (audios) omitida: faltan ${missing.length} grabaciones en tests/fixtures/audio/ ` +
      `(${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}). Ver su README.md.`,
  );
}

describeCriterion('SC-009', 'preguntas por audio', {
  sectors: audioQuestions,
  audio: true,
  skip: !hasSttKey || missing.length > 0,
});
