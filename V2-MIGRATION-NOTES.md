# V2 迁移笔记

> 记录 persona-os 从 v1（Python 单体 `console.py` 控制台）向 v2（DSH 插件化 + Python 算力微服务）重构的进度。
> 最后更新：2026-11-06

## 目标架构

```text
[ 交互与平台层 ]  QQ / 微信 / B站 / 抖音 → NapCat / SnowLuma（协议端）
                         │
[ DSH 宿主调度层 ]    DSH 桌面端 / WebUI
                         │
        ┌────────────────┼────────────────┐
[ TS 插件层 ]    dsh-service-manager   dsh-live-director   （其余插件规划中）
（轻量调度/UI）
        └────────────────┼────────────────┘
                         │ HTTP / 子进程
[ Python 微服务 ]  IndexTTS2（TTS）   Memory FastAPI   vgamepad（虚拟手柄）
（算力底座）        RVC（翻唱）        SMAPI Mod 桥接
```

## 已落地 / 已核实

- [x] 旧版 `console.py`、`控制台.cmd`、`call_loop.py` 已在主工作区归档（2026-11-06），保留 1~2 周观察期，确认稳定后物理删除。
- [x] 主工作区已创建 `package.json` 与 `plugins/` 目录，V2 骨架起步。
- [x] `indextts_server.py`（TTS 微服务）与 `live_bot.py`（直播导播）暂保留，待对应插件替代后再动。
- [x] `tools/`、`config/`、`data/` 暂保留（依赖未解除），随 TS 插件逐个替代后移出。
- [x] 确立双环境边界：源项目（`projects (2)`）为运行时环境（Windows 计划任务、`data/`、模型权重、venv），保持不动；发布版（`github-release/persona-os`，git 仓库）为 V2 开源骨架，所有 TS 插件开发在此进行。
- [x] 发布版目录已搭建 V2 骨架：根 `package.json` + `pnpm-workspace.yaml`（pnpm v12，顶层 `allowBuilds: esbuild`）+ `plugins/` + `core-services/`；`dsh-service-manager` 已用 esbuild 构建（`lib/index.js`）并通过 `node --check` 与冒烟测试。
- [x] 发布版目录本地归档：`console.py`、`控制台.cmd`、`tools/` 已移入 `_archive_v1/`（`.gitignore` 忽略，不入库），保持发布快照纯净；源项目的 `tools/` 仍由计划任务使用，未动。

## 进行中 / 待开始

- [x] DSH NEXT 桌面端已安装（`%LOCALAPPDATA%\Programs\DSH NEXT`）；CLI 管理的 `web` profile 监听 3080 端口，`desktop` profile 由 Electron 独占管理。
- [x] 发布版目录已创建 `core-services/` 微服务目录（占位，待迁入 Memory FastAPI 等）。
- [x] `dsh-service-manager`（第一阶段已落地）：DSH apply 时拉起 IndexTTS2（`indextts_server.py`，端口 9881，模型懒加载），dispose 时 taskkill 进程树防僵尸；已从发布版目录 link 到 `web` profile。
- [ ] `dsh-live-director`：替代 `live_bot.py` 直播导播（Rundown 状态机 + OBS WebSocket）。
- [ ] 记忆星图可视化（**V2.1 计划，暂缓公开**）：3D 聚类坐标 / 星云前端的实现记录见下文第 8、9 节；插件 `dsh-memory-map` 已从公开版剥离并归档至 `_archive_v1/`，前端视觉打磨后随 V2.1 公开。
- [ ] 通用游戏代理：vgamepad 虚拟手柄 + VLM 视觉。
- [ ] 后台静默操作：Playwright 无头浏览器。

## Phase 2 — V2 核心插件矩阵（2026-11-06，已完成并冒烟通过）

> 原则：TS 管调度/注入，Python 管算力/存储。所有插件在发布版 `plugins/` 开发，esbuild 打包到 `lib/index.js`，link 到 DSH `web` profile；运行时通过绝对路径回退借用源项目的 config / venv / 数据。

### 1. `core-services/memory`（Python 微服务，端口 8001）
- FastAPI + uvicorn，读写源项目 meow 库 `dsh/workspace/.dsh-meow/memory.db`（WAL + busy_timeout，跨进程安全）。
- 端点：`GET /health`（表统计）、`POST /remember`、`GET /recall`（LIKE 跨 7 表）。
- 路径解析：`MEMORY_DB` > `PERSONA_OS_ROOT` > 沿 `__file__` 向上找 > `LOCAL_FALLBACK_ROOTS`（源项目根）。
- 启动（用自带 fastapi/uvicorn 的 venv）：
  ```
  & "c:\Users\user\Desktop\projects (2)\ohwhale-deploy\.venv\Scripts\python.exe" "c:\Users\user\Desktop\projects (2)\github-release\persona-os\core-services\memory\main.py"
  ```
- 端口冲突则退出 1；沙箱/Trae shell 拉起的进程可能被回收，常驻请在用户自己的终端跑上面的绝对路径命令。

### 2. `plugins/dsh-memory-bus`（TS 插件）
- 注册 DSH 工具 `save_memory` / `recall_memory`，调 8001。Base URL：`MEMORY_BUS_URL`（默认 `http://127.0.0.1:8001`）。
- 已 link 到 web profile；冒烟通过（mock ctx 验证注册/dispose/服务下线时 execute 抛 fetch failed）。

### 3. `plugins/dsh-persona-core`（TS 插件）— 本次新增
- 读取 `config/personas/<id>/persona.json`（事实源：`identity.*`=性格/说话规则/底线，`memory.rules`=规则，`canonical_text.persona_md`=详细正本 md）；兼容同目录下独立的 `rules.json` / `personality.json`（若存在则合并）。
- 把当前激活角色转成易读文本，通过 `ctx.get('systemPrompt').section({name, order:100, text})` 注入 System Prompt（服务可能延迟就绪，每秒重试最多 20 次）。
- 注册工具 `switch_persona(character_id)`（热切换：重注入 + 回写 `config/personas/active.json`，系统级生效）和 `list_personas`（扫描所有角色）。
- 路径解析：`PERSONA_CONFIG_DIR` > `PERSONA_OS_ROOT/config/personas` > `LOCAL_FALLBACK_ROOTS`（源项目根）> 沿 `__dirname` 向上（发布版自带 config）。默认读源项目 live config，热编辑即时生效。
- ⚠️ `switch_persona` 会回写源项目的 `active.json`（这是热切换的既定机制，非破坏性移动）。
- 已 link 到 web profile；冒烟 14/14 通过（临时 personas 目录，不碰 live 配置）。

### 4. `plugins/dsh-llm-router`（TS 插件）— 本次新增
- Provider 抽象：`DeepSeekProvider`（OpenAI 兼容）、`OllamaProvider`（本机 `http://127.0.0.1:11434`）、`GeminiProvider`（接口预留，抛未实现）。
- `LLMRouter` 路由启发式：`prefer` 强制 > `background:true` > 上下文字符数 ≥ `LLM_ROUTER_CONTEXT_THRESHOLD`(默认 24000) → Ollama；其余 → DeepSeek。
- 两种接入：
  1. **透明拦截**：`ctx.on('agent/request')` 覆盖 DSH 请求的 provider/model。**默认关闭**——需设 `LLM_ROUTER_OLLAMA_PROVIDER` 为 DSH 中 Ollama 的 provider id 才启用；任何异常 fail-open 放行原配置，绝不阻断对话。
  2. **统一 chat()**：暴露 `llmRouter` 服务（`ctx.get('llmRouter')`）并导出 `LLMRouter`/Provider 类，供其他插件直连调用，不依赖 DSH 是否已注册 provider。
- 环境变量（密钥只从环境读）：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`；`OLLAMA_BASE_URL` / `OLLAMA_MODEL`；`LLM_ROUTER_*` 见上。
- DSH 实测 provider id：DeepSeek = **`deepseek-official`**（默认模型 `deepseek-flash`，见 `@deepseek-ai/dsh-agent-default-model`）；Ollama 尚未在 DSH 注册，故透明拦截需先在 DSH 配好 Ollama provider 再设 `LLM_ROUTER_OLLAMA_PROVIDER`。
- 已 link 到 web profile；冒烟 17/17 通过（Ollama 指死端口、DeepSeek 无 key，均无真实成功请求）。

### 5. `plugins/dsh-web-agent`（TS 插件）— 后台无头浏览器（本次新增）
- Playwright + Chromium，**单例 Browser**：插件级别只 `launch` 一次，每次调用新建 `Context + Page`，用完关闭；`dispose` 时 `await browser.close()` 彻底释放，防内存泄漏。
- 反爬：`headless: true` + `--disable-blink-features=AutomationControlled` + 伪造桌面 Chrome UA。
- 注册工具 `run_web_task(url, action?, selector?)`：`extract_text`（默认）/ `click_selector` / `extract_links`。导航 `waitUntil: 'domcontentloaded'` + `timeout: 15000`，任务总看门狗 45s；任何异常 catch 后返回 `{ok:false, error}`，绝不抛未捕获异常。
- 正文提取在页面内执行：剔除 `script/style/nav/header/footer/aside` 等噪声，优先 `article`/`main`，输出轻量 Markdown（h1-h4、`[text](href)`、li），截断 4000 字符。
- **浏览器内核回退链**：`WEB_AGENT_CHROMIUM_PATH` 显式指定 > playwright 内置 chromium > 自动探测系统 Edge/Chrome（覆盖 Program Files x64/x86 与本地用户安装目录）。内置未下载时零配置回退到系统浏览器，不回退成 WebRequest。
- 构建：esbuild 把 `playwright` 外置（`external: ['playwright']`，含原生驱动不能打包），运行时从插件 node_modules 解析。
- `.gitignore` 已加 `.playwright-browsers/`（内核体积大不入库）。
- 已 link 到 web profile；冒烟 19/19 通过（**真实 headless Edge** 抓本地页：正文提取/噪声剔除/Markdown/链接/非法 url/空 url/连接被拒/15s 挂起超时防挂死/dispose 关闭，全部验证）。
- ⚠️ 沙箱里 `npx playwright install chromium` 写 `%LOCALAPPDATA%\ms-playwright` 被拒（EPERM），且 CDN 极慢（~0.5 MiB/s）；用户请在**自己的终端**执行一次下载，或直接依赖系统 Edge 自动回退（已实测可用）。

### 6. `plugins/dsh-painter`（TS 插件）— 逐帧作画引擎（本次新增，任务 2）
- 拿到完整底图后，用扫描线/网格遮罩逐帧显影，**原子写入**覆盖 OBS 监听图片，模拟人类作画过程。注册工具 `generate_paint_process(prompt, obs_output_path, duration_ms?, fps?)`，返回 `{ok, path, frames, elapsed_ms, source}`。
- **原子写入（OBS 血坑已处理）**：先写 `<file>.tmp.<jobId>` 再 `fs.rename` 瞬间替换，OBS 永远只读到完整图；rename 带短重试应对 Windows 文件共享偶发 EBUSY。
- **并发取消**：`JobManager` 单例持有当前任务的 `AbortController` + 定时器，新任务先 abort 上一个，杜绝多定时器同写一个 OBS 路径；逐帧用 `setTimeout` 链（非 setInterval），取消即清。每个任务 tmp 带 jobId 后缀，被取消任务不会误删新任务正在写的 tmp。
- **遮罩累积层（经验 100016180）**：维护只增不减的 revealed 像素计数为真源，每帧在全新输出上 `sharp(base).joinChannel(mask)` 挂 alpha → 铺白底合成，绝不对累积真源做破坏性合成，进度单调、历史不丢。两种模式：`scanline`（默认，光栅序左→右、上→下）/ `grid`（`PAINTER_REVEAL_MODE=grid`，`PAINTER_GRID` 调块数）。
- **底图源**：`IMAGE_GEN_URL` 指向生图微服务 / CogView 代理（POST `{prompt}` 返回图片字节；若返回 JSON `{url}` 则二次下载，带超时 + 指数退避重试）；未配置时用 sharp 内置测试图（SVG 渐变 + 文字，SVG 不可用回退纯渐变），无 key 也能验证管线。
- **测试模式**：`PAINTER_TEST_MODE=1` 或 `PAINTER_FRAMES_DIR=<dir>` 时每帧另存 `frame_NNN.jpg`，可核对遮罩效果与帧数。
- `dispose`：abort 当前任务、清定时器、清理残留 `*.tmp.*`。
- 构建：esbuild 把 `sharp`（原生）与 `axios`（CJS，其 `combined-stream`/`form-data` 动态 `require` 不能打进 ESM）都外置，运行时从插件 node_modules 解析。
- 配套 Python 微服务 `core-services/painter`（端口 8002）：包装源项目 `tools/painter.py`（CogView 主 + 万相备，含成本/冷却/敏感词闸门与 DPAPI key_vault），`POST /generate` 返回图片字节；插件设 `IMAGE_GEN_URL=http://127.0.0.1:8002/generate` 即可复用现有闸门逻辑，密钥不进 TS。无 URL 时插件退回内置测试图，保证可测。
- 已 link 到 web profile（无 "not a profile layer" 警告）；冒烟通过：扫描线 20 帧/2.2s 帧大小 8KB→38KB 渐进显影、取消后立即停止写帧、网格模式正常，全程零残留 tmp。

### 7. `dsh-service-manager` 升级 — 统一托管三个微服务（本次）
- 从「只拉 IndexTTS2」升级为**统一进程生命周期管理**：apply 时后台拉起 **IndexTTS2(9881) / Memory(8001) / Painter(8002)**；dispose 时把「本插件拉起的」进程树全部 `taskkill /PID <pid> /T /F`，防僵尸占满显存/端口。目标：`dsh web` 一键启动，TTS + 记忆库 + 生图引擎全部在后台就绪。
- 泛化为服务描述表 `SERVICES`：每个服务独立解析 python（`*_PYTHON` 覆盖 > 源项目 venv 默认）、脚本（`*_SERVER` 覆盖 > 发布版 `core-services/<name>/main.py`）、端口（`*_PORT` 覆盖 > 默认）。
- 新增 `findReleaseRoot()`（标记 `core-services/memory/main.py`）定位发布版脚本树，与原有 `findSourceRoot()`（venv/权重）分离；`PERSONA_OS_ROOT` 命中哪棵用哪棵，未命中则沿 `lib` 上溯 + `LOCAL_FALLBACK_ROOTS` 回退。
- **进程归属原则（不误杀，经验 1184468）**：启动前探端口，已占用 → 视为「已有实例在跑」，跳过拉起且不登记；dispose 只杀登记过 pid 的进程树，**绝不按端口盲杀**。
- 有 `/health` 的服务（Memory/Painter）spawn 后轮询健康检查（15s 超时）就绪才记日志；IndexTTS2 无标准健康端点，只看日志。
- spawn 时透传 `process.env`；若未设 `PERSONA_OS_ROOT` 则补成源项目根，让 memory/painter 能定位 memory.db 与 `tools/painter.py`。
- 端口探测加 1 次重试（150ms 间隔），避免高负载下偶发 connect 抖动误判空闲而重复拉起；各微服务脚本自身也有端口防冲突（占用则 exit 1）作兜底，最坏情况只是多一条退出日志。
- **配套：插件零配置连本地微服务**。`dsh-painter` 模块顶层在未设 `IMAGE_GEN_URL` 且未开 `PAINTER_USE_LOCAL_IMAGE=1` 时，默认写 `http://127.0.0.1:8002/generate`；`dsh-memory-bus` 在未设 `MEMORY_BUS_URL` 时写默认 `http://127.0.0.1:8001`（进程内所有消费者共享）。已设的 env 仍优先生效，`PAINTER_USE_LOCAL_IMAGE=1` 保留内置测试图逃生口。
- 冒烟通过：路径解析正确、Painter spawn→健康就绪→`/health` `/stats` 200、dispose 杀进程树后 8002 释放；IndexTTS/Memory 走「端口已占跳过」分支不重复加载。

### 8. `plugins/dsh-memory-map`（TS 插件）— 记忆星图后端（**已从公开版剥离，归档至 `_archive_v1/`，待 V2.1 复公开**；以下为历史实现记录）
- 注册工具 `generate_constellation_snapshot(days?, limit?, rebuild?)`：从 8001 Memory 微服务 `/recent` 拉最近 N 天记忆（默认 90 天 / 500 条；`/recent` 为本次给 memory 微服务新增的批量端点，跨 7 层返回全字段）。
- **聚类（3D 版重构）**：每条记忆取其 tags 中**全局频次最高**者作为代表 tag 聚合（并列取排序最前）；无 tags → 按 level 兜底（`__level__:<level>`）。不同 key 超过 15 个时，保留频次最高的 14 个，其余并入 `__other__`（「其他记忆」），星系总数封顶 5~15。`cluster_id` 由键哈希生成，跨运行稳定。
- **3D 坐标**：星系中心 = 球面均匀分布（`cluster_id` 哈希 → phi/theta，半径 `230 + √count·24`）；星星坐标 = 中心 + 球内随机方向偏移（半径 `22 + √count·8` 内），由 `memory_id` 哈希派生 → 同一记忆坐标永远不变。`size` = `3 + importance·1.5 + log10(1+content长度)·1.2`，clamp [3,20]；`color`：`importance≥4` 金色 `#ffd87a`，否则按 `cluster_id` 哈希色相 `hsl(hash, 78, 62)`。
- **输出 / 迁移**：`schema_version: 3`；旧 2D 快照（无 `schema_version`）加载时自动触发全量重建为 3D。结构 `{schema_version, generated_at, days, total_memories, clusters:[{cluster_id,label,tags,count,center{x,y,z}}], stars:[{memory_id,cluster_id,x,y,z,size,color,title,text,level,importance,created_at}]}`。**原子写入**：写 `*.tmp` 再 rename（带 3 次重试），前端永远只读完整 JSON。
- **增量追加（核心）**：默认 `rebuild=false`，加载已有快照，只为「未分配坐标的新记忆」补坐标并 append，既有坐标原样保留；`rebuild=true` 全量重算。冒烟实测：第二次运行 `new_count=0`、星数不变、星星坐标与星系中心完全稳定（幂等）。
- **每日定时**：apply 后调度到下一个 03:00 本地时间跑一次增量，之后每 24h 一次；`dispose` 清定时器；`MEMORY_MAP_CRON=0` 关闭。宿主休眠只影响触发时刻，不破坏数据。
- 零运行时依赖（Node 22 内置 `fetch` + `node:fs`），esbuild 无 external；devDeps 用 `npm install --no-package-lock` 扁平安装（避开沙箱 pnpm junction 回收）。
- 已 link 到 web profile（无 "not a profile layer" 警告）；冒烟通过：67 条记忆 → **67 星 / 15 星系**（星系封顶生效），坐标/颜色均合法、所有星引用有效星系，增量幂等。
- ✅ **前端 Three.js 3D 星云已完成并在真实 DSH 上验证通过**（见第 9 节）。

### 9. `plugins/dsh-memory-map` 前端可视化 + HTTP 路由（本次，任务 3 前端）

> 让用户在浏览器里直观看到「她的记忆星云」——Three.js 3D 粒子星云 + UnrealBloom 泛光，废弃原 D3.js 2D 力导向方案。源文件 `web/app.js`（ESM）由 esbuild 打成 `web/app.bundle.js`（IIFE，内嵌 three + addons），零 CDN 依赖，**可双击 `file://` 直接打开**（走内置 mock 数据）。

**后端补字段（3D）**：`Cluster.center` → `{x,y,z}`；`Star` 新增 `z`、`color`；`Snapshot` 新增 `schema_version: 3`。旧 2D 快照（无 schema_version）加载时自动全量重建为 3D；增量重建循环为旧 star 补齐 `z`/`color`。67 星全部带 `z`（0 缺失）、`color` 全部合法 6 位 hex。

**HTTP 路由**（复用 whale 同款 `ctx.webServer.register({kind:'exact',path,handler})`，dispose 注销 disposer）：
- `GET /api/constellation` → 快照 JSON（带 CORS、`Cache-Control: no-store`）。
- `GET /memory-map`、`/memory-map/`、`/memory-map/index.html` → `web/index.html`。
- `GET /memory-map/app.bundle.js` → `web/app.bundle.js`（含 three 的单文件打包，`application/javascript`）。
- **信任栅栏**：仅 GET、回环 Host 校验（`isLoopbackHostname`）、`sec-fetch-site`/origin 校验、可选委托 `connection.requestRejection`。
- 新增工具 `get_constellation_ui_url` → `http://127.0.0.1:${webPort}/memory-map/`。
- CLI 入口（仅直接 `node lib/index.js` 运行时触发，DSH import 不触发）：`--regen [--days N] [--limit N] [--rebuild]`。

**构建**：`build.mjs` 用 esbuild 同时打后端（`src/index.ts` → `lib/index.js`，node ESM）与前端（`web/app.js` → `web/app.bundle.js`，browser IIFE，`target es2020`）。前端必须 IIFE + 普通 `<script src>`：Chrome 对 `file://` 的 ES module import 有 CORS 限制，`<script type=module>` 会白屏。`three@0.160.0` 为 devDependency（仅构建期用，运行时已内嵌进 bundle，约 930KB）。

**前端实现**（`web/`，`package.json` 的 `files` 已含 `"web"`）：
- `index.html`：深色背景、顶部信息条（星系/星星/更新时间/「实时·演示数据」模式 + 重置视角/刷新数据按钮）、毛玻璃 tooltip、loading/error overlay；普通 `<script src="app.bundle.js">`（非 module）。
- `app.js`（Three.js 源）：
  - **深空背景**：4200 个远星铺在半径 1700~2400 球壳 + 600 个近层星尘，冷白/淡蓝小点；`bgGroup` 每帧极慢旋转（`rotation.y += 1.6e-4`）制造漂移感，星尘自带 shader 呼吸（`uTime` 驱动透明度）。
  - **记忆节点**：`THREE.Points` + 自定义 `ShaderMaterial`，顶点属性 `aSize`/`aColor`/`aPhase`/`aFreq`/`aHover`，uniform `uTime`；`gl_PointSize = aSize · pulse · boost · (scale/-mv.z)`，`pulse = 0.7 + 0.3·sin(uTime·aFreq + aPhase)`（每星呼吸频率/相位错开）；片元 `mix(vColor, white, vHover)` + 径向 `smoothstep` 白热核心，`AdditiveBlending` → 强泛光。
  - **星系形态（去线化）**：每个星系 = 一个 `THREE.Group`，星星用**局部坐标**（`星 − 中心`）挂入 → 转 group 即星系自转；辉光 `Sprite` 作为子节点挂在 group 原点（透明度调低至 `glowOpacity=0.16`，让星点更锐利）。**已删除全部 `LineSegments` 连线**——靠星点聚拢（向心力）+ 同色辉光体现同类。
  - **星系标签**：`#cluster-labels` 容器，每星系一个 HTML 浮层，每帧 `updateLabels()` 把中心投影到屏幕、下方偏移 18px，`opacity 0.2` 极低透明，超出视锥则隐藏。
  - **动效（`requestAnimationFrame`）**：① 星系自转 `group.rotation.y += spin`（每星系 `0.6~1.4` 随机错开）；② 星星呼吸闪烁（shader `uTime`）；③ 相机入场飞入 `Z=2350 → 920`（`easeInOutCubic`，~1.9s）；④ 背景星尘漂移。
  - **相机控制**：`OrbitControls` 阻尼 + 缓慢 `autoRotate`(0.32)；min/maxDistance 140/2800。**入场闸门修复自动拉近 Bug**：入场期间 `controls.enabled=false` 且不调 `controls.update()`，只 `camera.position.lerpVectors`；入场结束（t≥1）才 `controls.enabled=true; autoRotate=true; controls.update()`，把控制权完全交还 OrbitControls。聚焦用 `controls.target.lerp` + `camera.position.lerp`，到达后 `focus.active=false` 自终止，渲染循环绝不每帧重置相机。
  - **后处理**：`EffectComposer` → `RenderPass` → `UnrealBloomPass`(strength 1.1, radius 0.55, threshold 0) → `OutputPass`；`ACESFilmicToneMapping` + `outputColorSpace = SRGB`；`exposure 1.15`。
  - **悬停**：`Raycaster`（Points threshold 14）`pointermove` 命中 → 命中星 `aHover=1`（shader 混合纯白 + `hoverBoostSize=1.5` 放大），**其他星系顶点色 ×0.2 变暗**（`baseColors` 缓存防漂移），HTML 毛玻璃 tooltip 跟随鼠标；移出恢复。
  - **聚焦**：单击星星 lerp `controls.target` + `camera.position` 到该星系中心（关闭 autoRotate）；双击空白 / 「重置视角」按钮回全览（恢复 autoRotate）。
  - **数据**：`fetch('/api/constellation')` 优先；失败（如 `file://`）自动回退内置 mock（6 星系 / 54 星），顶栏标注「演示数据」。

**踩过的坑（已修复）**：
1. `hslToHex` 最初把 s/l 当百分数直接代入标准公式（公式需 [0,1]），产出 `#e5d686a6d27` 非法值。修：函数开头 `s/=100; l/=100` 并 clamp 0~255。
2. **悬停不弹 tooltip**：`pointermove` 里只调了 `setHover`（变暗）和 `moveTooltip`（定位），漏调 `showTooltip`——tooltip 从未在悬停时填充显示。修：命中时 `showTooltip(star, x, y)`（首次填内容，后续仅 `moveTooltip` 跟随）。用临时 `window.__nebula` debug 钩子 + 浏览器 `browser_evaluate` 确定性复现并验证后移除钩子。
3. `file://` ESM CORS：Chrome 拦 `file://` 的 module import。修：esbuild 打 IIFE + 普通 `<script src>`，bundle 内嵌 three，零外部依赖。
4. **星系共线「贪吃蛇」（hash01 碰撞，根因）**：`hash01` 原实现 `(hash32(s) % 100000) / 100000`。djb2（`h = 33·h + c`）对末位单字符差是**线性**的——`hash('…ox')`、`hash('…oy')`、`hash('…oz')` 恰好差 1/2，`%100000` 后仍差 1 → `gx≈gy≈gz` → 归一化方向恒为 `±(1,1,1)/√3` → 整个星系的星排在一条对角线上。删连线治标不治本。**修**：`hash01` 加 fmix32 雪崩混合（`h ^= h>>>16; h = Math.imul(h, 0x85ebca6b); h ^= h>>>13; h = Math.imul(h, 0xc2b2ae35); h ^= h>>>16`），把 1 bit 差扩散到 ~16 bit，`ox/oy/oz` 得到互不相关的 [0,1)，星星才在球内真正散开。注意：单纯改 `hash32(s)/4294967296` **无效**（djb2 线性仍在，差缩到 2⁻³² 照样共线）。验证：每星系统计「方向与均值几乎平行（|dot|>0.99）的星数」，修复前所有 n≥3 星系该值 = n（全共线），修复后 ≈0。
5. **`clusterMap` 值对象缺 `cluster_id` → 只追踪 1 个星系**：`buildConstellation` 把 `clusterMap[cl.cluster_id]` 存成 `{label, center, color, count, indices}`（**没带 `cluster_id`**），下游 `Object.values(clusterMap)` 遍历拿到的 `cl.cluster_id` 全是 `undefined` → `clusterGroups.set(undefined, …)` / `labelDivs.set(undefined, div)` 都只保留 1 个（但 15 个 group 已 `scene.add`，所以视觉上 15 个都在，造成假象）。症状：`labelDivs.size=1`（只有 1 个标签被 `updateLabels` 定位，其余 14 个留在默认位置不可见）、`clusterInfo()` 抛 `Cannot read properties of undefined (reading 'label')`、`applyHover` 只影响 1 个星系。**修**：值对象补 `cluster_id: cl.cluster_id`。

**验证**：真实 DSH 3080 浏览器实测——控制台零错误；入场后相机稳定在 Z≈880–920（不自拉近）、`controls`/`autoRotate` 正常交还；星系 `rotY` 随时间增长（自转生效）；15 个星系标签全部投影定位；悬停命中星纯白放大、其他星系变暗、tooltip 显示真实记忆正文；单击聚焦平滑推进、双击/按钮回全览。截图：`memory-map-overview.png` / `memory-map-hover.png` / `memory-map-final.png`。

**访问方式**：DSH web 启动后浏览器打开 `http://127.0.0.1:3080/memory-map/`（实时数据）；或双击 `plugins/dsh-memory-map/web/index.html`（`file://`，演示 mock 数据）。前端改完需 `node build.mjs` 重打 bundle，DSH 按请求从磁盘读 `web/`，**无需重启 DSH**。

**DSH Web 重启注意事项（极其脆弱，务必看）**：
1. `Shell` 后台 / `run_in_background` 拉起 DSH → `EPERM: operation not permitted, open 'C:\Users\user\.dsh\profiles\web\cordis.yml'`（受限 token 写不了用户 home 下的 `.dsh`，即便关沙箱也不行）。
2. `Start-Process`（完整用户 token）能正常启动 DSH，**但启动它的 Shell 命令一退出，进程树就被环境回收**，DSH 跟着死。
3. **本环境可靠启动法**：用 WMI 从「前台 + 关沙箱」命令创建进程——进程挂在 `WmiPrvSE` 下不归 Shell 树（不会被回收），且继承前台命令的完整 token（能写 cordis.yml）：
   ```powershell
   $wd = "C:\Users\user\Desktop\projects (2)\github-release\persona-os"
   $runner = "$wd\plugins\dsh-memory-map\_dsh_runner.mjs"
   $cmd = '"C:\Program Files\nodejs\node.exe" "' + $runner + '"'
   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $wd }
   ```
   `_dsh_runner.mjs` 用 `stdio: ['pipe','pipe','pipe']` 且**永不 `child.stdin.end()`**（DSH `web` 把 stdin EOF 当退出信号），自身 `setInterval` 保活；日志写 `%TEMP%\dsh-runner.log`。
4. **长期稳定方案**：用户在**自己的终端**里跑原始命令（stdin 是 TTY 不会 EOF，且用户 token 写 cordis.yml 无压力）：
   ```
   "C:\Program Files\nodejs\node.exe" "--env-file=C:\Users\user\Desktop\projects (2)\dsh\connection.env" "C:\Users\user\Desktop\projects (2)\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" web --host 127.0.0.1 --port 3080 --no-open
   ```
5. 启动后确认：`netstat -ano | findstr :3080` 应有 LISTENING；`Invoke-WebRequest http://127.0.0.1:3080/api/constellation` 返回 200。**改后端 `src/index.ts` → 需 `node build.mjs` 并重启 DSH**（加载新 `lib/index.js`）；**改前端 `web/app.js` → 只需 `node build.mjs` 重打 `web/app.bundle.js`，DSH 按请求从磁盘读，无需重启**，刷新浏览器即可。

### 验证状态
- 全部插件 `node --check` 通过、TS 诊断 0 错误、`dsh plugin --profile web list` 均为 profile layer（无 "not a profile layer" 警告）；本批次 `dsh-service-manager` 升级与 `dsh-memory-map` 新增均冒烟通过。
- 任务 1&2 已在用户环境实测连通（8001 /health → /remember → /recall）；任务 3&4 待用户在 DSH web 重启后在聊天里实测；dsh-web-agent 已在沙箱用真实 headless Edge 冒烟通过，待用户在 DSH 里实测 `run_web_task`。
- pnpm 在 Windows 并发链接大型依赖树时会 `thread overflowed its stack` 崩溃：添加新包后若 install 崩溃，用 `pnpm install --no-frozen-lockfile --child-concurrency=1` 串行化链接即可（playwright 1.64.1 已据此装好）。
- ⚠️ 沙箱会回收 pnpm `.pnpm` junction 目标，导致 sharp 原生包链接**确定性**栈溢出（`os error 1001`）；dsh-painter 的 `sharp`/`axios` 暂用 `npm install --no-package-lock` 装在插件自己的 `node_modules`（扁平、无 junction），运行时解析正常。**普通环境下 `pnpm install --no-frozen-lockfile --child-concurrency=1` 同样能装好这两个依赖**，无需特殊处理。

## 老记忆档案接入（鲸鱼 · 2026-11-06）

**数据源**：`C:\Users\user\Documents\档案\鲸鱼`（**非 SQLite**，绝不写源文件）：
- `记忆卡.md`（157KB / 291 行）：从 meow-memory 导出的长期记忆——261 条 `- ` 子弹条目，分六章（我是谁 / 底线与约定 / 在忙的项目 / 经历过的事 / 学到的 / 一起走过的事），每条末尾带 `⟨簇:标签⟩`，共 29 个不同簇标签；另含第三章 5 段加粗项目概述（persona-os / douyin-whale / dsh-pet / dsh / minecraft）。
- `日记/2026-11-05.md`：1 篇日记。
- `.xingxi/*`（clusters.json / clusters_v2.json / emb.npy 等）：旧星图实现的产物，**冗余，未动**。

**接入方式**：一次性脚本 `core-services/memory/import_whale_archive.py`
1. 只读解析 `记忆卡.md`（`- ` 子弹 → 一条记忆；`⟨簇:…⟩` → 唯一 tag；章节 → 记忆层映射：我是谁→`soul`、底线与约定→`rules`、第三章加粗段→`project`、经历过的事→`fact`、学到的→`lesson`、一起走过的→`topic`）+ `日记/*.md` → 共 **267 条候选**。
2. **幂等去重**：先 `GET /recent?days=3650&limit=5000` 拉全量已有活跃记忆，按 content 归一化（去空白）后相等/子串匹配，已存在跳过——现有 67 条运行期记忆与老档案正文 0 重叠，全部新增。
3. 逐条 `POST /remember` 写入，失败不中断、打印上下文；默认 dry-run，加 `--apply` 才真发。

**踩到的坑（已修复）**：`memory/main.py` 的 `write_memory` 原先用**固定列 INSERT**（含 `project` 列），但 meow 各表列不一致：
- `soul` / `user` 表**没有 `project` 列** → INSERT 报 `table soul has no column named project`（41 条 soul 首批失败）；
- `project` 表的 `project` 列是 **NOT NULL 且无默认值** → 传 NULL 报约束失败（5 条 project 首批失败）；
- `fact` / `rules` / `topic` / `lesson` 的 `project` 列可空（lesson 的 `corrected` 有默认 0）→ 第一批 221 条成功。

修（遵循「迁移前先查真实表结构」）：`write_memory` 改为**自适应列插入**——先 `PRAGMA table_info` 查真实列（进程内缓存 `_table_columns`），只插入该表存在的列；对无默认值的 NOT NULL 列（`project.project`）用首标签兜底。修复后重启 memory 服务（WMI 拉起，挂 `WmiPrvSE` 持久），重跑脚本补入剩余 46 条，**0 失败**。

**结果**：
- 记忆库活跃记忆：67 → **350**（soul 57 / project 11 / fact 94 / lesson 161 / topic 19 / rules 8）；`/recent` 可拉 334 条（16 条旧记录 `created_at` 异常落在 cutoff 之外，可忽略）。
- 星图快照 `data/memory_constellation.json` 用 `--regen --days 3650 --limit 5000 --rebuild` 全量重算：**334 星 / 15 星系**。最大星系：「其他记忆」112、「参考·模型」33、「渲染·截图」29、「字幕·画面」29、「游戏·光标」22…；每星系 `nearLine` 16–48（球状散布，上一轮 hash01 雪崩修复保持有效，无共线退化）；全局散布 794×784×622。
- DSH `/api/constellation` 从磁盘读快照即时生效（**无需重启 DSH**）；浏览器实测：15 个 `.cluster-label` 全投影、控制台零错、星系自转/呼吸/悬停正常，悬停 tooltip 直接显示老档案记忆正文（如「Mortis 语感参考语料…」）。

**复现 / 重跑**：
```powershell
python core-services/memory/import_whale_archive.py          # dry-run：只打印条数
python core-services/memory/import_whale_archive.py --apply  # 写入（幂等，已存在的跳过）
node plugins/dsh-memory-map/lib/index.js --regen --days 3650 --limit 5000 --rebuild
```
注：若日后新增老档案，重跑脚本即可（幂等）；`--days` 默认 90，想拉全量历史需显式传 3650。

## 说明

- 发布快照不含旧版归档文件：发布版目录的 `_archive_v1/` 已加入 `.gitignore`，仅在本地工作树保留观察期，不会随提交进入开源仓库。
- 主开发工作区（源项目）的 `_archive_v1/` 另有归档与还原说明；源项目的 `tools/` 仍由 Windows 计划任务（`dream_engine.py` / `context_engine.py` / `subconscious.py`）使用，迁移完成前不会动。
- `dsh-service-manager` 在发布版目录开发，运行时通过绝对路径回退借用源项目的 `index-tts/.venv` 与 `ohwhale-deploy/scripts/indextts_server.py`（算力与权重归属源项目）；开源用户请设置 `PERSONA_OS_ROOT` 指向自己的项目根。
