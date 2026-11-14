// esbuild：把 src/page.html 内联成 page.ts 的字符串常量，再打包 index / server / probe / danmaku
// 面板是单文件 HTML，不需要前端打包工具；这里只是把文件读进来当字符串常量。
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync('src/page.html', 'utf8')
// 用 JSON.stringify 生成合法的 TS 字符串字面量，避免手写转义出错
writeFileSync('src/page.generated.ts', `// ⚠️ 自动生成，勿手改。源文件：src/page.html\nexport const PAGE_HTML = ${JSON.stringify(html)}\n`, 'utf8')

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // ws 是 CJS，bundle 成 ESM 后内部 require('events') 会炸；注入 createRequire 兜底
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
}

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'lib/index.js' })
await build({ ...common, entryPoints: ['src/probe.ts'], outfile: 'lib/probe.js' })
await build({ ...common, entryPoints: ['src/danmaku.ts'], outfile: 'lib/danmaku.js' })
// server.ts 也要单独出一份：test-mock.js 直接 import 它起临时面板（端口 0）
await build({ ...common, entryPoints: ['src/server.ts'], outfile: 'lib/server.js' })
