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
| 语音通话 | 本地 ASR + GPT-SoVITS 音色克隆，按情绪/精力切换参考音（`config/persona.json` 的 `voice.states`）|
| 聊天接入 | QQ（Tulpa / SnowLuma 协议端）、AstrBot 插件、B 站与抖音弹幕回复 |
| 桌宠 | 桌面角色（基于 dsh-pet 的定制人设与菜单） |
| 记忆与关系 | 目标、时间胶囊、日记回顾、日历提醒、关心心跳、记忆总线 |
| 成本与资源 | LLM token 闸门、场景配额、GPU 互斥租约、搜索网关、日报 |
| 工具集 | `tools/` 40+ 个纯标准库模块；`tests/` 92 项冒烟测试 |

## 目录

```
console.py / 控制台.cmd      控制台入口
一键安装.cmd                安装入口（调用 install/安装.ps1）
config/                     配置单一事实源（密钥只进本机 DPAPI，不落盘明文）
tools/                      工具模块
tests/                      冒烟测试
ohwhale-deploy/             语音/聊天部署包（第三方，含本人改动）
whale-pod/                  DSH 插件宿主（MIT）
dsh/                        DSH 定时任务与工作区配置
dsh-pet/                    桌宠人设与菜单定制（JSON）
Tulpa/Tulpa/chatlocal/      Tulpa 本地聊天模块
install/                    安装脚本（基础环境 + 组件依赖）
使用说明.md / 项目介绍.md     详细文档
THIRD-PARTY-NOTICES.md     第三方归属、许可证与修改声明（唯一清单）
```

## 快速开始

```powershell
python console.py          # 打开 http://127.0.0.1:8900 ，按提示填密钥
python -m unittest discover -s tests -v
```

一键装基础环境（Node / Python / pnpm / ffmpeg）与包内依赖：双击 `一键安装.cmd`。

## 需要自行准备

| 组件 | 用途 | 获取方式 |
|---|---|---|
| GPT-SoVITS 运行时 + 模型 | 本地语音合成与音色克隆 | 按 `ohwhale-deploy` 的脚本自行下载，约 4 GB |
| Tulpa | QQ 客户端集成 | 官方 Releases（源码 MIT，发行包含预编译 exe；`chatlocal` 源码随仓库保留） |
| SnowLuma | QQ 协议端 | 官方 Releases（专有软件，需同意其 EULA） |
| dsh-pet | 桌宠可执行程序 | 上游 Releases（本仓库只含人设/菜单） |
| DSH 核心 | 插件运行时 | `npm i @deepseek-ai/dsh`，免费渠道插件见 `dsh-our-free-model` |
| API Key | 对话与视觉 | 自备 DeepSeek / DashScope 账号 |
| AstrBot（AGPL-3.0） | 消息框架与面板 | 由 ohwhale-deploy 安装，源码从上游获取 |
| LuckyLillia（GPL-2.0） | QQ 协议端 | 官方 Releases，独立进程运行 |

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
- 语音/聊天部署包来自 `https://github.com/chauko0423/ohwhale-deploy`（MIT）。
- SurfCore（MIT，`https://github.com/Mieksido/surfcore`）的 B站插件
  灵感来源于 B站 @凌羽clover，特此致谢；其本地语音模型不随本仓库分发。
- Tulpa（`chatlocal` 源码 MIT，`https://github.com/fumingyang2004/Tulpa`）
  的本地聊天模块随仓库保留；其发行包与 `Tulpa.exe` 需自行从官方 Releases 获取，本仓库未重新分发。
- 消息框架 AstrBot（AGPL-3.0）与 QQ 协议端 LuckyLillia（GPL-2.0）以独立进程集成，
  详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 的 A 节。
- 全部第三方组件（直接使用 / 修改后分发 / 运行时集成）的许可证、版权行、修改声明与素材署名，
  集中在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
## 许可

本仓库自有代码以 MIT 发布（见 `LICENSE`）；第三方组件保持各自许可。

**注意 copyleft 组件**：消息框架 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 为 **AGPL-3.0**，
QQ 协议端 [LuckyLillia](https://github.com/LLOneBot/LuckyLilliaBot) 为 **GPL-2.0**。
两者以独立进程 / OneBot 协议集成，本仓库未修改、未分发其源码；对外服务或再分发前请自行遵守其条款。
其余组件许可与完整版权行见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 免责声明

软件驱动的虚拟角色，不冒充现实个人，不用于医疗、法律或紧急服务。QQ 协议端可能触发平台风控，
账号风险自负；建议使用小号并遵守各平台用户协议。
