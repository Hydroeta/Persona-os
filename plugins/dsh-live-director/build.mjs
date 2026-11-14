// 用 esbuild 把 src/ 打包成 lib/：
//   - index.ts → lib/index.js  （DSH 插件入口，bundle 进 ws 等依赖，加载时零外部依赖）
//   - queue.ts → lib/queue.js  （弹幕队列模块，供 test-mock.js 直接 import 做脱离 DSH 的单测）
import { build } from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // ws 是 CJS 模块，内部 require('events'/'http'/...) 等 Node 内置模块。
  // esbuild 以 ESM 输出后 require 不存在，会报 "Dynamic require of X is not supported"。
  // 注入 createRequire 作为 banner，让 bundle 内的 CJS 代码能正确解析内置模块。
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  // node-screenshots 是 native 模块（含预编译 .node 二进制），必须 external：
  // 运行时动态 import 加载，esbuild 不打包它，避免二进制路径解析错误。
  external: ['node-screenshots'],
}

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'lib/index.js' })
await build({ ...common, entryPoints: ['src/queue.ts'], outfile: 'lib/queue.js' })
await build({ ...common, entryPoints: ['src/director.ts'], outfile: 'lib/director.js' })
await build({ ...common, entryPoints: ['src/memory.ts'], outfile: 'lib/memory.js' })
await build({ ...common, entryPoints: ['src/perception.ts'], outfile: 'lib/perception.js' })
await build({ ...common, entryPoints: ['src/bgm.ts'], outfile: 'lib/bgm.js' })
await build({ ...common, entryPoints: ['src/draw.ts'], outfile: 'lib/draw.js' })
await build({ ...common, entryPoints: ['src/painter-bridge.ts'], outfile: 'lib/painter-bridge.js' })
await build({ ...common, entryPoints: ['src/art-panel.ts'], outfile: 'lib/art-panel.js' })
await build({ ...common, entryPoints: ['src/tts.ts'], outfile: 'lib/tts.js' })
await build({ ...common, entryPoints: ['src/fan-art.ts'], outfile: 'lib/fan-art.js' })
