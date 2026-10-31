# persona-os

可私有部署的多角色 AI Agent 操作系统。集成统一拓扑控制台、端云协同推理、独立记忆隔离与端侧情境感知。

把 QQ / 微信式聊天、语音通话、桌宠、直播弹幕、记忆与日程、成本闸门与统一控制台拼在一起，
强调「可运维」而不只是「能聊天」。多角色通过 `config/personas/` 正本 + 物化视图实现静默热切换
（`tools/persona_switch.py`，零 LLM 调用），各角色人格、声音状态与情绪存档相互隔离。

> 本仓库是**源码与配置**的整理版：不含任何第三方二进制、模型权重、密钥、聊天记录或用户数据。
> 运行时需要自行准备文末列出的外部组件。

## 能做什么

| 模块 | 能力 |
|---|---|
| 控制台 `console.py` | 服务拓扑启动、就绪探针、健康守护、密钥保险库、指标面板、自检（纯标准库） |
| 多角色 | `config/personas/` 多角色正本 + 激活指针，静默热切换（零 LLM 调用），状态/记忆按角色隔离 |
| 语音通话 | 本地 ASR + IndexTTS2 零样本音色克隆（默认引擎，可切回遗留 GPT-SoVITS，`services.tts_engine` 一键切换），按情绪/精力切换参考音（`config/persona.json` 的 `voice.states`）|
| 聊天接入 | QQ 双协议端（Tulpa←SnowLuma 注入桌面 QQ；哦鲸鲸←NapCat 便携 QQ）、AstrBot 插件、B 站与抖音弹幕回复 |
| 桌宠 | 桌面角色（基于 dsh-pet 的定制人设与菜单 + 自建 mortis-pet（源码随仓库）；均**可选**，缺失不影响其他服务） |
| 记忆与关系 | 目标、时间胶囊、日记回顾、日历提醒、关心心跳、记忆总线 |
| 成本与资源 | LLM token 闸门、场景配额、端云路由（Ollama 本地免费 / DeepSeek 主用 / 千问兜底）、GPU 互斥租约、搜索网关、日报 |
| 工具集 | `tools/` 40+ 个纯标准库模块；`tests/` 117 项冒烟测试 |

## 目录

```
console.py / 控制台.cmd      控制台入口
一键安装.cmd                安装入口（调用 install/安装.ps1）
config/                     配置单一事实源（密钥只进本机 DPAPI，不落盘明文）
tools/                      工具模块（含 pet_adapters/ 桌宠适配器子目录）
tests/                      冒烟测试
ohwhale-deploy/             语音/聊天部署包（第三方，含本人改动）
whale-pod/                  DSH 插件宿主（MIT）
dsh/                        DSH 定时任务与工作区配置
dsh-pet/                    桌宠人设与菜单定制（JSON）
mortis-pet/                 自建第二桌宠源码（PySide6；素材 videos/ 与台词 config.json 自备不入库，附 config.example.json 模板）
Tulpa/Tulpa/chatlocal/      Tulpa 本地聊天模块
install/                    安装脚本（基础环境 + 组件依赖）
使用说明.md / 项目介绍.md     详细文档
THIRD-PARTY-NOTICES.md     第三方归属、许可证与修改声明（唯一清单）
```

## 快速开始

```powershell
.\控制台.cmd                # 启动控制台（唯一入口），浏览器打开打印的带 token 链接
python tests/test_smoke.py  # 117 项冒烟测试
```

一键装基础环境（Node / Python / pnpm / ffmpeg）与包内依赖：双击 `一键安装.cmd`。

## 需要自行准备

| 组件 | 用途 | 获取方式 |
|---|---|---|
| IndexTTS2 环境 + 模型 | 默认 TTS 引擎（本地 HTTP 合成 :9881，零样本克隆） | 官方仓库自建 `index-tts/` 环境（Python 3.11 + torch），权重默认放 `C:\idx_models`（纯 ASCII 路径），见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) C4 |
| GPT-SoVITS 运行时 + 模型（遗留可选） | 旧版 TTS 引擎（主链路已迁 IndexTTS2，保留作可切换备选） | 按 `ohwhale-deploy` 的脚本自行下载，下载约 4 GB（安装后含独立 venv 与 PyTorch 共约 9.8 GB） |
| Tulpa | QQ 客户端集成 | 官方 Releases（源码 MIT，发行包含预编译 exe；`chatlocal` 源码随仓库保留） |
| Ollama + Qwen2.5-1.5B（可选） | 本地免费推理 provider（端云路由的 local 端） | `ollama pull qwen2.5:1.5b` |
| SnowLuma | Tulpa 号 QQ 协议端 | 官方 Releases（专有软件，需同意其 EULA） |
| dsh-pet | 桌宠可执行程序（老桌宠，含事件播报通道） | 上游 Releases（本仓库只含人设/菜单，见 NOTICES B2） |
| mortis-pet 源码 + mortis 素材 | 第二桌宠（独立展示型，无事件通道） | 源码随仓库提供（`mortis-pet/`，PySide6）：先 `pip install -r mortis-pet/requirements.txt`（打包另需 `pip install pyinstaller`），再用 PyInstaller 按 `mortis-pet.spec` 打包；运行另需 ffmpeg（放 `~/.local/bin/ffmpeg.exe` 或入 PATH）；视频素材（`mortis-pet/videos/`，VP9 透明底）与台词文件（`mortis-pet/config.json`，整理自 Ave Mujica 动画及二创，不适用 MIT）均自备不入库，仓库只含 `config.example.json` 模板（见 NOTICES B2） |
| DSH 核心 | 插件运行时 | `npm i @deepseek-ai/dsh`，免费渠道插件见 `dsh-our-free-model` |
| API Key | 对话与视觉 | 自备 DeepSeek / DashScope 账号 |
| AstrBot（AGPL-3.0） | 消息框架与面板 | 由 ohwhale-deploy 安装，源码从上游获取 |
| NapCatQQ（GPL-3.0） | QQ 协议端 | 官方 Releases，独立进程运行 |

## 隐私与脱敏

仓库内所有路径、账号、密钥字段均已替换为占位符；`.env`、数据库、会话记录、参考音、
日志与缓存一律不入库（见 `.gitignore`）。控制台的密钥写入本机 DPAPI 保险库。

## 来源与致谢

- 桌宠代码基于 `https://github.com/MerZlin/dsh-pet-indesktop`（MIT），
  其上游为 `https://github.com/PC2005-cloud/dsh-pet`。
  **角色形象素材**的创作者为 B站 @上善无形（原始角色“溟月”，CC BY-NC-SA 4.0）、
  B站 @ZipZipPipe（DeepSeek 女仆版二次设计，CC BY-NC-SA 4.0，不可商业化）、B站 @这个刀子真甜；
  动画素材作者 B站 @浩瀚星空2005，余额部分参考 B站 @月匠 的项目；
  贡献者 B站 @快乐小咸鱼a（灵动岛改动与优化）、B站 @咕噜千鹤子（语音功能）。
  本仓库仅包含人设与菜单定制（JSON），**未重新分发素材或二进制**，素材不适用 MIT 许可。
  另含第二形象 **mortis（若叶睦）**：素材渲染自游戏 Live2D 资源 `adv_live2d_mutsumi_007_live_01`，
  权利归原作方（BanG Dream! 项目相关权利方）所有，仅限个人非商业使用，**自备不入库**；其桌宠载体为项目自建的
  mortis-pet（PySide6，源码随仓库 `mortis-pet/`）。**mortis-pet 的台词文本整理自《Ave Mujica》动画及部分二创，
  不适用 MIT、不随仓库分发**（见 NOTICES B2）。mortis 同时是第二个 persona（`config/personas/mortis/`，
  语音链路走 IndexTTS2），详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) B2。
- 语音/聊天部署包来自 `https://github.com/chauko0423/ohwhale-deploy`（MIT）。
- SurfCore（MIT，`https://github.com/Mieksido/surfcore`）的 B站插件
  灵感来源于 B站 @凌羽clover，特此致谢；其本地语音模型不随本仓库分发。
- Tulpa（`chatlocal` 源码 MIT，`https://github.com/fumingyang2004/Tulpa`）
  的本地聊天模块随仓库保留；其发行包与 `Tulpa.exe` 需自行从官方 Releases 获取，本仓库未重新分发。
- 消息框架 AstrBot（AGPL-3.0）与 QQ 协议端 NapCatQQ（GPL-3.0）以独立进程集成，
  详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 的 A 节。
- 全部第三方组件（直接使用 / 修改后分发 / 运行时集成）的许可证、版权行、修改声明与素材署名，
  集中在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 许可

本仓库自有代码以 MIT 发布（见 `LICENSE`）；第三方组件保持各自许可。

**注意 copyleft 组件**：消息框架 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 为 **AGPL-3.0**，
QQ 协议端 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 为 **GPL-3.0**。
两者以独立进程 / OneBot 协议集成，本仓库未修改、未分发其源码；对外服务或再分发前请自行遵守其条款。
其余组件许可与完整版权行见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 免责声明

软件驱动的虚拟角色，不冒充现实个人，不用于医疗、法律或紧急服务。QQ 协议端可能触发平台风控，
账号风险自负；建议使用小号并遵守各平台用户协议。
