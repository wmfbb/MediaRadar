import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // внутренние пакеты собираются в бандл (они отдаются как TypeScript-исходники); остальное — из node_modules
  noExternal: [/^@mediaradar\//],
  // нативные и «тяжёлые» зависимости внутренних пакетов остаются внешними (объявлены в dependencies приложения)
  external: ['@node-rs/argon2', 'pg', 'pg-native'],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
