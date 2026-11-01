# -*- coding: utf-8 -*-
# persona-os · 总部署（预检 + 串联安装 + 人工待办清单）
# 用法：右键「以 PowerShell 运行」，或双击包根目录的「一键安装.cmd」
# 可选参数：
#   -DetectOnly        纯预检：只检测、不安装、不询问（agent/先看缺什么再决定）
#   -NonInteractive    无人值守：不弹任何询问（第 6 步自动跳过，EULA 不代同意）
#   -SelfTest          结束前运行冒烟测试（需 ohwhale-deploy\.venv 已就绪）
#   -OutFile <路径>    检测报告与待办清单落盘（默认 部署待办清单.md；传 "" 关闭）
param(
    [switch]$DetectOnly,
    [switch]$NonInteractive,
    [switch]$SelfTest,
    [string]$OutFile = "部署待办清单.md"
)
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
function Write-Step($t) { Write-Host "`n==== $t ====" -ForegroundColor Cyan }
function Has-Cmd($n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }

# ---------- 检测结果收集（供报告落盘） ----------
# 报告可能被截图外发，所有落到报告里的路径先脱敏：项目根 -> %PROJECT_ROOT%，用户目录 -> %USERPROFILE%，C:\Users\<名> -> C:\Users\%USERNAME%
function Mask-Path([string]$s) {
    if (-not $s) { return $s }
    $s = $s -replace [regex]::Escape($Root), '%PROJECT_ROOT%'
    $s = $s -replace [regex]::Escape($env:USERPROFILE), '%USERPROFILE%'
    if ($env:APPDATA) { $s = $s -replace [regex]::Escape($env:APPDATA), '%APPDATA%' }
    $s = $s -replace '[A-Za-z]:\\Users\\[^\\\s]+', 'C:\Users\%USERNAME%'
    return $s
}
$script:Results = @()
function Add-Item($name, $ok, $hint, $auto = $false, $optional = $false) {
    $script:Results += [pscustomobject]@{ Name = $name; Ok = [bool]$ok; Hint = (Mask-Path $hint); Auto = [bool]$auto; Optional = [bool]$optional }
    if ($ok) { Write-Host ("  [OK]   " + $name) -ForegroundColor Green }
    else { Write-Host ("  [缺失] " + $name + "  ->  " + (Mask-Path $hint)) -ForegroundColor Yellow }
}

# ---------- ohwhale 配置解析（检测路径以 config.json 为准，缺失时回退默认值） ----------
$OwDir = Join-Path $Root "ohwhale-deploy"
$OwCfg = $null
$cfgPath = Join-Path $OwDir "config.json"
if (Test-Path $cfgPath) { try { $OwCfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Write-Warning "config.json 解析失败，检测项回退默认路径" } }
function Resolve-Ow([string]$rel, [string]$fallback) {
    if (-not $rel) { $rel = $fallback }
    if ([System.IO.Path]::IsPathRooted($rel)) { return $rel }
    return Join-Path $OwDir $rel
}
$TtsEngine = "indextts2"
if ($OwCfg -and $OwCfg.services -and $OwCfg.services.tts_engine) { $TtsEngine = $OwCfg.services.tts_engine }

function Invoke-Detection {
    $script:Results = @()
    Write-Step "组件检测（缺什么、怎么补）"

    # --- 插件宿主与协议端 ---
    $dshOk = $false
    foreach ($p in @("C:\Program Files\DSH Desktop", (Join-Path $env:LOCALAPPDATA "Programs\DSH Desktop"), (Join-Path $env:LOCALAPPDATA "DSH Desktop"))) {
        if (Test-Path $p) { $dshOk = $true; break }
    }
    if (-not $dshOk -and (Test-Path (Join-Path $Root "runtime\dsh\node_modules\@deepseek-ai\cordis"))) { $dshOk = $true }
    Add-Item "DSH 核心（插件宿主依赖）" $dshOk "第 6 步可自动装核心 npm 包（公开分发）" $true
    Add-Item "SnowLuma 协议端" (Test-Path (Join-Path $Root "SnowLuma")) "第 6 步可下载官方原始包并校验 SHA256；EULA 不允许代跑，需本人首次启动" $true
    Add-Item "Tulpa.exe" (Test-Path (Join-Path $Root "Tulpa\Tulpa\Tulpa.exe")) "从 Tulpa 官方 Releases 下载后放入 Tulpa\Tulpa\"
    $petCount = @(Get-ChildItem (Join-Path $Root "dsh-pet") -Filter *.exe -ErrorAction SilentlyContinue).Count
    Add-Item "dsh-pet.exe 桌宠" ($petCount -gt 0) "需连同 _internal\ 整个目录复制到 dsh-pet\"

    # --- mortis-pet（源码随仓库：检测依赖 / 打包产物 / 素材 / 台词 / ffmpeg） ---
    $mExe = (Test-Path (Join-Path $Root "mortis-pet\dist\mortis-pet\mortis-pet.exe")) -or (Test-Path (Join-Path $Root "mortis-pet\dist\mortis-pet.exe"))
    $mPySide = $false
    if (Has-Cmd "python") { try { & python -c "import PySide6" 2>$null; $mPySide = ($LASTEXITCODE -eq 0) } catch {} }
    Add-Item "mortis-pet 运行形态（exe 或 PySide6）" ($mExe -or $mPySide) "pip install -r mortis-pet\requirements.txt（源码运行）；打包另 pip install pyinstaller 后按 mortis-pet.spec"
    $mIdle = @(Get-ChildItem (Join-Path $Root "mortis-pet\videos\idle") -Filter *.webm -ErrorAction SilentlyContinue).Count
    Add-Item "mortis-pet 视频素材（videos\idle）" ($mIdle -gt 0) "自备 VP9 透明底素材放入 mortis-pet\videos\（不入库），至少含 idle\ 一个 .webm"
    Add-Item "mortis-pet 台词（config.json，本机自有）" (Test-Path (Join-Path $Root "mortis-pet\config.json")) "复制 config.example.json 为 config.json 并填入台词（动画/二创来源，自备不入库）"
    $mFfmpeg = (Has-Cmd "ffmpeg") -or (Test-Path (Join-Path $env:USERPROFILE ".local\bin\ffmpeg.exe")) -or (Test-Path (Join-Path $Root "mortis-pet\bin\ffmpeg.exe"))
    Add-Item "mortis-pet 依赖 ffmpeg（VP9 alpha 解码）" $mFfmpeg "放 ~\.local\bin\ffmpeg.exe 或加入 PATH"

    # --- TTS 引擎（按 services.tts_engine 分流） ---
    $idxPy = Resolve-Ow ($OwCfg.paths.indextts_python) "../index-tts/.venv/Scripts/python.exe"
    $idxPyOk = Test-Path $idxPy
    $idxWeights = "C:\idx_models"
    $idxWeightsOk = $false
    if (Test-Path $idxWeights) { $idxWeightsOk = @(Get-ChildItem $idxWeights -Recurse -File -Depth 1 -ErrorAction SilentlyContinue).Count -gt 0 }
    $refWav = Resolve-Ow ($OwCfg.paths.voice_ref) "models/indextts2/refs/ref.wav"
    $refOk = Test-Path $refWav
    if ($TtsEngine -eq "indextts2") {
        Add-Item "IndexTTS2 环境（index-tts venv，默认 TTS）" $idxPyOk "官方仓库自建 index-tts\ 环境（Python 3.11 + torch），路径见 config.json paths.indextts_python"
        Add-Item "IndexTTS2 权重（C:\idx_models）" $idxWeightsOk "从 IndexTTS2 官方 Releases 下载权重到 C:\idx_models（不入库；GPU 锁页失败时 INDEXTTS_DEVICE=cpu 兜底）"
        Add-Item "参考音（voice_ref）" $refOk "自备授权音源放入 $refWav（个人生物特征，不入库）"
        $gsOk = (Test-Path (Join-Path $OwDir "runtime\GPT-SoVITS")) -and (Test-Path (Join-Path $OwDir "models\sovits"))
        Add-Item "GPT-SoVITS（遗留可选，未启用）" $gsOk "当前 tts_engine=$TtsEngine；启用时运行 install\补齐组件.ps1 -Tts 自动补齐（约 4 GB，需 NVIDIA GPU）" $true $true
    } else {
        Add-Item "GPT-SoVITS 运行时（当前引擎）" (Test-Path (Join-Path $OwDir "runtime\GPT-SoVITS")) "当前 tts_engine=$TtsEngine：第 6 步可自动下载（源码钉版 + SHA256 校验）" $true
        Add-Item "SoVITS 模型权重（当前引擎）" (Test-Path (Join-Path $OwDir "models\sovits")) "第 6 步可自动下载预训练模型（约 1.25 GB）" $true
        Add-Item "IndexTTS2 环境（备选引擎）" $idxPyOk "当前未启用；自建 index-tts\ 环境后可切回默认引擎"
        Add-Item "参考音（voice_ref）" $refOk "自备授权音源放入 $refWav（个人生物特征，不入库）"
    }

    # --- 消息链与模型 ---
    Add-Item "QQ 协议端 NapCat" (Test-Path (Join-Path $OwDir "runtime\LL")) "第 6 步可自动下载（约 66 MB，含便携 QQ）" $true
    $ollamaOk = $false
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", 11434); $c.Close(); $ollamaOk = $true } catch {}
    Add-Item "Ollama 本地推理（可选，:11434）" $ollamaOk "用户自装（https://ollama.com）；不装则全部走云端模型" $false $true

    # --- 音频 ---
    $cableOk = $false
    try { $cableOk = [bool](Get-CimInstance Win32_SoundDevice -ErrorAction Stop | Where-Object { $_.Name -like "*CABLE*" }) } catch { $cableOk = $false }
    Add-Item "VB-CABLE 虚拟声卡" $cableOk "https://vb-audio.com/Cable/ 下载安装（QQ 语音回程必需）"
}

Write-Host "persona-os · 总部署" -ForegroundColor Green
Write-Host ("包目录：" + (Mask-Path $Root) + "    TTS 引擎：$TtsEngine")

# ---------- 1/7 基础环境 ----------
Write-Step "1/7 基础环境"
if ($DetectOnly) {
    Add-Item "Node.js（>=22）" ((Has-Cmd "node") -and ([int](((& node -v) 2>$null) -replace '^v','').Split('.')[0]) -ge 22) "https://nodejs.org 下载 LTS，或 winget install OpenJS.NodeJS.LTS"
    Add-Item "Python 3.12" (Has-Cmd "python") "https://www.python.org/downloads/（3.12）"
    Add-Item "pnpm" (Has-Cmd "pnpm") "npm install -g pnpm"
    Add-Item "ffmpeg（PATH）" (Has-Cmd "ffmpeg") "winget install Gyan.FFmpeg，或放 ~\.local\bin 并加 PATH"
}
else {
    if (Has-Cmd "winget") { Write-Host "winget 可用，缺失项会自动安装（可能弹 UAC）" }
    else { Write-Warning "未检测到 winget：请手动安装 App Installer，或按下面提示自行下载" }
    if (Has-Cmd "node") {
        $nv = (node -v).TrimStart("v")
        Write-Host "Node.js 已安装：$nv"
        if ([int]($nv.Split(".")[0]) -lt 22) {
            Write-Warning "Node.js 版本偏低，建议升级到 24 LTS"
            if (Has-Cmd "winget") { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements }
        }
    } else {
        Write-Host "安装 Node.js LTS ..."
        if (Has-Cmd "winget") { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements }
        else { Write-Warning "请到 https://nodejs.org 下载 LTS 安装" }
    }
    if (Has-Cmd "python") { Write-Host "Python 已安装：$((& python --version) 2>&1)" }
    else {
        Write-Host "安装 Python 3.12 ..."
        if (Has-Cmd "winget") { winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements }
        else { Write-Warning "请到 https://www.python.org/downloads 下载 3.12" }
    }
    if (Has-Cmd "pnpm") { Write-Host "pnpm 已安装：$((& pnpm -v) 2>&1)" }
    elseif (Has-Cmd "npm") { Write-Host "安装 pnpm ..."; npm install -g pnpm }
    else { Write-Warning "npm 不可用，跳过 pnpm" }
    if (Has-Cmd "ffmpeg") { Write-Host "ffmpeg 已安装" }
    else {
        Write-Host "安装 ffmpeg ..."
        if (Has-Cmd "winget") { winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements }
        else { Write-Warning "请到 https://ffmpeg.org 下载并加入 PATH" }
    }
}

# ---------- 2/7 根目录控制台 ----------
Write-Step "2/7 根目录控制台（纯标准库，无需 pip 依赖）"
$console = Join-Path $Root "console.py"
if (Test-Path $console) {
    if (Has-Cmd "python") { python -c "import sys; print('Python', sys.version.split()[0], 'OK')" }
    Write-Host "控制台入口：双击「控制台.cmd」，或 python console.py"
} else { Write-Warning "未找到 console.py" }

# ---------- 3/7 & 4/7 包内依赖 ----------
if (-not $DetectOnly) {
    Write-Step "3/7 哦鲸鲸（ohwhale-deploy）依赖"
    if (Test-Path (Join-Path $OwDir "requirements.txt")) {
        Write-Host "安装 Python 依赖（requirements.txt）..."
        python -m pip install --upgrade pip
        python -m pip install -r (Join-Path $OwDir "requirements.txt")
        Write-Host "提示：默认 TTS 为 IndexTTS2（环境与权重需自备，见第 5/7 步）；GPT-SoVITS 为遗留可选"
    } else { Write-Host "本包未附带 ohwhale 依赖清单，跳过" }

    Write-Step "4/7 whale-pod 插件依赖"
    $wp = Join-Path $Root "whale-pod"
    if (Test-Path (Join-Path $wp "package.json")) {
        if (Has-Cmd "pnpm") { pnpm --dir $wp install } elseif (Has-Cmd "npm") { npm --prefix $wp install }
        else { Write-Warning "缺少 npm/pnpm，跳过 whale-pod" }
    } else { Write-Host "未找到 whale-pod/package.json，跳过" }
}
else { Write-Step "3-4/7 预检模式：跳过包内依赖安装" }

# ---------- 5/7 组件检测 ----------
Invoke-Detection

# ---------- 6/7 可选：自动补齐 ----------
$filled = $false
Write-Step "6/7 可选：自动补齐能自动的组件"
if ($DetectOnly) {
    Write-Host "预检模式：跳过。之后可运行 install\补齐组件.ps1 -All -DryRun 只看计划"
}
else {
    if ($TtsEngine -eq "gpt_sovits") {
        Write-Host "当前引擎为 gpt_sovits，可自动：DSH 核心包与 14 家免费渠道 / GPT-SoVITS 全套 / NapCat / SnowLuma（EULA 需同意）"
        Write-Host "合计下载约 4~5 GB，耗时较长；PyTorch 需要 NVIDIA GPU" -ForegroundColor Yellow
        $fillArgs = @("-All")
    }
    else {
        Write-Host "可自动：DSH 核心包与 14 家免费渠道 / NapCat / SnowLuma（EULA 需同意）；默认合计约 100 MB"
        Write-Host "GPT-SoVITS 为遗留可选（当前引擎 $TtsEngine），如需：install\补齐组件.ps1 -Tts（约 4 GB，需 NVIDIA GPU）"
        $fillArgs = @("-Dsh", "-DshChannels", "-Qq", "-SnowLuma")
    }
    $doFill = $false
    if ($NonInteractive) {
        Write-Host "NonInteractive 模式：跳过自动补齐（可稍后运行 install\补齐组件.ps1 $($fillArgs -join ' ')）"
    }
    else { $doFill = (Read-Host "现在自动补齐吗？(Y/N，默认 N)") -match '^[Yy]' }
    if ($doFill) {
        $extra = Join-Path $PSScriptRoot "补齐组件.ps1"
        if (Test-Path $extra) {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $extra @fillArgs -Quiet
            $filled = $true
        } else { Write-Warning "未找到 install\补齐组件.ps1" }
    } elseif (-not $NonInteractive) {
        Write-Host "已跳过。之后可单独运行：install\补齐组件.ps1 $($fillArgs -join ' ')"
        Write-Host "只想先看计划不下载：install\补齐组件.ps1 -All -DryRun"
    }
}

# 补齐后复检，刷新报告
if ($filled) { Invoke-Detection }

# ---------- 7/7 仍需手工的组件 ----------
Write-Step "7/7 仍需手工的组件（授权 / 凭据 / 素材限制）"
Write-Host @"
  · IndexTTS2 环境 + 权重（默认 TTS）：官方仓库自建 index-tts\ 环境，权重下载到 C:\idx_models（不入库）
  · mortis-pet 素材与台词：videos\ 视频素材与 config.json 台词均自备（台词整理自 Ave Mujica 动画及二创，不适用 MIT）
  · Tulpa.exe：从官方 Releases 获取，本仓库不分发
  · dsh-pet.exe：需连同 _internal\ 整个目录一起复制
  · SnowLuma：脚本只下载官方原始发行包并校验 SHA256，不修改、不代跑；EULA 5.4 限制自动化部署
  · 参考音：属个人生物特征，未打包；可换任意你有授权的音源
  · 密钥：启动控制台后在「密钥与配置」填写（只进本机 DPAPI 保险库）
  · 运行时账号：NapCat 首次扫码登录 QQ；B 站 / 抖音 cookie 按需在控制台配置
"@ -ForegroundColor Yellow

# ---------- 可选：冒烟测试 ----------
if ($SelfTest) {
    Write-Step "冒烟测试（tests\test_smoke.py）"
    $vpy = Join-Path $OwDir ".venv\Scripts\python.exe"
    $smoke = Join-Path $Root "tests\test_smoke.py"
    if ((Test-Path $vpy) -and (Test-Path $smoke)) {
        Push-Location $Root
        & $vpy $smoke 2>&1 | Select-Object -Last 5
        Pop-Location
    } else { Write-Warning "跳过：缺 ohwhale-deploy\.venv 或 tests\test_smoke.py" }
}

# ---------- 检测报告落盘 ----------
if ($OutFile) {
    $out = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $Root $OutFile }
    $L = @("# persona-os 部署报告", "", "- 生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')", "- TTS 引擎：$TtsEngine", "- 包目录：$(Mask-Path $Root)", "- 说明：本报告中的本机路径已自动脱敏（%PROJECT_ROOT% / %USERPROFILE% / C:\Users\%USERNAME%）；已加入 .gitignore，请勿手动提交或截图外发。", "")
    $okItems = @($script:Results | Where-Object { $_.Ok })
    $autoItems = @($script:Results | Where-Object { -not $_.Ok -and $_.Auto -and -not $_.Optional })
    $optItems = @($script:Results | Where-Object { -not $_.Ok -and $_.Optional })
    $manualItems = @($script:Results | Where-Object { -not $_.Ok -and -not $_.Auto -and -not $_.Optional })
    $L += "## 已就绪（$($okItems.Count)）"
    if ($okItems.Count -eq 0) { $L += "-（无）" }
    foreach ($i in $okItems) { $L += "- [x] $($i.Name)" }
    $L += ""; $L += "## 缺失——可自动补齐（$($autoItems.Count)）"
    if ($autoItems.Count -eq 0) { $L += "-（无）" }
    foreach ($i in $autoItems) {
        $cmd = "install\补齐组件.ps1 -All -DryRun   # 先看计划"
        if ($i.Name -like "DSH*") { $cmd = "install\补齐组件.ps1 -Dsh" }
        elseif ($i.Name -like "*NapCat*") { $cmd = "install\补齐组件.ps1 -Qq" }
        elseif ($i.Name -like "SnowLuma*") { $cmd = "install\补齐组件.ps1 -SnowLuma   # 需同意 EULA" }
        elseif ($i.Name -like "GPT-SoVITS*") { $cmd = "install\补齐组件.ps1 -Tts   # 需 NVIDIA GPU" }
        $L += "- [ ] $($i.Name) —— ``$cmd``"
    }
    $L += ""; $L += "## 可选（按需，不装不影响主流程）（$($optItems.Count)）"
    if ($optItems.Count -eq 0) { $L += "-（无）" }
    foreach ($i in $optItems) { $L += "- [ ] $($i.Name) —— $($i.Hint)" }
    $L += ""; $L += "## 缺失——必须人工（$($manualItems.Count)）"
    if ($manualItems.Count -eq 0) { $L += "-（无）" }
    foreach ($i in $manualItems) { $L += "- [ ] $($i.Name) —— $($i.Hint)" }
    $L += ""
    $L += "## 脚本永远无法代劳的事项"
    $L += "- [ ] API 密钥（DeepSeek / 阿里云百炼 / 智谱）：控制台「密钥与配置」录入（DPAPI 保险库）"
    $L += "- [ ] NapCat 首次启动扫码登录 QQ；B 站 / 抖音 cookie 按需配置"
    $L += "- [ ] mortis-pet 台词（config.json）与视频素材：需用户自备，脚本不会生成（权利限制，不入库）"
    $L += "- [ ] dsh-pet 角色形象素材：自备（上游渠道获取）"
    $L += "- [ ] 参考音（个人生物特征）：自备授权音源"
    $L += ""; $L += "## 下一步"
    $L += "1. 按上面清单补齐缺项（可自动补齐的直接跑报告里的命令）"
    $L += "2. 补齐后重新跑 ``install\安装.ps1 -DetectOnly``，确认清单全绿"
    $L += "3. 双击 ``控制台.cmd``，浏览器打开 http://127.0.0.1:8900 统一管理服务拓扑"
    $L += "4. 详见 使用说明.md（安装 / 运维 / 常见问题）"
    [System.IO.File]::WriteAllLines($out, $L, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "`n检测报告已写入：$out" -ForegroundColor Green
}

Write-Host "`n总部署流程结束。若刚装了 Node/Python，请重开终端再运行控制台。" -ForegroundColor Green
if (-not $NonInteractive) { Read-Host "按回车退出" | Out-Null }
