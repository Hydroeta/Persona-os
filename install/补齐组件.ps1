# -*- coding: utf-8 -*-
# 小鲸鱼生态 · 可选组件自动补齐
# 用法：
#   install\补齐组件.ps1 -All                 自动补齐全部可自动项
#   install\补齐组件.ps1 -Dsh                 只装 DSH 核心 npm 包
#   install\补齐组件.ps1 -DshChannels          DSH CLI + 14 家免费渠道插件（装到 web profile）
#   install\补齐组件.ps1 -Tts                 GPT-SoVITS 源码 + 预训练模型 + PyTorch
#   install\补齐组件.ps1 -Qq                  LuckyLillia QQ 协议端
#   install\补齐组件.ps1 -SnowLuma            官方 Releases 下载 + SHA256 校验 + 解压（需同意其 EULA）
#   install\补齐组件.ps1 -All -DryRun         只打印计划，不下载
param([switch]$Dsh, [switch]$DshChannels, [switch]$Tts, [switch]$Qq, [switch]$SnowLuma, [switch]$All, [switch]$DryRun, [switch]$Quiet, [switch]$AcceptSnowLumaEula)
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
if ($All) { $Dsh = $true; $DshChannels = $true; $Tts = $true; $Qq = $true; $SnowLuma = $true }
function Step($t) { Write-Host "`n==== $t ====" -ForegroundColor Cyan }

# ---------- DSH 核心包（@deepseek-ai/* 在 npm 公开） ----------
if ($Dsh) {
    Step "DSH 核心包（公开 npm）"
    $dshDir = Join-Path $Root "runtime\dsh"
    # 必须锁同一条 0.1.7-rc.2 版本线：npm 上各包 latest 标签不一致，混装会 peer 冲突
    $pkgs = @("@deepseek-ai/cordis@4.0.5", "@deepseek-ai/dsh-llm@0.1.7-rc.2",
              "@deepseek-ai/dsh-credentials@0.1.7-rc.2", "@deepseek-ai/dsh-llm-deepseek@0.1.7-rc.2",
              "@deepseek-ai/dsh-llm-deepseek-api-key@0.1.7-rc.2",
              "@deepseek-ai/dsh-launch-environment@0.1.7-rc.2")
    if ($DryRun) {
        Write-Host ("[计划] npm install " + ($pkgs -join " ") + "  ->  " + $dshDir)
    }
    elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Warning "缺 Node.js，跳过 DSH（先跑一键安装第 1 步）"
    }
    else {
        New-Item -ItemType Directory -Force -Path $dshDir | Out-Null
        Push-Location $dshDir
        if (-not (Test-Path "package.json")) { & npm init -y | Out-Null }
        $npmArgs = @("install", "--no-audit", "--no-fund") + $pkgs
        & npm @npmArgs
        Pop-Location
        if (Test-Path (Join-Path $dshDir "node_modules\@deepseek-ai\cordis")) {
            [Environment]::SetEnvironmentVariable("DSH_APP_DIR", $dshDir, "User")
            Write-Host "DSH 核心已装好：$dshDir" -ForegroundColor Green
            Write-Host "已写入用户环境变量 DSH_APP_DIR（WhalePod 靠它找插件宿主，重开终端生效）"
        }
        else { Write-Warning "npm 安装未完成，检查网络后重跑本脚本 -Dsh" }
    }
}

# ---------- GPT-SoVITS：复用 ohwhale 的钉版部署（源码 + 模型 + SHA256 校验） ----------
if ($Tts) {
    Step "GPT-SoVITS 运行时与预训练模型（下载约 4 GB，需 NVIDIA GPU）"
    $ow = Join-Path $Root "ohwhale-deploy"
    $seq = @("05_python.ps1", "10_deps.ps1", "20_download.ps1", "15_tts.ps1")
    if ($DryRun) {
        foreach ($s in $seq) { Write-Host "[计划] powershell -File ohwhale-deploy\install\$s" }
        Write-Host "[计划] 模型清单与 SHA256 见 ohwhale-deploy\config\downloads.json"
    }
    else {
        foreach ($s in $seq) {
            $p = Join-Path $ow ("install\" + $s)
            if (-not (Test-Path $p)) { Write-Warning "缺 $s，跳过"; continue }
            Write-Host "-> $s" -ForegroundColor Yellow
            & powershell -NoProfile -ExecutionPolicy Bypass -File $p
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "$s 退出码 $LASTEXITCODE；无 NVIDIA GPU 时 15_tts.ps1 必然失败，CPU 只能跑文字/ASR"
            }
        }
    }
}

# ---------- QQ 协议端 ----------
if ($Qq) {
    Step "LuckyLillia QQ 协议端（约 66 MB）"
    $p = Join-Path $Root "ohwhale-deploy\install\16_qq_client.ps1"
    if ($DryRun) { Write-Host "[计划] powershell -File ohwhale-deploy\install\16_qq_client.ps1" }
    elseif (Test-Path $p) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $p
        if ($LASTEXITCODE -ne 0) { Write-Warning "协议端下载失败，检查网络后重跑 -Qq" }
    }
    else { Write-Warning "包内无 16_qq_client.ps1，跳过" }
}

# ---------- SnowLuma：只拉官方原始发行包，不改、不代跑 ----------
if ($SnowLuma) {
    Step "SnowLuma 协议端（官方 GitHub Releases）"
    $rel = $null
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest" `
            -Headers @{ "User-Agent" = "whale-portfolio-installer" } -TimeoutSec 30
    } catch {
        Write-Warning "取不到 Releases 信息（网络/代理）；手动下载页：https://github.com/SnowLuma/SnowLuma/releases"
    }
    if ($rel) {
        $asset = $rel.assets | Where-Object { $_.name -like "*-win-x64.zip" -and $_.name -notlike "*-lite.zip" } | Select-Object -First 1
        if (-not $asset) {
            Write-Warning "$($rel.tag_name) 没有 Windows x64 完整包，请手动下载"
        }
        else {
            $want = ($asset.digest -replace '^sha256:', '').ToLower()
            Write-Host ("版本 {0}；{1}（{2:N1} MB）；SHA256 {3}" -f $rel.tag_name, $asset.name, ($asset.size / 1MB), $want)
            if ($DryRun) {
                Write-Host "[计划] 下载 $($asset.browser_download_url)  ->  $Root\SnowLuma"
            }
            else {
                Write-Host "SnowLuma EULA 5.4：并入第三方安装包或自动化部署须书面授权。" -ForegroundColor Yellow
                Write-Host "本脚本只下载官方原始发行包并解压，不修改、不代跑；启动仍由你手动执行 launcher.bat。" -ForegroundColor Yellow
                $ok = $AcceptSnowLumaEula
                if (-not $ok) { $ok = (Read-Host "我已阅读并同意 SnowLuma EULA，继续下载？(Y/N)") -match '^[Yy]' }
                if (-not $ok) {
                    Write-Host "已跳过；官方下载页：https://github.com/SnowLuma/SnowLuma/releases" -ForegroundColor Yellow
                }
                else {
                    $zip = Join-Path $env:TEMP ("snowluma-" + $rel.tag_name + "-win-x64.zip")
                    try {
                        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing -TimeoutSec 900
                    } catch { Write-Warning ("下载失败：" + $_.Exception.Message) }
                    if (Test-Path $zip) {
                        $sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
                        if ($want -and $sha -ne $want) {
                            Write-Warning "SHA256 不匹配（实得 $sha），已删除下载"
                            Remove-Item $zip -Force
                        }
                        else {
                            $dest = Join-Path $Root "SnowLuma"
                            New-Item -ItemType Directory -Force -Path $dest | Out-Null
                            Expand-Archive -Path $zip -DestinationPath $dest -Force
                            Write-Host "已解压到 $dest（SHA256 校验通过）" -ForegroundColor Green
                            Write-Host "手动启动：$dest\launcher.bat  →  http://localhost:5099（账号 admin，密码见启动日志）"
                            Remove-Item $zip -Force
                        }
                    }
                }
            }
        }
    }
}

# ---------- DSH 免费渠道插件 ----------
if ($DshChannels) {
    Step "DSH 免费渠道插件（14 家免费模型，MIT）"
    $dshDir = Join-Path $Root "runtime\dsh"
    $dshBin = Join-Path $dshDir "node_modules\.bin\dsh.cmd"
    if ($DryRun) {
        Write-Host "[计划] npm install --prefix $dshDir @deepseek-ai/dsh@0.2.1-rc.2"
        Write-Host "[计划] 从 GitHub Releases 下载 dsh-our-free-model-<ver>.tgz（约 35 MB）并校验 SHA256"
        Write-Host "[计划] dsh plugin --profile web add <tgz>"
    }
    elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Warning "缺 Node.js，跳过 DSH 渠道" }
    else {
        New-Item -ItemType Directory -Force -Path $dshDir | Out-Null
        if (-not (Test-Path $dshBin)) {
            & npm install --prefix $dshDir --no-audit --no-fund "@deepseek-ai/dsh@0.2.1-rc.2"
        }
        $rel = $null
        try {
            $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/Ebony-Vinyl/dsh-our-free-model/releases/latest" `
                -Headers @{ "User-Agent" = "whale-portfolio-installer" } -TimeoutSec 30
        } catch { Write-Warning "取不到插件 Releases（网络/代理），可手动装：https://github.com/Ebony-Vinyl/dsh-our-free-model" }
        if ($rel) {
            $asset = $rel.assets | Where-Object { $_.name -like "*.tgz" } | Select-Object -First 1
            if (-not $asset) { Write-Warning "$($rel.tag_name) 没有 .tgz 资产，手动安装见仓库 README" }
            else {
                $want = ($asset.digest -replace '^sha256:', '').ToLower()
                $tgz = Join-Path $env:TEMP $asset.name
                if (-not (Test-Path $tgz)) {
                    Write-Host ("下载 {0}（{1:N1} MB）..." -f $asset.name, ($asset.size / 1MB)) -ForegroundColor Yellow
                    try {
                        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tgz -UseBasicParsing -TimeoutSec 1800
                    } catch { Write-Warning ("下载失败：" + $_.Exception.Message) }
                }
                if (Test-Path $tgz) {
                    $sha = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()
                    if ($want -and $sha -ne $want) {
                        Write-Warning "SHA256 不匹配（实得 $sha），已删除下载"
                        Remove-Item $tgz -Force
                    }
                    else {
                        Write-Host "SHA256 校验通过，向 web profile 安装（pnpm 需要联网）..." -ForegroundColor Yellow
                        & $dshBin plugin --profile web add $tgz
                        if ($LASTEXITCODE -eq 0) {
                            Write-Host ("已装 {0} 到 ~/.dsh/profiles/web，14 家免费渠道随插件提供" -f $rel.tag_name) -ForegroundColor Green
                            Write-Host "EAC 协付渠道需桌面端登录 GitHub 并 Star 该仓库后才放行；其余匿名免费通道无需账号"
                        }
                        else { Write-Warning "插件安装退出码 $LASTEXITCODE；可手动执行 dsh plugin --profile web add `"$tgz`"" }
                    }
                }
            }
        }
    }
}

Step "仍需手工的组件（授权/分发限制，不是技术限制）"
Write-Host @"
  · Tulpa.exe：闭源二进制，无公开下载地址
  · dsh-pet.exe：PyInstaller 打包，必须连同 _internal\ 整个目录一起复制，单独 exe 跑不起来
  · 语音参考音：属个人生物特征，按隐私要求未打包（可换任意你有授权的音源）
放置位置见根目录 README-先看这个.md 的「组件放置位置」。
"@ -ForegroundColor Yellow
if (-not $DryRun -and -not $Quiet) { Read-Host "按回车退出" }
