/**
 * fan-art.ts —— 粉丝头像交付（QQ hook 占位）
 *
 * 现在没有可用的 QQ 主动发图接口，这里只留一个**结构完整、可注入**的空壳：
 *   · 默认实现只打一行 `[QQ Hook] 准备将 <路径> 发送给 <用户>`
 *   · 想接协议端时，用 `setFanArtSender(fn)` 注入真实实现即可，**调用方一行都不用改**
 *   · 任何异常都在内部吞掉：交付失败不能把作画链路带崩
 */
import { existsSync } from 'node:fs'

const LOG_TAG = '[dsh-live-director/fan-art]'

export type FanArtSender = (userId: string, filePath: string) => Promise<boolean>

let sender: FanArtSender = async (userId, filePath) => {
  // TODO(QQ)：接协议端后，在这里调用"私聊发图"接口。
  //   需要先确认：① 协议端是否暴露 HTTP/WS 发图；② 图片要不要先上传拿 file_id；
  //   ③ 粉丝的 QQ 号从哪来（弹幕只有昵称，得先有昵称→QQ 的映射）。
  console.log(`${LOG_TAG} [QQ Hook] 准备将 ${filePath} 发送给 ${userId}`)
  return false
}

/** 替换实现（接入真实协议端时调用） */
export function setFanArtSender(fn: FanArtSender): void {
  sender = fn
}

/** 交付一张头像给粉丝。永不抛异常。 */
export async function sendFanArtToQQ(userId: string, filePath: string): Promise<boolean> {
  if (!userId || !filePath) return false
  if (!existsSync(filePath)) {
    console.error(`${LOG_TAG} 文件不存在，跳过交付：${filePath}`)
    return false
  }
  try {
    return await sender(userId, filePath)
  } catch (e) {
    console.error(`${LOG_TAG} 交付失败（不影响作画）：${(e as Error).message}`)
    return false
  }
}
