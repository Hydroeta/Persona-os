// 用 esbuild 把 src/index.ts 打包成 lib/index.js（与 dsh-memory-bus / meow-memory 同款）
// mood.ts 单独出一份：纯函数，便于离线单测（test-mood.mjs 直接 import）
import { build } from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
}

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'lib/index.js' })
await build({ ...common, entryPoints: ['src/mood.ts'], outfile: 'lib/mood.js' })
// persona-assets.ts 也单独出一份：离线单测要直接 import（它是多角色解耦的事实源）
await build({ ...common, entryPoints: ['src/persona-assets.ts'], outfile: 'lib/persona-assets.js' })
