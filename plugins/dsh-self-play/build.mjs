// 用 esbuild 把 src/index.ts 打包成 lib/index.js（与 dsh-memory-bus / dsh-persona-core 同款）
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
  // node-cron 是 CJS 模块，内部 require('events'/'node-cron' 内置等)。
  // esbuild 以 ESM 输出后 require 不存在，会报 "Dynamic require of X is not supported"。
  // 注入 createRequire 作为 banner（与 dsh-live-director 同款），让 bundle 内 CJS 正确解析内置模块，
  // 同时保持插件自包含、DSH 加载时零外部运行时依赖。
  banner: {
    js:
      // 用别名导入，避免与源码里的 `import { dirname } from 'node:path'` 撞名。
      // 只向 bundle 作用域暴露 require / __dirname / __filename 三个 CJS 惯用变量。
      `import { createRequire } from 'module';` +
      `import { fileURLToPath as __bannerFileURLToPath } from 'url';` +
      `import { dirname as __bannerDirname } from 'path';` +
      `const require = createRequire(import.meta.url);` +
      `const __filename = __bannerFileURLToPath(import.meta.url);` +
      `const __dirname = __bannerDirname(__filename);`,
  },
})
