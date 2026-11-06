/**
 * dsh-live-director · test-mock.js
 *
 * 脱离 DSH 进程，直接验证模块 1（弹幕接入 + 优先级队列 + 冷却）与模块 2（Rundown 状态机 + 心跳）。
 * 运行：先 `node build.mjs` 生成 lib/queue.js + lib/director.js，再 `node test-mock.js`。
 *
 * 覆盖场景：
 *   1. 观众 A 发「画个鲸鱼」 → WS 接收、识别为画图指令(priority=2)并入队。
 *   2. 观众 A 连续发 3 次「画图」 → 第 1 次放行，第 2、3 次被单用户冷却(10s)拦截。
 *   3. 状态机心跳：传入 durationOverrideMs / coldThresholdMs / tickIntervalMs 提速，
 *      几秒内验证能自动产出 switch_state 与 cold_break 两种 sys_action。
 *   4. 队列消费顺序：低/中/高优先级入队，验证 consume 按 高→中→低 串行出队。
 *   5. 画面感知：发“在干嘛”→ mock 截屏 + 视觉返回描述 → 验证描述注入 LLM Payload，模拟回复包含它。
 *   6. 观众记忆：模拟老观众“张三”发弹幕 → 验证 getUserContext 命中且记忆注入 System Prompt（打印 Payload）。
 */
import { startDanmakuServer, PriorityQueue, Priority } from './lib/queue.js'
import { Director, RundownState } from './lib/director.js'
import { MemoryClient } from './lib/memory.js'
import { Perception, shouldCaptureScreen } from './lib/perception.js'
import { buildChatMessages } from './lib/index.js'

const TEST_PORT = 9099 // 避开生产端口 9001
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

/** 发送一条弹幕并等待服务端回执（用标准 WebSocket API：addEventListener，Node 内置 WebSocket 无 .on/.once） */
function sendDanmaku(ws, payload) {
  return new Promise((resolve, reject) => {
    const onMsg = (event) => {
      ws.removeEventListener('message', onMsg)
      try {
        resolve(JSON.parse(event.data.toString()))
      } catch (e) {
        reject(e)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify(payload))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`\n=== dsh-live-director 测试（端口 ${TEST_PORT}）===\n`)

  // ==================================================================
  // 模块 1：弹幕 WebSocket 通路（场景 1 + 场景 2）
  // ==================================================================
  const server = await startDanmakuServer({ port: TEST_PORT })
  console.log('服务已启动，连接 WS 客户端...\n')

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  console.log('WS 客户端已连接，开始场景测试。\n')

  // ------------------------------------------------------------------
  // 场景 1：观众 A 发「画个鲸鱼」
  // ------------------------------------------------------------------
  console.log('── 场景 1：观众 A 发「画个鲸鱼」')
  server.limiter.reset()
  server.queue.clear()
  const r1 = await sendDanmaku(ws, { user: 'A', text: '画个鲸鱼', gift: 0 })
  assert('WS 回执 ok=true（弹幕被接收）', r1.ok === true, JSON.stringify(r1))
  assert('识别为画图指令 priority=2', r1.priority === 2, `priority=${r1.priority}`)
  assert('入队后 queueSize=1', r1.queueSize === 1, `queueSize=${r1.queueSize}`)
  assert('回执带回原 text', r1.text === '画个鲸鱼', `text=${r1.text}`)
  console.log('')

  // ------------------------------------------------------------------
  // 场景 2：观众 A 连续发 3 次「画图」 → 冷却拦截
  // ------------------------------------------------------------------
  console.log('── 场景 2：观众 A 连续发 3 次「画图」')
  server.limiter.reset()
  server.queue.clear()
  const r2a = await sendDanmaku(ws, { user: 'A', text: '画图', gift: 0 })
  const r2b = await sendDanmaku(ws, { user: 'A', text: '画图', gift: 0 })
  const r2c = await sendDanmaku(ws, { user: 'A', text: '画图', gift: 0 })
  assert('第 1 次「画图」放行 ok=true', r2a.ok === true, JSON.stringify(r2a))
  assert('第 2 次被冷却拦截 ok=false', r2b.ok === false, `reason=${r2b.reason}`)
  assert('第 3 次被冷却拦截 ok=false', r2c.ok === false, `reason=${r2c.reason}`)
  assert('拦截后队列未增长（仍为 1）', server.queue.size === 1, `queueSize=${server.queue.size}`)
  console.log('')

  // 收尾：关闭 WS 通路（场景 3/4 不依赖它）
  ws.close()
  await server.close()

  // ==================================================================
  // 模块 2：Rundown 状态机 + 心跳（场景 3）
  //   用覆盖参数提速：状态 1.5s 一切、冷场 1.2s 触发、tick 0.3s，
  //   原本 3 分钟的切换几秒内即可观测。
  // ==================================================================
  console.log('── 场景 3：状态机心跳（覆盖参数提速，等待 ~4s）')
  const actions = []
  const director = new Director({
    durationOverrideMs: 1500, // 每个状态只跑 1.5s
    coldThresholdMs: 1200, // 1.2s 无互动就冷场
    tickIntervalMs: 300, // 每 0.3s 跳一次
    onActionNeeded: (a) => actions.push(a),
  })
  assert('初始状态为 CHITCHAT', director.currentState === RundownState.CHITCHAT, director.currentState)
  director.start()
  assert('start() 后 running=true', director.running === true)
  await sleep(4000)
  director.stop()
  assert('stop() 后 running=false', director.running === false)

  const switches = actions.filter((a) => a.type === 'switch_state')
  const colds = actions.filter((a) => a.type === 'cold_break')
  console.log(`   收集到 sys_action：switch_state=${switches.length} 次，cold_break=${colds.length} 次`)
  console.log(`   详情：${JSON.stringify(actions)}`)

  assert('状态机产出 ≥1 次 switch_state', switches.length >= 1, `count=${switches.length}`)
  assert('状态机产出 ≥1 次 cold_break（无弹幕也会主动搭话）', colds.length >= 1, `count=${colds.length}`)
  assert('首次切换 from=CHITCHAT', switches[0]?.from === RundownState.CHITCHAT, JSON.stringify(switches[0]))
  assert('首次切换 to=GUESSING', switches[0]?.to === RundownState.GUESSING, JSON.stringify(switches[0]))
  assert('运行后状态已流转（不再是初始 CHITCHAT）', director.currentState !== RundownState.CHITCHAT, director.currentState)
  assert('cold_break 带有 topic 字段', typeof colds[0]?.topic === 'string' && colds[0].topic.length > 0, JSON.stringify(colds[0]))
  console.log('')

  // ==================================================================
  // 队列消费顺序（场景 4）：验证 consume 按优先级 高→中→低 串行出队
  // ==================================================================
  console.log('── 场景 4：队列消费顺序（高→中→低）')
  const q = new PriorityQueue()
  const consumed = []
  const stopQ = q.consume(
    async (item) => {
      consumed.push({ priority: item.priority, text: item.msg.text })
    },
    { intervalMs: 50 },
  )
  // 入队顺序故意打乱：低 → 中 → 高
  q.push({ msg: { user: 'u1', text: '低', gift: 0, ts: Date.now() }, priority: Priority.CHAT, reason: 'chat' })
  q.push({ msg: { user: 'u2', text: '中', gift: 0, ts: Date.now() }, priority: Priority.DRAW, reason: 'draw' })
  q.push({ msg: { user: 'u3', text: '高', gift: 0, ts: Date.now() }, priority: Priority.GIFT, reason: 'gift' })
  await sleep(400)
  stopQ()
  console.log(`   消费顺序 priority：${JSON.stringify(consumed.map((c) => c.priority))}`)
  assert('消费了全部 3 条', consumed.length === 3, `len=${consumed.length}`)
  assert(
    '消费顺序为 高(3)→中(2)→低(1)',
    consumed[0]?.priority === Priority.GIFT &&
      consumed[1]?.priority === Priority.DRAW &&
      consumed[2]?.priority === Priority.CHAT,
    JSON.stringify(consumed.map((c) => c.priority)),
  )
  assert('消费后队列为空', q.size === 0, `size=${q.size}`)
  console.log('')

  // ==================================================================
  // 模块 4：多模态画面感知（场景 5）
  //   mock 截屏 + mock 视觉客户端，验证“画面描述 → 注入 LLM Payload → 回复包含描述”全链路。
  // ==================================================================
  console.log('── 场景 5：画面感知（在干嘛 → 描述注入 LLM）')
  assert('shouldCaptureScreen("主播在干嘛")=true', shouldCaptureScreen('主播在干嘛') === true)
  assert('shouldCaptureScreen("画了什么")=true', shouldCaptureScreen('画了什么') === true)
  assert('shouldCaptureScreen("你好")=false', shouldCaptureScreen('你好') === false)

  const MOCK_DESC = '我在画一只赛博鲸鱼'
  let capturedBase64 = ''
  const perc = new Perception({
    captureFn: async () => Buffer.from('fake-jpeg-bytes'),
    visionClient: {
      describe: async (b64) => {
        capturedBase64 = b64
        return MOCK_DESC
      },
    },
  })
  const desc = await perc.captureScreenContext()
  assert('captureScreenContext 返回画面描述', desc === MOCK_DESC, `desc=${desc}`)
  assert('视觉客户端收到非空 base64 图片', capturedBase64.length > 0, `b64len=${capturedBase64.length}`)

  const msgsScreen = buildChatMessages({ user: '观众A', text: '主播在干嘛', screenContext: desc })
  console.log('   LLM 请求 Payload（含画面）：')
  console.log(JSON.stringify(msgsScreen, null, 2))
  assert('画面描述已注入 LLM 请求 Payload', msgsScreen.some((m) => m.content.includes(MOCK_DESC)), '未注入画面描述')

  // 模拟 LLM：payload 含画面描述 → 回复带上它
  const mockLlmReply = (messages) => {
    const all = messages.map((m) => m.content).join(' ')
    return all.includes(MOCK_DESC) ? `我正在${MOCK_DESC}，要看看吗～` : '你好呀'
  }
  const reply = mockLlmReply(msgsScreen)
  assert('模拟 LLM 回复包含画面描述', reply.includes(MOCK_DESC), `reply=${reply}`)

  // 对比：无画面关键词 / 无描述时不注入
  const msgsPlain = buildChatMessages({ user: '观众A', text: '你好' })
  assert('无画面上下文时 Payload 不含“当前直播画面”', !msgsPlain.some((m) => m.content.includes('当前直播画面')))
  console.log('')

  // ==================================================================
  // 模块 3：观众记忆注入（场景 6）
  //   mock memory transport：张三有档案，李四没有。验证记忆注入 System Prompt（打印 Payload）。
  // ==================================================================
  console.log('── 场景 6：观众记忆注入（老观众张三）')
  const memoryStore = { recalled: [], remembered: [] }
  const mockTransport = {
    recall: async (query) => {
      memoryStore.recalled.push(query)
      if (query === '张三') {
        return [
          {
            id: 'm1',
            level: 'user',
            title: '张三档案',
            snippet: '张三，老粉，喜欢点画图，常送礼物',
            tags: ['张三', '老粉'],
          },
        ]
      }
      return []
    },
    remember: async (text, tags, level) => {
      memoryStore.remembered.push({ text, tags, level })
    },
  }
  const mem = new MemoryClient({ transport: mockTransport })

  const userCtx = await mem.getUserContext('张三')
  assert('getUserContext 查到张三记忆（含“老粉”）', userCtx.includes('老粉'), `ctx=${userCtx}`)
  assert('getUserContext 查到张三记忆（含“画图”）', userCtx.includes('画图'), `ctx=${userCtx}`)

  const msgsMem = buildChatMessages({ user: '张三', text: '在吗', userContext: userCtx })
  console.log('   LLM 请求 Payload（含记忆）：')
  console.log(JSON.stringify(msgsMem, null, 2))
  const sysContent = msgsMem.find((m) => m.role === 'system')?.content || ''
  assert('记忆注入到 System Prompt（含“张三”）', sysContent.includes('张三'), sysContent)
  assert('记忆注入到 System Prompt（含“老粉”）', sysContent.includes('老粉'), sysContent)

  // 对比：查不到的用户返回空，不注入档案
  const userCtx2 = await mem.getUserContext('李四')
  assert('查不到李四 → 返回空字符串', userCtx2 === '', `ctx=${userCtx2}`)
  const msgsNoMem = buildChatMessages({ user: '李四', text: 'hi', userContext: userCtx2 })
  const sys2 = msgsNoMem.find((m) => m.role === 'system')?.content || ''
  assert('无记忆时 System Prompt 不含“历史记忆档案”', !sys2.includes('历史记忆档案'), sys2)

  // saveUserInteraction：异步 fire-and-forget 存入，不阻塞、不抛错
  mem.saveUserInteraction('张三', '今天又来了，点个画图')
  await sleep(50)
  assert('saveUserInteraction 触发了 remember 调用', memoryStore.remembered.length === 1, JSON.stringify(memoryStore.remembered))
  assert('存入内容包含用户名“张三”', memoryStore.remembered[0]?.text?.includes('张三'), JSON.stringify(memoryStore.remembered[0]))
  assert('存入 tags 包含用户名', Array.isArray(memoryStore.remembered[0]?.tags) && memoryStore.remembered[0].tags.includes('张三'), JSON.stringify(memoryStore.remembered[0]?.tags))
  assert('存入 level=user', memoryStore.remembered[0]?.level === 'user', JSON.stringify(memoryStore.remembered[0]))
  console.log('')

  // ==================================================================
  // 汇总
  // ==================================================================
  console.log(`=== 测试完成：${passCount} 通过 / ${failCount} 失败 ===`)
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('测试运行出错：', e)
  process.exit(1)
})
