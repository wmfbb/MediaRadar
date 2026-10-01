import { defineConfig } from 'vitest/config';

// e2e-сценарии (*.spec.ts) запускает Playwright, не Vitest.
export default defineConfig({ test: { include: ['lib/**/*.test.ts', 'components/**/*.test.ts'], environment: 'node' } });
