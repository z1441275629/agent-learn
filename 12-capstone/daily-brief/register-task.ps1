# 模块 12 §7：注册 Windows 任务计划——每天 09:00 跑 daily-brief 产线（cron 的 Windows 形状，模块 08 的落地）
# 注意：本文件必须保持「UTF-8 带 BOM」——Windows PowerShell 5.x 对无 BOM 的 UTF-8 按 GBK 解析，
# 中文全乱码 + 字符串终止符崩（2026-10-28 实录）；编辑后确认文件头仍是 EF BB BF
# 跑法（一次性注册）：powershell -ExecutionPolicy Bypass -File .\register-task.ps1
# 查询：schtasks /Query /TN "ai-agent-lab daily-brief"
# 手动试一发：schtasks /Run /TN "ai-agent-lab daily-brief"
# 删除：schtasks /Delete /TN "ai-agent-lab daily-brief" /F

$node = (Get-Command node).Source
# $PSScriptRoot = daily-brief 目录，三层上溯到仓库根（WorkingDirectory 钉死仓库根：
# dotenv 从 cwd 读 .env，任务计划默认 cwd 是 system32——不钉死必踩「环境变量读不到」）
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$action = New-ScheduledTaskAction -Execute $node -Argument "$repo\12-capstone\daily-brief\pipeline.ts" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At "09:00"
# 电池供电也跑（笔记本没插电不跳过）+ StartWhenAvailable：09:00 正在关机/睡眠 → 开机后补跑（「关机兜底」的另一半，另一半是 server 的补跑按钮）
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "ai-agent-lab daily-brief" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "已注册：每天 09:00 跑产线（node=$node，工作目录=$repo）"
Write-Host '手动试一发：schtasks /Run /TN "ai-agent-lab daily-brief"'
