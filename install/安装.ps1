# -*- coding: utf-8 -*-
# 小鲸鱼生态 · 一键安装（基础环境 + 本包内组件依赖）
# 用法：右键「以 PowerShell 运行」，或双击包根目录的「一键安装.cmd」
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
function Write-Step($t) { Write-Host "`n==== $t ====" -ForegroundColor Cyan }
function Has-Cmd($n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }

Write-Host "persona-os · 环境安装" -ForegroundColor Green
Write-Host "包目录：$Root"

Write-Step "1/7 基础环境"
if (Has-Cmd "winget") {
    Write-Host "winget 可用，缺失项会自动安装（可能弹 UAC）"
} else {
    Write-Warning "未检测到 winget：请手动安装 App Installer，或按下面提示自行下载"
}

# Node.js >= 22（Search/Fetch 插件建议 24+）
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

# Python 3.12（本机若已有 3.10+ 也可用；Tulpa/ohwhale 推荐 3.12）
if (Has-Cmd "python") {
    $pyv = (& python --version) 2>&1
    Write-Host "Python 已安装：$pyv"
} else {
    Write-Host "安装 Python 3.12 ..."
    if (Has-Cmd "winget") { winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements }
    else { Write-Warning "请到 https://www.python.org/downloads 下载 3.12" }
}

# pnpm
if (Has-Cmd "pnpm") {
    $pnpmv = (& pnpm -v) 2>&1
    Write-Host "pnpm 已安装：$pnpmv"
}
elseif (Has-Cmd "npm") {
    Write-Host "安装 pnpm ..."
    npm install -g pnpm
} else { Write-Warning "npm 不可用，跳过 pnpm" }

# ffmpeg（视频/音频处理）
if (Has-Cmd "ffmpeg") { Write-Host "ffmpeg 已安装" }
else {
    Write-Host "安装 ffmpeg ..."
    if (Has-Cmd "winget") { winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements }
    else { Write-Warning "请到 https://ffmpeg.org 下载并加入 PATH" }
}

Write-Step "2/7 根目录控制台（纯标准库，无需 pip 依赖）"
$console = Join-Path $Root "console.py"
if (Test-Path $console) {
    python -c "import sys; print('Python', sys.version.split()[0], 'OK')"
    Write-Host "控制台入口：双击「控制台.cmd」，或 python console.py"
} else { Write-Warning "未找到 console.py" }

Write-Step "3/7 哦鲸鲸（ohwhale-deploy）依赖"
$ow = Join-Path $Root "ohwhale-deploy"
if (Test-Path (Join-Path $ow "requirements.txt")) {
    Write-Host "安装 Python 依赖（requirements.txt）..."
    python -m pip install --upgrade pip
    python -m pip install -r (Join-Path $ow "requirements.txt")
    Write-Host "提示：语音通话还需 GPT-SoVITS 运行时与模型，可在第 6 步一键补齐"
} else { Write-Host "本包未附带 ohwhale 依赖清单，跳过" }

Write-Step "4/7 whale-pod 插件依赖"
$wp = Join-Path $Root "whale-pod"
if (Test-Path (Join-Path $wp "package.json")) {
    if (Has-Cmd "pnpm") { pnpm --dir $wp install } elseif (Has-Cmd "npm") { npm --prefix $wp install }
    else { Write-Warning "缺少 npm/pnpm，跳过 whale-pod" }
} else { Write-Host "未找到 whale-pod/package.json，跳过" }

Write-Step "5/6 组件检测（缺什么、怎么补）"
function Show-Item($name, $ok, $hint) {
    if ($ok) { Write-Host ("  [OK]   " + $name) -ForegroundColor Green }
    else { Write-Host ("  [缺失] " + $name + "  ->  " + $hint) -ForegroundColor Yellow }
}
$dshOk = $false
foreach ($p in @("C:\Program Files\DSH Desktop", (Join-Path $env:LOCALAPPDATA "Programs\DSH Desktop"), (Join-Path $env:LOCALAPPDATA "DSH Desktop"))) {
    if (Test-Path $p) { $dshOk = $true; break }
}
if (-not $dshOk -and (Test-Path (Join-Path $Root "node_modules\@deepseek-ai\cordis"))) { $dshOk = $true }
if (-not $dshOk -and (Test-Path (Join-Path $Root "runtime\dsh\node_modules\@deepseek-ai\cordis"))) { $dshOk = $true }
Show-Item "DSH 助手（插件宿主，:3080）" $dshOk "第 6 步可自动装核心 npm 包（公开分发）"
Show-Item "SnowLuma 协议端" (Test-Path (Join-Path $Root "SnowLuma")) "第三方专有软件，需从官方 Releases 获取；其 EULA 不允许脚本自动部署"
Show-Item "Tulpa.exe" (Test-Path (Join-Path $Root "Tulpa\Tulpa\Tulpa.exe")) "从 Tulpa 官方 Releases 下载后放入 Tulpa\Tulpa\"
$petCount = @(Get-ChildItem (Join-Path $Root "dsh-pet") -Filter *.exe -ErrorAction SilentlyContinue).Count
Show-Item "dsh-pet.exe 桌宠" ($petCount -gt 0) "需连同 _internal\ 整个目录复制到 dsh-pet\"
Show-Item "GPT-SoVITS 运行时" (Test-Path (Join-Path $Root "ohwhale-deploy\runtime\GPT-SoVITS")) "第 6 步可自动下载（源码钉版 + SHA256 校验）"
Show-Item "SoVITS 模型权重" (Test-Path (Join-Path $Root "ohwhale-deploy\models\sovits")) "第 6 步可自动下载预训练模型（约 1.25 GB）"
Show-Item "QQ 协议端 NapCat" (Test-Path (Join-Path $Root "ohwhale-deploy\runtime\LL")) "第 6 步可自动下载（约 66 MB）"
Show-Item "语音参考音" (Test-Path (Join-Path $Root "ohwhale-deploy\assets\voice")) "因隐私未打包，自备授权音源放入 assets\voice\"
$cableOk = $false
try { $cableOk = [bool](Get-CimInstance Win32_SoundDevice -ErrorAction Stop | Where-Object { $_.Name -like "*CABLE*" }) } catch { $cableOk = $false }
Show-Item "VB-CABLE 虚拟声卡" $cableOk "https://vb-audio.com/Cable/ 下载安装（QQ 语音回程必需）"

Write-Step "6/7 可选：自动补齐能自动的组件"
Write-Host "可自动：DSH 核心包与 14 家免费渠道 / GPT-SoVITS 源码+预训练模型+PyTorch / NapCat / SnowLuma（需同意其 EULA）"
Write-Host "合计下载约 4~5 GB，耗时较长；PyTorch 步骤需要 NVIDIA GPU，纯 CPU 只能跑文字与 ASR" -ForegroundColor Yellow
$ans = Read-Host "现在自动补齐吗？(Y/N，默认 N)"
if ($ans -match '^[Yy]') {
    $extra = Join-Path $PSScriptRoot "补齐组件.ps1"
    if (Test-Path $extra) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $extra -All -Quiet
    } else { Write-Warning "未找到 install\补齐组件.ps1" }
} else {
    Write-Host "已跳过。之后可单独运行：install\补齐组件.ps1 -All（或 -Dsh / -Tts / -Qq）"
    Write-Host "只想先看计划不下载：install\补齐组件.ps1 -All -DryRun"
}

Write-Step "7/7 仍需手工的组件（授权/分发限制）"
Write-Host @"
  · SnowLuma：脚本只下载官方原始发行包并校验 SHA256，不修改、不代跑；EULA 5.4 规定并入第三方安装包或自动化部署须书面授权
  · Tulpa.exe：闭源二进制，无公开下载地址
  · dsh-pet.exe：PyInstaller 打包，必须连同 _internal\ 整个目录一起复制
  · 语音参考音：属个人生物特征，未打包；可换任意你有授权的音源
  · 密钥：启动控制台后在「密钥与配置」填写（只进本机 DPAPI 保险库）
"@ -ForegroundColor Yellow

Write-Host "`n安装流程结束。若刚装了 Node/Python，请重开终端再运行控制台。" -ForegroundColor Green
Read-Host "按回车退出"
