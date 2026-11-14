// 用 esbuild 把 src/index.ts 打包成 lib/index.js（与 dsh-web-agent / dsh-memory-bus 同款）
// sharp 必须外置：原生模块（含平台二进制 .node），不能被打进 bundle。
// axios 也外置：它是 CJS，内部 combined-stream / form-data 会动态 require('util') 等 Node 内置，
// 打进 ESM bundle 会触发 "Dynamic require of X is not supported"；外置后由 Node 以真实 CJS 加载，
// 默认导出互操作正常。两者运行时都从插件 node_modules 解析（npm 扁平安装，无 junction 回收问题）。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts', 'src/pixel.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'lib',
  sourcemap: true,
  external: ['sharp', 'axios'],
  logLevel: 'info',
})
