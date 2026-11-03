# DeepSeek Harness 启动脚本（Tulpa 水群用）
# 用法：在 dsh 目录右键“使用 PowerShell 运行”，或在此目录执行 .\start-dsh.ps1
$dshRoot = $PSScriptRoot
# 盘符必须用大写（C:\），否则 Node 会把 dsh-app-boot 加载成两份模块，导致“暂时无法保存确认状态”
$dshRoot = $dshRoot.Substring(0,1).ToUpper() + $dshRoot.Substring(1)
$env:DSH_HOME = Join-Path $dshRoot 'home'
Set-Location (Join-Path $dshRoot 'workspace')
node --env-file="$dshRoot/connection.env" "$dshRoot/node_modules/@deepseek-ai/dsh/lib/bin.js" web --host 127.0.0.1 --port 3080 --no-open
