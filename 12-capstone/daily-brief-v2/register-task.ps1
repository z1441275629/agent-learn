# 模块 12 v2：注册 Windows 任务计划——每天 09:00 跑 v2 多租户产线（pipeline 无参数=全体用户）
# 注意：本文件必须保持「UTF-8 带 BOM」——Windows PowerShell 5.x 对无 BOM 的 UTF-8 按 GBK 解析，
# 中文全乱码 + 字符串终止符崩（v1 register-task.ps1 2026-10-28 实录）；编辑后确认文件头仍是 EF BB BF
# 跑法（一次性注册）：powershell -ExecutionPolicy Bypass -File .\register-task.ps1
# 查询：schtasks /Query /TN "ai-agent-lab daily-brief-v2"
# 手动试一发（烧真 token，想清楚再按）：schtasks /Run /TN "ai-agent-lab daily-brief-v2"
# 删除：schtasks /Delete /TN "ai-agent-lab daily-brief-v2" /F
# 并存纪律：v1 任务（ai-agent-lab daily-brief）与本任务只留一个启用——都跑=同一人收两份推送。
# 切 v2 时禁用 v1：powershell -c "Disable-ScheduledTask -TaskName 'ai-agent-lab daily-brief'"

$node = (Get-Command node).Source
# WorkingDirectory 钉死仓库根：dotenv 从 cwd 读 .env，任务计划默认 cwd 是 system32（v1 实录）
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$action = New-ScheduledTaskAction -Execute $node -Argument "$repo\12-capstone\daily-brief-v2\pipeline.ts" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At "09:00"
# 电池供电也跑 + StartWhenAvailable：09:00 关机/睡眠 → 开机后补跑（另一半兜底是 H5 的补跑按钮）
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "ai-agent-lab daily-brief-v2" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "已注册：每天 09:00 跑 v2 产线（全体用户；node=$node，工作目录=$repo）"
