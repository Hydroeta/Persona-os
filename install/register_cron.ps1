# register_cron.ps1 —— 注册每天 03:00 生成「内心潜台词」的 Windows 计划任务
#
# 为什么用计划任务而不是 DSH cron：机器半夜可能休眠 / DSH 宿主没启动，
# 计划任务在系统层，还能配置「错过了就补跑」。
#
# 用法（在工作树根目录，普通用户权限即可，不需要管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install\register_cron.ps1
#   powershell ... -File install\register_cron.ps1 -Unregister    # 删任务
#   powershell ... -File install\register_cron.ps1 -Test          # 立即跑一次看效果
#
# 可选参数：
#   -Python <路径>   指定解释器（默认找 ohwhale-deploy\.venv，其次 index-tts\.venv，最后 PATH 里的 python）
#   -Time   <HH:mm>  每天几点跑，默认 03:00

param(
    [string]$Time = "03:00",
    [string]$Python = "",
    [switch]$Unregister,
    [switch]$Test
)

$ErrorActionPreference = "Stop"
$TaskName = "persona-os-InnerThoughts"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $RepoRoot "core-services\memory\generate_thoughts.py"

function Write-Step($msg) { Write-Host "[register_cron] $msg" -ForegroundColor Cyan }

if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Step "已删除计划任务 $TaskName"
    } else {
        Write-Step "没有找到 $TaskName，无需删除"
    }
    return
}

if (-not (Test-Path $Script)) {
    throw "找不到生成器脚本：$Script（请在仓库根目录执行本脚本）"
}

# 选解释器：优先带 fastapi 的 ohwhale venv，其次 index-tts，最后系统 python
# 注意：仓库可能嵌在某个工作目录里（如 <root>\github-release\persona-os），所以要向上多找几层
if (-not $Python) {
    $candidates = @()
    $probe = $RepoRoot
    for ($i = 0; $i -lt 4; $i++) {
        $candidates += (Join-Path $probe "ohwhale-deploy\.venv\Scripts\python.exe")
        $candidates += (Join-Path $probe "index-tts\.venv\Scripts\python.exe")
        $probe = Split-Path -Parent $probe
        if (-not $probe) { break }
    }
    foreach ($c in $candidates) {
        if (Test-Path $c) { $Python = $c; break }
    }
    if (-not $Python) { $Python = "python.exe" }
}
Write-Step "解释器：$Python"
Write-Step "脚本：$Script"

if ($Test) {
    Write-Step "立即试跑一次（会真的调用 Ollama 并写库）"
    & $Python $Script
    return
}

$action = New-ScheduledTaskAction -Execute $Python -Argument "`"$Script`"" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($Time, "HH:mm", $null))
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Step "旧任务已移除，准备重建"
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "persona-os：每天 $Time 用本地 Ollama 生成内心潜台词并写入 inner_thoughts" | Out-Null

$info = Get-ScheduledTask -TaskName $TaskName
Write-Step "已注册：$TaskName（每天 $Time，状态=$($info.State)）"
Write-Step "查看：schtasks /query /tn $TaskName /v /fo LIST"
Write-Step "立即试跑：powershell -File install\register_cron.ps1 -Test"
Write-Step "删除：powershell -File install\register_cron.ps1 -Unregister"
