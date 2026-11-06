// 用 esbuild 把 src/index.ts 打包成 lib/index.js（与 dsh-live-director / dsh-self-play 同款）
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
  // node-screenshots 是 native 模块（含预编译 .node 二进制），必须 external：
  // 运行时动态 import 加载，esbuild 不打包它，避免二进制路径解析错误。
  external: ['node-screenshots'],
  // 注入 createRequire 作为 banner（与 dsh-live-director 同款），让 bundle 内 CJS 代码
  // 正确解析内置模块，同时保持插件自包含、DSH 加载时零外部运行时依赖。
  // 用别名导入，避免与源码里的 `import { dirname } from 'node:path'` 撞名。
  banner: {
    js:
      `import { createRequire } from 'module';` +
      `import { fileURLToPath as __bannerFileURLToPath } from 'url';` +
      `import { dirname as __bannerDirname } from 'path';` +
      `const require = createRequire(import.meta.url);` +
      `const __filename = __bannerFileURLToPath(import.meta.url);` +
      `const __dirname = __bannerDirname(__filename);`,
  },
})
