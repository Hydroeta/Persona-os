/**
 * art-panel.ts —— 画作在 OBS 上的显隐控制
 *
 * **未验证模块**：这台机器上 OBS 没在跑、4455 连不上、场景名也没确认，所以这里只保证
 *   "配置齐了就能用、配置不齐绝不崩"。等你开好 OBS，设上下面三个环境变量即可：
 *
 *   OBS_WS_URL       ws://127.0.0.1:4455
 *   OBS_SCENE_NAME   放图片源的那个场景名（如「主场景」）
 *   OBS_SOURCE_NAME  图片源名（默认 DynamicArt）
 *   OBS_ART_HOLD_MS  画完后再显示多久（默认 30000）
 *
 * 行为：
 *   showArt()  —— 作画开始：把源打开（已经是开的就直接返回）。
 *                 每次调用都会重置"自动隐藏"计时器 —— 新单进来时上一张的倒计时作废。
 *   hideArt()  —— 到时自动收起；也可手动调。
 *
 * 失败一律降级为 no-op + 打日志，绝不影响直播主循环。
 */
import { sharedObsClient } from './bgm.js'

const LOG_TAG = '[dsh-live-director/art-panel]'

export interface ArtPanelConfig {
  url: string
  scene: string
  source: string
  holdMs: number
}

/** 读环境变量；缺任何一个就返回 null（= 不启用） */
export function readArtPanelConfig(env: NodeJS.ProcessEnv = process.env): ArtPanelConfig | null {
  const url = String(env.OBS_WS_URL || '').trim()
  const scene = String(env.OBS_SCENE_NAME || '').trim()
  const source = String(env.OBS_SOURCE_NAME || 'DynamicArt').trim() || 'DynamicArt'
  if (!url || !scene) return null
  const hold = Number(env.OBS_ART_HOLD_MS)
  return { url, scene, source, holdMs: Number.isFinite(hold) && hold > 0 ? hold : 30_000 }
}

/** 找 source 在 scene 里的 itemId（v5 用 GetSceneItemId） */
async function findItemId(scene: string, source: string): Promise<number> {
  const r = await sharedObsClient.request('GetSceneItemId', { sceneName: scene, sourceName: source })
  const id = Number(r?.sceneItemId)
  if (!Number.isFinite(id)) throw new Error(`场景「${scene}」里找不到源「${source}」`)
  return id
}

export class ArtPanel {
  private timer: NodeJS.Timeout | null = null
  private visible = false

  constructor(private cfg: ArtPanelConfig | null, private log: (msg: string) => void = console.log) {}

  get enabled(): boolean {
    return !!this.cfg
  }

  /** 作画开始：确保显示；重置自动隐藏计时 */
  async showArt(holdMs?: number): Promise<{ ok: boolean; reason?: string }> {
    if (!this.cfg) {
      this.log(`${LOG_TAG} 未配置 OBS_WS_URL / OBS_SCENE_NAME，跳过显隐（no-op）`)
      return { ok: false, reason: '未配置' }
    }
    // 连接用的地址以 wsClient 自身读到的 OBS_WS_URL 为准（bgm.ts 在模块加载时读取）。
    // 这里不能再查 process.env —— 那个值可能是后来才设的，和客户端里的不一致。
    try {
      await sharedObsClient.connect()
      if (!this.visible) {
        const sceneItemId = await findItemId(this.cfg.scene, this.cfg.source)
        await sharedObsClient.request('SetSceneItemEnabled', {
          sceneName: this.cfg.scene,
          sceneItemId,
          sceneItemEnabled: true,
        })
        this.visible = true
      }
      this.scheduleHide(holdMs ?? this.cfg.holdMs)
      return { ok: true }
    } catch (e) {
      // 降级：不崩、不影响主循环，只记一笔
      this.log(`${LOG_TAG} 显示失败（降级）：${(e as Error).message}`)
      return { ok: false, reason: (e as Error).message }
    }
  }

  /** 立刻收起（到点自动调；也可手动） */
  async hideArt(): Promise<void> {
    this.clearTimer()
    if (!this.cfg || !this.visible) return
    try {
      const sceneItemId = await findItemId(this.cfg.scene, this.cfg.source)
      await sharedObsClient.request('SetSceneItemEnabled', {
        sceneName: this.cfg.scene,
        sceneItemId,
        sceneItemEnabled: false,
      })
      this.visible = false
      this.log(`${LOG_TAG} 已收起 ${this.cfg.source}`)
    } catch (e) {
      this.log(`${LOG_TAG} 收起失败（降级）：${(e as Error).message}`)
    }
  }

  /** 重置自动隐藏计时器（新单进来时旧计时作废） */
  private scheduleHide(ms: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.hideArt()
    }, ms)
    // 不阻塞进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.clearTimer()
  }
}
