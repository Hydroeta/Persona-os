// 用 esbuild 把 src/index.ts 打包成 lib/index.js（与 dsh-memory-bus / meow-memory 同款）
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
})
