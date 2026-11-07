# persona-os V2

> 数字人直播 / 陪伴操作系统 —— 从 Python 单体进化为 **DSH 宿主 + TypeScript 插件层 + Python 微服务层** 的分布式 Monorepo。
> 让 AI 主播既能自动推进节目单、主动破冰、叫着老粉的名字互动，也能“看”到自己的屏幕在画什么。

[![DSH](https://img.shields.io/badge/runtime-DSH%20%28Cordis%29-7c3aed)](https://github.com/deepseek-ai/dsh)
[![pnpm](https://img.shields.io/badge/monorepo-pnpm-workspace-F69220)](https://pnpm.io)
[![license](https://img.shields.io/badge/license-MIT-green)](#许可证)

---

## 架构拓扑

```
                        ┌──────────────────────────────────────────────┐
                        │               DSH 宿主 (Cordis)              │
                        │   会话 / Agent 调度 / Web 服务器(:3080)        │
                        └───────────────┬──────────────────────────────┘
                                        │  ctx 注入 + 插件加载
                ┌───────────────────────┼────────────────────────┐
                │                       │                        │
        ┌───────▼────────┐      ┌───────▼─────────┐      ┌───────▼──────────┐
        │ TS 插件层 (9)  │      │  Python 微服务   │      │   外部能力        │
        │  plugins/*     │      │  core-services/* │      │                  │
        ├────────────────┤      ├─────────────────┤      ├──────────────────┤
        │ dsh-live-director│    │ memory  :8001   │      │ DeepSeek / Gemini │
        │   (弹幕WS:9001) │    │ painter :8002   │      │ Ollama (本地)     │
        │                 │    │ game-bot :8003  │      │ ViGEmBus 虚拟手柄 │
        │ dsh-persona-core│    │ IndexTTS2(由     │      │ QQ / QQ频道      │
        │ dsh-memory-bus │      │  service-manager│      │ NapCat / go-cqhttp│
        │ dsh-painter    │      └─────────────────┘      └──────────────────┘
        │ dsh-web-agent  │
        │ dsh-llm-router │
        │ dsh-service-mgr│
        │ dsh-self-play  │
        │ dsh-game-agent │
        └────────────────┘
```

**设计理念**：TS 管调度与交互（快、类型安全、易插件化），Python 管存储与重计算（生态成熟、复用现有模型封装），DSH 做宿主粘合。详见 [项目介绍.md](./项目介绍.md)。

---

## 核心亮点

- 🎬 **Rundown 自主直播**（`dsh-live-director`）：弹幕 WebSocket 接入 → 优先级队列（礼物>画图>对话）→ 状态机（闲聊 3min → 你画我猜 5min → 自由点单 5min 循环）→ 20s 心跳自动切环节 / 冷场破冰；观众记忆注入 System Prompt；命中“在干嘛/画了什么”自动截屏喂多模态视觉。
- 🌐 **Playwright 无头浏览器**（`dsh-web-agent`）：后台静默抓网页正文/链接/点击，**不抢占物理鼠标**，带超时防挂死。
- 🎭 **多角色热切换**（`dsh-persona-core`）：`switch_persona` 即时切换人格，回写 `active.json` 无需重启。
- 🖌️ **逐帧作画**（`dsh-painter`）：扫描线/网格遮罩逐帧显影，原子写入覆盖 OBS 监听图片，模拟人类手绘节奏，支持并发取消。
- 🔀 **LLM 智能路由**（`dsh-llm-router`）：长上下文/后台静默任务走本地 Ollama 省成本，主对话走 DeepSeek。
- 🧬 **人格自进化**（`dsh-self-play`）：每天 03:00 复盘角色近期回复，本地 Ollama 审查 AI 味 / 客服腔，提炼负向指令自动追加到 `config/personas/<id>/rules.json`（先备份再写入、去重、原子写）；Ollama 离线或 3s 超时时安全降级，绝不崩溃、绝不误写。
- 🎮 **虚拟手柄游戏代理**（`dsh-game-agent`）：截屏 → 多模态 VLM 决策下一步宏观动作 → HTTP 转发 game-bot 微服务（:8003）调 `vgamepad` 虚拟 Xbox 手柄；默认 `dry_run` 安全预览不操作手柄，Python 端 2s 看门狗无指令自动松杆防失控，任一环节离线/超时均安全降级不阻断 DSH。

---

## 快速开始

### 1. 环境准备

- Node.js ≥ 22，pnpm ≥ 9（开发环境实测 v12，`npm i -g pnpm`）
- Python 3.10+（微服务运行时）
- Windows 10/11（计划任务、DPAPI 密钥、OBS 集成均在 Windows 验证）

### 2. 安装与构建

```powershell
# 以下命令均在解压后的 persona-os 根目录执行（即本 README 所在目录）

# 安装 monorepo 全部依赖（含插件 esbuild 编译产物）
pnpm install

# 如需单独重编某个插件（例如刚改了源码）
cd plugins\dsh-live-director
node build.mjs
```

### 3. 配置

- 复制 [config/master.json](./config/master.json) 为你的运行配置（DSH 启动时合并）。
- 关键环境变量（可写进系统环境变量或 `.env`，DSH 会继承）：

  | 变量 | 默认值 | 说明 |
  |---|---|---|
  | `MEMORY_PORT` | `8001` | 记忆微服务端口 |
  | `PAINTER_PORT` | `8002` | 生图微服务端口 |
  | `GAME_BOT_PORT` | `8003` | 游戏手柄微服务端口（vgamepad + ViGEmBus） |
  | `INDEXTTS_PORT` | `9881` | IndexTTS2 端口 |
  | `IMAGE_PATH` | 空 | `dsh-painter` 写帧目标 PNG（OBS 图片源监听此路径） |
  | `DSH_LIVE_DIRECTOR_PORT` | `9001` | 直播弹幕 WebSocket 端口 |
  | `VISION_API_BASE` / `VISION_API_KEY` / `VISION_MODEL` | 空 | 多模态视觉（GLM-4V 等）；不配则画面感知静默降级 |
  | `LLM_ROUTER_OLLAMA_PROVIDER` | 空 | 配置后启用 LLM 路由对 `agent/request` 的透明拦截 |

### 4. 启动 DSH 并加载插件

```powershell
# 启动 DSH（它会按 dsh/home/cordis.patch.yml 拉起微服务 + 加载插件）
dsh up

# 查看已加载插件 / 工具
dsh plugin --profile web list
dsh tool list
```

> 每个插件根目录的 `cordis.patch.yml` 已声明为 DSH 可加载 bundle；首次加载可用：
> `dsh plugin --profile web add "<插件绝对路径>"`

### 5. 验证

```powershell
# 健康检查
curl http://127.0.0.1:8001/health   # 记忆微服务
curl http://127.0.0.1:8002/health   # 生图微服务
curl http://127.0.0.1:8003/health   # 游戏手柄微服务（driver_ready=true 表示 ViGEmBus 就绪）

# 往直播引擎推一条模拟弹幕（应触发 LLM 回复 + TTS 播报；TTS 接线进行中，当前为占位日志）
# 见 使用说明.md 的“测试直播弹幕”章节
```

---

## 目录结构

```
persona-os/
├─ plugins/                  # TS 插件层（DSH 加载）
│  ├─ dsh-live-director/     #   直播交互引擎（弹幕/状态机/记忆/视觉）
│  ├─ dsh-memory-bus/        #   记忆工具（调 :8001）
│  ├─ dsh-persona-core/      #   多人格热切换
│  ├─ dsh-painter/           #   逐帧作画
│  ├─ dsh-web-agent/         #   Playwright 无头浏览器
│  ├─ dsh-llm-router/        #   LLM 路由
│  ├─ dsh-service-manager/   #   微服务生命周期
│  ├─ dsh-self-play/         #   人格自进化（半夜复盘去 AI 味）
│  └─ dsh-game-agent/        #   游戏代理大脑（截屏→VLM→虚拟手柄 :8003）
├─ core-services/            # Python 微服务层
│  ├─ memory/   main.py      #   记忆存取 :8001
│  ├─ painter/  main.py      #   生图 :8002
│  └─ game-bot/ main.py      #   虚拟手柄 :8003（vgamepad + ViGEmBus）
├─ dsh/                      # DSH 工作区（home/cordis.patch.yml）
├─ config/                   # master.json / personas / 密钥占位
├─ Tulpa/                    # 副人格 Tulpa（独立进程 / MCP）
├─ ohwhale-deploy/           # QQ 语音通话直播（live_bot / call_loop）
├─ README.md                 # 本文件
├─ 使用说明.md                # 运行与功能使用手册
├─ 项目介绍.md                # 设计理念与路线图
├─ THIRD-PARTY-NOTICES.md    # 第三方开源声明
└─ V2-MIGRATION-NOTES.md     # V1→V2 迁移说明（V1 文档已移除，历史见 git 提交记录）
```

---

## 端口清单

| 端口 | 服务 | 说明 |
|---|---|---|
| `3080` | DSH Web 服务器 | 插件 Web 路由挂载点 |
| `8001` | Memory 微服务 | 记忆存取（`/remember` `/recall`） |
| `8002` | Painter 微服务 | 生图（`/generate`） |
| `8003` | GameBot 微服务 | 虚拟手柄（`/action` `/health` `/reset`，vgamepad + ViGEmBus） |
| `9001` | Live Director WS | 直播弹幕接入 |
| `9881` | IndexTTS2 | TTS（由 service-manager 拉起） |
| `11434` | Ollama | 本地 LLM（可选） |
| `8080` | Tulpa MCP | 副人格 MCP（可选，`TULPA_MCP_URL`） |

---

## 文档

- [使用说明.md](./使用说明.md) — 启动顺序、端口、各功能用法、V1 遗留处理
- [项目介绍.md](./项目介绍.md) — “TS 壳 + Python 核”设计理念、项目结构、路线图
- [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) — 第三方开源库与协议声明
- [V2-MIGRATION-NOTES.md](./V2-MIGRATION-NOTES.md) — V1 到 V2 的迁移记录

---

## 许可证

MIT License，见 [LICENSE](./LICENSE)。使用的第三方开源组件协议见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)；其中 **AstrBot 为 AGPL-3.0**、**NapCatQQ 为 GPL-3.0**，各自的 copyleft 边界在该文件 A 节说明，使用前请先阅读。
