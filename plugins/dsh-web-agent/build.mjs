// 用 esbuild 把 src/index.ts 打包成 lib/index.js（与 dsh-memory-bus / meow-memory 同款）
// playwright 必须外置：它含原生驱动与动态路径解析，不能被打进 bundle，
// 运行时从插件的 node_modules 解析（pnpm workspace + dsh link 会保证可达）。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'lib/index.js',
  sourcemap: true,
  external: ['playwright'],
  logLevel: 'info',
})
