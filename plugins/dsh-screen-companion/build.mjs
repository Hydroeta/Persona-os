// 用 esbuild 把 src/index.ts 打包成 lib/index.js。
// node-screenshots 是原生模块（含平台二进制 .node），必须外置、运行时从插件 node_modules 解析。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts', 'src/analyze.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'lib',
  sourcemap: true,
  external: ['node-screenshots'],
  logLevel: 'info',
})
