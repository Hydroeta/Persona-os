# THIRD-PARTY-NOTICES

本仓库为「persona-os」的源码与配置整理版。自有代码以 MIT 发布（见 `LICENSE`），
下列第三方组件保留各自许可证与版权。本文件是**唯一的第三方归属清单**，按「使用方式」分三层：

| 层级 | 含义 | 处理方式 |
|---|---|---|
| A. 直接使用 | 原样集成，未改代码 | 保留原版权行 + 本清单条目 |
| B. 修改后分发 | 构成衍生作品 | 本清单声明修改性质/日期 + 文件头保留上游信息 |
| C. 运行时集成 | 不随仓库分发，由用户/安装脚本获取 | 列出源与许可，不承担再分发义务 |

仓库中**不包含**任何第三方二进制、模型权重、密钥或个人数据。

> **copyleft 提示**：本项目依赖 **AstrBot（AGPL-3.0）** 与 **NapCatQQ（GPL-3.0）**。
> 两者均以独立进程、标准接口（HTTP / OneBot 反向 WS）方式调用，本仓库未并入其源码、
> 未修改其代码；但再分发或对外提供服务前，请自行履行各自的 copyleft 条款。

---

## A. 直接使用的项目

| 项目 | 链接 | 许可证 | 版权行 | 使用方式 |
|---|---|---|---|---|
| AstrBot | https://github.com/AstrBotDevs/AstrBot | **AGPL-3.0** | 见上游 `LICENSE` | 消息框架与管理面板（`:6185`）；`ohwhale-deploy/plugins/` 下 5 个插件运行于其上。**独立进程调用，未修改、未随仓库分发其源码** |
| NapCatQQ | https://github.com/NapNeko/NapCatQQ | **GPL-3.0** | 见上游 `LICENSE` | QQ 协议端（OneBot 反向 WS `:6199`），消息收发链路。**以独立进程运行，本项目未链接其代码、未分发其二进制** |
| Ollama | https://github.com/ollama/ollama | MIT | 见上游 `LICENSE` | 本地模型推理服务（`:11434`），`llm_client` 端云路由的 local provider。**独立进程，用户自备** |
| Qwen2.5-1.5B-Instruct | https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct | Apache-2.0 | 见上游 `LICENSE` | Ollama 上的本地模型（群总结等低敏后台场景）。**模型权重由用户自行拉取，不随仓库分发** |
| whale-pod | https://github.com/ZelotsNullzwei/whale-pod | MIT | Copyright (c) 2026 WhalePod contributors | DSH 插件宿主，原样引用 |
| Tulpa `chatlocal` 模块 | https://github.com/fumingyang2004/Tulpa | MIT | `Copyright (c) 2026 Tulpa contributors` | QQ 侧本地聊天模块，原样保留（`Tulpa/Tulpa/chatlocal/`，适用上游根目录 MIT 许可） |

> 关于 Tulpa：其自有代码（含 `chatlocal/`、`desktop/`）以 MIT 发布，发行包中的 `Tulpa.exe` 为预编译产物，非闭源。
> 本仓库只保留 `chatlocal` 源码模块，**不包含** Tulpa 发行包及其捆绑的第三方依赖（websockets/BSD-3-Clause、
> dnspython/ISC、polylens-bilibili-mcp/Apache-2.0、Segno/BSD-3-Clause、WeChat reader/Apache-2.0、
> CPython/PSF、WebView2/Microsoft 条款等），其清单见上游 `doc/THIRD_PARTY.md`。

> 关于 copyleft 的边界：AstrBot 以 AGPL-3.0 发布，若使用者修改 AstrBot 并对外提供网络服务，
> 需按 AGPL 第 13 条向使用者提供修改后的源码；NapCatQQ 以 GPL-3.0 发布，本项目仅通过
> OneBot 协议与之通信，不构成衍生作品。上述结论为事实描述，不构成法律意见。

> 在线 API 服务（DeepSeek 对话、阿里云百炼·千问兜底、智谱 CogView 梦境配图、心知天气）均为
> 用户自备账号的远程调用，服务条款由各提供商决定；本仓库不含其 SDK 或代码，密钥仅存于本机
> DPAPI 保险库。

---

## B. 修改后分发（衍生作品）

### B1. ohwhale-deploy（哦鲸鲸部署包）

| 字段 | 内容 |
|---|---|
| 上游 | https://github.com/chauko0423/ohwhale-deploy（0.1.0a1 Alpha） |
| 许可证 | MIT |
| 版权行 | `Copyright (c) 2026 四季`（见 `ohwhale-deploy/LICENSE`，已原样保留；上游 `NOTICE` 亦原样保留在 `ohwhale-deploy/NOTICE`） |
| 修改性质 | 接入 `voice.states` 状态化参考音（`config/persona.json`）；在 `scripts/call_loop.py` 中让 `voice_extra()` 同步切换 `ref_audio_path` 与 `prompt_text`，并修正 `ROOT_DIR` 计算；若干配置项本地化 |
| 修改开始年份 | 2026 |
| 文件头处理 | `scripts/call_loop.py` 已前置本仓库版权行 + 修改说明；其余为 JSON/YAML 配置，按规范无法写入注释，修改事实统一记录于本清单 |
| 未改动部分 | `plugins/` 下 5 个 AstrBot 插件（bili_scroll、companion、qq_power、stickers、voice_picker）为上游原样代码，随 ohwhale 的 MIT 许可分发 |
| 上游已披露的 copyleft | 上游 `NOTICE` 已列明 AstrBot（AGPL-3.0，已核对原文一致）、GPT-SoVITS（MIT，`Copyright RVC-Boss`）、CameraEmulator（MIT，`Copyright 2026 Jean-Noël Haas (FinalAnalytics)`）、NapCatQQ（**GPL-3.0**，见上游 LICENSE）、FFmpeg（依构建配置）、python-build-standalone（CPython 3.12.15，PSF 等）、VB-CABLE（厂商条款），本清单与之保持一致 |

### B2. dsh-pet（桌宠）

| 字段 | 内容 |
|---|---|
| 上游 | https://github.com/MerZlin/dsh-pet-indesktop（MIT，`Copyright (c) 2026 Merzlin`） |
| 更上游 | https://github.com/PC2005-cloud/dsh-pet |
| 许可证 | MIT（`dsh-pet/LICENSE` 已保留上游版权行） |
| 修改性质 | 定制人设 `_internal/pet/persona_presets/*.json` 与菜单 `_internal/pet/menu_templates/*.json`；未修改其可执行文件，也未重新分发 exe 与 `_internal` 运行时 |
| 修改开始年份 | 2026 |
| 文件头处理 | 定制内容均为 JSON，无法写注释；修改事实记录于本清单 |

> **dsh-pet 素材署名与许可说明**：
> 本仓库 `dsh-pet/` 目录仅包含人设与菜单定制（JSON），**不包含角色形象素材文件**。
> 形象创作链与署名如下（引用或展示相关形象时请保留）：
>
> - 原始角色“溟月”：**B站 @上善无形**，CC BY-NC-SA 4.0
> - DeepSeek 女仆版二次设计：**B站 @ZipZipPipe**，CC BY-NC-SA 4.0，**不可商业化**
> - 形象来源另致谢：**B站 @这个刀子真甜**
> - 参考项目与动画素材作者：**B站 @浩瀚星空2005**
> - 余额部分参考：**B站 @月匠** 的项目
> - 贡献者：**B站 @快乐小咸鱼a**（灵动岛改动与优化）、**B站 @咕噜千鹤子**（语音功能）
>
> 上述形象素材**不适用 MIT 许可**；本仓库未再分发这些素材文件，仅在人设/菜单配置中引用其名称或标识。
> 使用者将本项目用于商业目的时，需自行评估上述 CC BY-NC-SA 4.0 素材的合规性；
> 本仓库仅以 MIT 分发自有代码，不对第三方素材的商业使用授予额外许可。
>
> 上游发行渠道：Windows 版可通过作者提供的夸克网盘获取；macOS 版请从
> `https://github.com/MerZlin/dsh-pet-indesktop/releases` 下载（网盘会吞 macOS 版 zip）。
> 素材生成教学参考 `https://github.com/PC2005-cloud/dsh-pet`；
> 桌宠素材生成交流 QQ 群：1104901951。

> MIT 只要求保留版权与许可声明，不要求公开修改源码；修改事实仍在此显式声明，避免「原样引用」的误导。

---

## C. 运行时集成（不随仓库分发）

### C1. DSH 核心包

| 组件 | 许可证 | 角色 |
|---|---|---|
| `@deepseek-ai/dsh`（CLI） | MIT | 插件运行时与 profile 管理 |
| `@deepseek-ai/cordis` 等 6 个包 | MIT | 插件容器、LLM 路由、凭据与启动环境 |

安装方式：`npm install @deepseek-ai/dsh`（见 `install/补齐组件.ps1`）。

### C2. DSH 免费渠道插件（14 家渠道）

| 插件 | 链接 | 许可证 | 角色 |
|---|---|---|---|
| dsh-our-free-model | https://github.com/Ebony-Vinyl/dsh-our-free-model | MIT | 提供 14 家免费模型渠道与本地 OpenAI 兼容网关；由 `install/补齐组件.ps1 -DshChannels` 装到用户机器的 `~/.dsh/profiles/web` |

- 本仓库**不分发**该插件代码，只提供安装脚本。14 个渠道指该插件内置的上游模型服务
  （OpenCode Zen、Kilo、GLM、Kimi 等），其服务条款由各提供商决定。
- EAC 协付类渠道需在桌面端登录 GitHub 并 Star 该仓库后由服务端放行。

### C3. 已在使用的 14 个 DSH 插件（均不随仓库分发）

仓库内只有 `dsh/home/cron-jobs.json` 与 `cordis.patch.yml` 两份**配置**，不包含下表任何插件代码。

| 插件 | 版本 | 许可证（已核实/标注情况） | 角色 |
|---|---|---|---|
| dsh-doyourweb | 0.1.6 | MIT（npm 标注） | 浏览器标签标注 + 桌面控制 |
| bili-vision | 0.2.0 | 未公开标注（以发布页为准） | B站视频证据给视觉模型 |
| dsh-knowledge-canvas | 0.4.5 | 未公开标注（以发布页为准） | 树状知识库 |
| SurfCore | 0.6.5 | MIT（`https://github.com/Mieksido/surfcore`） | QQ ↔ DSH 桥接 + QQ/B站合并插件 |
| dsh-douyin-whale | 0.1.0 | 未公开标注（以发布页为准） | 抖音运营 |
| dsh-bili-whale | 0.3.0 | 未公开标注（以发布页为准） | B站运营 |
| dsh-bili-humanism | 1.3.4 | 未公开标注（以发布页为准） | 人格训练 |
| meow-memory | 0.31.0 / npm 0.32.1 | MIT（npm 标注） | 七层跨会话记忆 |
| dsh-memory-board | 1.1.0 | 未公开标注（以发布页为准） | 文件记忆面板 |
| dsh-selfwake | 0.1.0 | 未公开标注（以发布页为准） | 主动开口闸门 |
| dsh-orb | 0.1.9 | MIT（npm 标注） | 悬浮球宿主 |
| cron-scheduler | 0.2.10 | MIT（npm 标注） | 定时任务 |
| mcp-tulpa | — | 未公开标注（以发布页为准） | 经 MCP 连接 Tulpa |
| llm-deepseek | — | 未公开标注（以发布页为准） | DeepSeek 模型接入 |
| dsh-image-gen | 0.10.0 | 未公开标注（以发布页为准） | 会话内文生图工具（多 provider） |

> **SurfCore 补充说明**：
> - B站插件灵感来源于 **B站 @凌羽clover**，特此致谢。
> - 本地语音包自带模型，体积较大；本仓库**不包含**这些模型文件，安装 SurfCore 时由 npm 包或用户自行获取。
> - 云端语音按字符计费，费用由第三方语音服务商收取，本项目不参与计费。
> - 上游作者注明“仅供个人学习研究使用”，本项目尊重该声明并建议使用者遵守所在平台规则。
> - SnowLuma 为第三方专有运行时，不随 SurfCore 或本项目分发，需从官方 Releases 自行获取。

> 表中"未公开标注"指其发布包未声明 SPDX 许可字段，需以插件发布页/作者说明为准；
> 本项目不复制、不再分发这些插件代码，因此不改变其许可状态。若后续将某个插件代码纳入仓库，
> 必须在此表中标注并按其许可证处理。

### C4. 其他外部组件

| 组件 | 许可证 | 说明 |
|---|---|---|
| GPT-SoVITS | MIT（`Copyright (c) 2024 RVC-Boss`） | 由 ohwhale-deploy 的钉版脚本下载源码与权重（约 1.24 GB），不入库；模型与素材另有各自条款 |
| SnowLuma | 专有软件 | 仅由安装脚本下载官方原包并校验 SHA256，不修改、不代跑；EULA 对自动化部署有限制 |
| Tulpa 可执行程序 | MIT（源码）/ 官方发行包 | 源码 MIT，发行包中的 exe 为预编译产物（非闭源），不随本仓库分发；仓库只含 `chatlocal` 源码，不含其捆绑的第三方依赖 |
| VB-CABLE | 捐赠版（Donationware） | 用户自行安装的虚拟声卡 |

---

## 文件头规范

- 本仓库自有 `.py` 文件统一带：
  ```text
  # Copyright 2026 Xiaojingyu AI Companion contributors
  # SPDX-License-Identifier: MIT
  ```
- 修改自第三方的文件（当前为 `ohwhale-deploy/scripts/call_loop.py`）采用「前置自有声明 + 保留上游信息」，
  不删除上游版权/许可文本。
- JSON / YAML 无法承载注释，其修改事实统一登记在 B 节。

## 许可证兼容性结论

- 本仓库**自有代码**以 MIT 发布。
- 第三方组件构成：**AstrBot 为 AGPL-3.0，NapCatQQ 为 GPL-3.0**；whale-pod、Tulpa（chatlocal）、
  ohwhale-deploy、dsh-pet、GPT-SoVITS、DSH 核心包、dsh-our-free-model 等为 MIT；SnowLuma 为专有软件（未再分发）。
- AGPL/GPL 组件以**独立进程 / 标准协议**方式集成，本仓库未并入或修改其源码，因此自有代码仍可按 MIT 发布；
  但使用者对外提供服务或再分发时，需自行遵守 AstrBot（AGPL-3.0）与 NapCatQQ（GPL-3.0）的条款。
- 上述为技术事实与许可文本的对应关系，不构成法律意见；商用或再分发前建议咨询专业意见。

## 许可文本位置

| 组件 | 许可文件 |
|---|---|
| 本仓库 | `LICENSE` |
| ohwhale-deploy | `ohwhale-deploy/LICENSE`、`ohwhale-deploy/NOTICE` |
| whale-pod | `whale-pod/LICENSE` |
| Tulpa chatlocal | `Tulpa/Tulpa/LICENSE` |
| dsh-pet | `dsh-pet/LICENSE` |
| AstrBot / NapCatQQ | 上游仓库 LICENSE（未随本仓库分发） |
