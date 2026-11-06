// 用 esbuild 同时打包：
//   1) 后端：src/index.ts → lib/index.js（Node ESM，零运行时依赖）
//   2) 前端：web/app.js  → web/app.bundle.js（浏览器 IIFE，内嵌 three + addons）
//
// 前端必须打成 IIFE + 普通 <script src>：Chrome 对 file:// 的 ES module import 有
// CORS 限制，<script type=module> 会白屏。IIFE 单文件可双击 file:// 直接打开。
import { build } from 'esbuild'

const common = {
  bundle: true,
  logLevel: 'info',
}

// 1) 后端
await build({
  ...common,
  entryPoints: ['src/index.ts'],
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'lib/index.js',
  sourcemap: true,
})

// 2) 前端（含 three，file:// 可跑的单文件）
await build({
  ...common,
  entryPoints: ['web/app.js'],
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: 'web/app.bundle.js',
  sourcemap: false,
  minify: false,
})
