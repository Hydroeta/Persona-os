// 用 esbuild 把 src/index.ts 打包成 lib/index.js（与 meow-memory 同款构建方式）
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts', 'src/control-api.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'lib',
  sourcemap: true,
  logLevel: 'info',
})
