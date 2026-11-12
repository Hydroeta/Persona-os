/**
 * test-reference.mjs —— search_reference 的真实联网验证
 * 跑法：node build.mjs && node test-reference.mjs
 * 会真的去 GitHub / Bing 搜，需要网络。失败也算结果（返回 ok:false 是设计的一部分）。
 */
import { searchReference } from './lib/reference.js'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// 1) 空 query：必须拒绝，不能打到网络
const empty = await searchReference({ query: '' })
check('空 query 直接拒绝', empty.ok === false && !!empty.error, empty.error || '')

// 2) GitHub：模拟一次真实的「音频队列优化」检索
const gh = await searchReference({ query: 'audio queue optimization', source: 'github', limit: 3 })
if (gh.ok) {
  check('GitHub 返回 ≤3 条', gh.items.length <= 3 && gh.items.length > 0, `${gh.items.length} 条 / ${gh.elapsed_ms}ms`)
  check('每条都有仓库名和链接', gh.items.every((i) => i.title && i.url.startsWith('http')))
  check('带 star 数', gh.items.some((i) => typeof i.stars === 'number'))
  check('前两名带 README 片段', gh.items.slice(0, 2).some((i) => (i.readme || '').length > 50))
  console.log('\n--- GitHub 参考 ---')
  for (const it of gh.items) {
    console.log(`${it.title}  ⭐${it.stars ?? '-'}  ${it.url}`)
    console.log(`  ${(it.description || '').slice(0, 100)}`)
    if (it.readme) console.log(`  README 开头：${it.readme.replace(/\s+/g, ' ').slice(0, 200)}…`)
  }
} else {
  // 网络不通时，正确行为就是 ok:false（调用方降级），这不算失败
  check('GitHub 不可用时返回 ok:false（可降级）', gh.ok === false && !!gh.error, gh.error || '')
}

// 3) web：Bing 技术文章
const web = await searchReference({ query: 'nodejs 任务队列 最佳实践', source: 'web', limit: 3 })
if (web.ok) {
  check('web 返回条目且带标题与链接', web.items.length > 0 && web.items.every((i) => i.title && i.url.startsWith('http')))
  console.log('\n--- 网页参考 ---')
  for (const it of web.items) console.log(`${it.title}\n   ${it.url}\n   ${(it.description || '').slice(0, 100)}`)
} else {
  console.log('\n（web 检索不可用，按设计返回 ok:false：', web.error, '）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
