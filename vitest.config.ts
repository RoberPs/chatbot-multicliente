import { defineConfig } from 'vitest/config';

// La suite de audios (SC-009) usa Whisper real: solo con `pnpm test:eval audio`.
const audioEval = process.argv.slice(2).includes('audio');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Modelo real (API de Anthropic): fuera de `pnpm test`, con coste (research R12).
        test: {
          name: 'eval',
          include: ['tests/eval/**/*.test.ts'],
          exclude: audioEval ? [] : ['tests/eval/sc009-audio.test.ts'],
          environment: 'node',
          globalSetup: ['tests/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
