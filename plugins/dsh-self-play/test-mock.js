/**
 * dsh-self-play · test-mock.js
 *
 * 脱离 DSH 进程，直接验证人格自进化纯逻辑。运行：
 *   先 `node build.mjs` 生成 lib/index.js，再 `node test-mock.js`。
 *
 * 覆盖：
 *   1. extractStringArray：模型把 JSON 包在 ```json / 前后加散文 / 多行嵌套 → 仍能正确提取；
 *      空输出、非数组、超过 3 条 → 正确处理。
 *   2. mergeNegativeRules 去重。
 *   3. 端到端：Mock Ollama 返回 AI 味规则 → dry_run:false 写入 rules.json，
 *      且写入前生成了 rules_backup.json（首次创建也有备份快照）。
 *   4. dry_run:true → 返回规则但不落盘，rules.json / rules_backup.json 均不出现。
 *   5. Ollama 离线（指向关闭端口）→ { ok:false, reason:"Ollama 离线" }，不抛错、不写文件。
 *   6. 3s 超时（Mock 延迟 5s）→ 降级返回 Ollama 离线，不崩。
 *   7. 去重重跑：已写入的规则再跑一次 → "无新增"，written:false，不重复备份。
 *   8. 无样本（memory 离线且未提供 samples）→ { ok:false }，不触发 Ollama。
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSelfPlay, extractStringArray, mergeNegativeRules } from './lib/index.js'

const results = []
let passCount = 0
let failCount = 0
function assert(name, cond, detail = '') {
  const ok = !!cond
  results.push({ name, pass: ok, detail })
  if (ok) passCount++
  else failCount++
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 严重 AI 味样本（用于触发裁判输出负向规则）
const AI_FLAVOR_SAMPLES = [
  '首先我们要明确这个问题的核心，其次再分析具体的解决方案。',
  '希望这个回答对你有帮助，如果你还有其他问题，欢迎随时向我提问。',
  '总的来说，我们需要从以下几个方面来综合考虑，首先是需求，其次是实现，最后是优化。',
]

// ---------------------------------------------------------------------------
// Mock Ollama：起一个本地 HTTP 服务，模拟 /v1/chat/completions
// ---------------------------------------------------------------------------
function startFakeOllama({ makeContent, delayMs = 0, status = 200 }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const respond = () => {
          const content = typeof makeContent === 'function' ? makeContent(body) : makeContent
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
        }
        if (delayMs > 0) setTimeout(respond, delayMs)
        else respond()
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

// ---------------------------------------------------------------------------
// 临时 persona 目录（隔离真实 config，测试完删除）
// ---------------------------------------------------------------------------
function makeTempPersonaDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-self-play-test-'))
  const personaDir = path.join(root, 'ohwhale')
  fs.mkdirSync(personaDir, { recursive: true })
  fs.writeFileSync(path.join(personaDir, 'persona.json'), JSON.stringify({ id: 'ohwhale', identity: { self_name: '鲸鲸' } }), 'utf-8')
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ active_id: 'ohwhale' }), 'utf-8')
  return root
}

async function main() {
  console.log('\n=== dsh-self-play 测试 ===\n')
  const tempPersonasRoot = makeTempPersonaDir()
  process.env.PERSONA_CONFIG_DIR = tempPersonasRoot
  const rulesPath = path.join(tempPersonasRoot, 'ohwhale', 'rules.json')
  const backupPath = path.join(tempPersonasRoot, 'ohwhale', 'rules_backup.json')

  try {
    // ==================================================================
    // 1. extractStringArray 纯解析
    // ==================================================================
    console.log('--- 1. extractStringArray 解析健壮性 ---')
    assert('plain array', extractStringArray('["a","b"]').length === 2)
    assert(
      'wrapped in markdown json + prose',
      extractStringArray('好的，分析如下：\n```json\n["绝对不要用客服腔结尾","不要用首先其次"]\n```\n以上。').length === 2,
    )
    assert(
      'multiline nested-safe',
      extractStringArray('前缀文字\n[\n  "规则一：不要说教",\n  "规则二"\n]\n后缀').length === 2,
    )
    assert('empty array → []', Array.isArray(extractStringArray('[]')) && extractStringArray('[]').length === 0)
    assert('no brackets → []', extractStringArray('没有 JSON').length === 0)
    assert('object not array → []', extractStringArray('{"a":1}').length === 0)
    assert('>3 条截断到 3', extractStringArray('["1","2","3","4","5"]').length === 3)
    assert('过滤非字符串/空串', extractStringArray('["ok", "", 123, "  "]').length === 1)

    // ==================================================================
    // 2. mergeNegativeRules 去重
    // ==================================================================
    console.log('\n--- 2. mergeNegativeRules 去重 ---')
    const merged = mergeNegativeRules(['已有规则A'], ['已有规则A', '新规则B', ' 新规则B '])
    assert('去重后 2 条（A + B）', merged.length === 2, `got=${JSON.stringify(merged)}`)
    assert('保留原顺序，新规则追加在末尾', merged[0] === '已有规则A' && merged[1] === '新规则B')

    // ==================================================================
    // 3. 端到端写入：Mock Ollama → 写 rules.json + 生成 backup
    // ==================================================================
    console.log('\n--- 3. 端到端：dry_run:false 写入并备份 ---')
    const mockContent =
      '裁判分析完成：\n```json\n["绝对不要用客服腔的总结结尾","不要用首先其次分点说教","不要长篇大论"]\n```'
    const server1 = await startFakeOllama({ makeContent: mockContent })
    const res1 = await runSelfPlay({
      samples: AI_FLAVOR_SAMPLES,
      ollamaUrl: server1.url,
      dry_run: false,
    })
    await server1.close()
    assert('返回 ok=true', res1.ok === true, `reason=${res1.reason}`)
    assert('negative_rules 提取到 3 条', Array.isArray(res1.negative_rules) && res1.negative_rules.length === 3, JSON.stringify(res1.negative_rules))
    assert('written=true', res1.written === true)
    assert('backup_written=true', res1.backup_written === true)
    assert('rules.json 已创建', fs.existsSync(rulesPath))
    assert('rules_backup.json 已创建（写入前备份）', fs.existsSync(backupPath), '⚠️ 用户要求：写入前必须生成 rules_backup.json')
    const written = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'))
    assert('rules.json 的 negative_rules 含 3 条', Array.isArray(written.negative_rules) && written.negative_rules.length === 3, JSON.stringify(written?.negative_rules))
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'))
    assert('备份是写入前的空快照（首次创建）', Array.isArray(backup.negative_rules) && backup.negative_rules.length === 0)

    // ==================================================================
    // 4. dry_run:true 不落盘
    // ==================================================================
    console.log('\n--- 4. dry_run:true 只预览不落盘 ---')
    // 先删掉文件，确认 dry_run 不会重建
    fs.rmSync(rulesPath, { force: true })
    fs.rmSync(backupPath, { force: true })
    const server2 = await startFakeOllama({ makeContent: '["测试规则X"]' })
    const res2 = await runSelfPlay({ samples: AI_FLAVOR_SAMPLES, ollamaUrl: server2.url, dry_run: true })
    await server2.close()
    assert('dry_run 返回 ok=true', res2.ok === true, res2.reason)
    assert('dry_run 仍返回提取到的规则', Array.isArray(res2.negative_rules) && res2.negative_rules.length === 1)
    assert('dry_run written=false', res2.written === false)
    assert('dry_run 不创建 rules.json', !fs.existsSync(rulesPath))
    assert('dry_run 不创建 rules_backup.json', !fs.existsSync(backupPath))

    // ==================================================================
    // 5. Ollama 离线 → 降级，不抛错不写文件
    // ==================================================================
    console.log('\n--- 5. Ollama 离线降级 ---')
    fs.rmSync(rulesPath, { force: true })
    fs.rmSync(backupPath, { force: true })
    const res3 = await runSelfPlay({ samples: AI_FLAVOR_SAMPLES, ollamaUrl: 'http://127.0.0.1:1', dry_run: false })
    assert('离线返回 ok=false', res3.ok === false, `reason=${res3.reason}`)
    assert('离线 reason 含 "Ollama 离线"', /Ollama 离线/.test(res3.reason || ''), `reason=${res3.reason}`)
    assert('离线不创建 rules.json', !fs.existsSync(rulesPath))
    assert('离线不创建 rules_backup.json', !fs.existsSync(backupPath))

    // ==================================================================
    // 6. 3s 超时 → 降级（Mock 延迟 5s）
    // ==================================================================
    console.log('\n--- 6. 3s 超时降级（约 3s）---')
    const server4 = await startFakeOllama({ makeContent: '["不会被读到"]', delayMs: 5000 })
    const t0 = Date.now()
    const res4 = await runSelfPlay({ samples: AI_FLAVOR_SAMPLES, ollamaUrl: server4.url, timeoutMs: 3000, dry_run: false })
    const elapsed = Date.now() - t0
    await server4.close()
    assert('超时返回 ok=false', res4.ok === false, `reason=${res4.reason}`)
    assert('超时 reason 含 "Ollama 离线"', /Ollama 离线/.test(res4.reason || ''), `reason=${res4.reason}`)
    assert('3s 左右触发降级（< 4.5s）', elapsed < 4500, `elapsed=${elapsed}ms`)

    // ==================================================================
    // 7. 去重重跑 → 无新增，不重复写
    // ==================================================================
    console.log('\n--- 7. 去重重跑 ---')
    // 预置：rules.json 已含这 3 条规则（模拟上一轮已写入），再跑同一份裁判输出应判定"无新增"
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({ negative_rules: ['绝对不要用客服腔的总结结尾', '不要用首先其次分点说教', '不要长篇大论'] }, null, 2),
      'utf-8',
    )
    fs.rmSync(backupPath, { force: true })
    const server5 = await startFakeOllama({ makeContent: mockContent })
    const res5 = await runSelfPlay({ samples: AI_FLAVOR_SAMPLES, ollamaUrl: server5.url, dry_run: false })
    await server5.close()
    assert('重跑 ok=true', res5.ok === true, res5.reason)
    assert('重跑无新增（negative_rules 返回空）', Array.isArray(res5.negative_rules) && res5.negative_rules.length === 0, JSON.stringify(res5.negative_rules))
    assert('重跑 written=false', res5.written === false)
    const after = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'))
    assert('rules.json 仍为 3 条，未重复追加', after.negative_rules.length === 3, `len=${after.negative_rules.length}`)

    // ==================================================================
    // 8. 无样本 → 不触发 Ollama，安全返回
    // ==================================================================
    console.log('\n--- 8. 无样本降级 ---')
    const res6 = await runSelfPlay({ memoryUrl: 'http://127.0.0.1:1', ollamaUrl: 'http://127.0.0.1:1', dry_run: false })
    assert('无样本返回 ok=false', res6.ok === false, `reason=${res6.reason}`)
    assert('无样本 samples_count=0', res6.samples_count === 0)
    assert('无样本 reason 含 "无可用样本"', /无可用样本/.test(res6.reason || ''), `reason=${res6.reason}`)
  } finally {
    // 清理临时目录 + 还原 env
    delete process.env.PERSONA_CONFIG_DIR
    try { fs.rmSync(tempPersonasRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  console.log(`\n=== 结果：${passCount} 通过 / ${failCount} 失败（共 ${results.length}）===\n`)
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('测试未捕获异常：', e)
  process.exit(2)
})
