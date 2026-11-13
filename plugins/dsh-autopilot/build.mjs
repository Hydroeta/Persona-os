// esbuild 打包：index.ts（插件入口）+ guard.ts（纯函数，便于单测）
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts', 'src/guard.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'lib',
  sourcemap: true,
  external: [],
  logLevel: 'info',
})