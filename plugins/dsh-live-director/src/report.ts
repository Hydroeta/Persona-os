/**
 * report.ts —— 往总控面板推事件（dsh-live-director 侧）
 *
 * 面板在 :8088，`POST /api/event` 收 `{type, ...}`，再由 SSE 广播给浏览器。
 * 三条硬约束：
 *   · **绝不阻塞主链路**：fire-and-forget，失败只在调试时打日志
 *   · **超时要短**：1500ms，面板没开就快速放弃
 *   · **可以被关掉**：`PANEL_EVENT_URL=''` 或 `PANEL_EVENT=0` 时整个功能静默禁用
 */
const LOG_TAG = '[dsh-live-director/report]'

/** 面板事件入口地址；空字符串 = 关闭 */
export function panelEventUrl(): string {
  if (String(process.env.PANEL_EVENT || '') === '0') return ''
  return String(process.env.PANEL_EVENT_URL || 'http://127.0.0.1:8088/api/event').trim()
}

export interface ReportOpts {
  timeoutMs?: number
  /** 测试注入用 */
  url?: string
}

/** 推一条事件给面板。永不抛异常、永不 await 太久。 */
export async function reportEvent(ev: Record<string, unknown>, opts: ReportOpts = {}): Promise<boolean> {
  const url = opts.url ?? panelEventUrl()
  if (!url) return false
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ev),
      signal: ctrl.signal,
    })
    return r.ok
  } catch (e) {
    // 面板没开是常态，不要刷屏
    if (process.env.PANEL_EVENT_DEBUG === '1') {
      console.log(`${LOG_TAG} 推送失败（面板可能没开）：${(e as Error).message}`)
    }
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 不等待结果的版本：主链路里用它，保证不拖慢 */
export function reportEventNoWait(ev: Record<string, unknown>, opts: ReportOpts = {}): void {
  void reportEvent(ev, opts).catch(() => {})
}
