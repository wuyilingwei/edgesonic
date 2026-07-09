# ===========================================================================
# EdgeSonic 手动部署脚本（PowerShell 版，用 wrangler CLI）
# ---------------------------------------------------------------------------
# 用法（在仓库根或任意目录执行均可）：
#   .\deploy.ps1                    构建前端 + 部署到生产
#   .\deploy.ps1 -Migrate FILE      部署前先把某个 SQL 迁移应用到远端 D1
#   .\deploy.ps1 -VersionOnly       只上传新版本(不切生产流量，用于灰度/预览)
#   .\deploy.ps1 -NoBuild           跳过前端构建(web/dist 已最新时)
#   .\deploy.ps1 -Help              显示帮助
#
# 前置：
#   - 本地存在 worker/wrangler.toml（含私有资源 id，已被 .gitignore 排除，不入库）。
#     首次： Copy-Item worker/wrangler.toml.example worker/wrangler.toml 并填入你的资源 id。
#   - 机密用 `cd worker; npx wrangler secret put <NAME>`，见 worker/SECRETS.md，
#     绝不写进 wrangler.toml 或脚本。
#   - 需要 CLOUDFLARE_API_TOKEN 环境变量才能自动恢复 cron（见末尾逻辑）。
# ===========================================================================

[CmdletBinding()]
param(
  [string]$Migrate,
  [switch]$VersionOnly,
  [switch]$NoBuild,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
  Get-Content $PSCommandPath | Where-Object { $_ -match '^\s*#' } | ForEach-Object { $_.TrimStart('# ') }
  exit 0
}

$Root = Split-Path -Parent $PSCommandPath
Set-Location $Root

$Config = "worker/wrangler.toml"
$DB = "edgesonic-db"
# Sandbox 转码容器（049）走 [[containers]]，正常 deploy 会尝试用 Docker 构建镜像。
# 本地无 Docker 时用 --containers-rollout=none：只部署 Worker + 保留 Sandbox DO 绑定
# （避免 CF error 10064 孤立 DO），跳过容器构建/更新。需要更新容器镜像时删掉此变量并确保 Docker 运行。
$ContainersFlag = "--containers-rollout=none"

if (-not (Test-Path $Config)) {
  Write-Error "✗ 缺少 $Config`n  先执行: Copy-Item worker/wrangler.toml.example worker/wrangler.toml 并填入你的 Cloudflare 资源 id"
  exit 1
}

if (-not $NoBuild) {
  Write-Host "▶ [构建] 安装依赖 + 生成前端 web/dist（worker 通过 [assets] 打包它）…"
  npm install
  npm run build:web
} else {
  Write-Host "▶ [构建] 已跳过（-NoBuild）；确保 web/dist 是最新的。"
}

if ($Migrate) {
  if (-not (Test-Path $Migrate)) {
    Write-Error "✗ 迁移文件不存在: $Migrate"
    exit 1
  }
  Write-Host "▶ [D1] 应用迁移到远端数据库 $DB`: $Migrate"
  npx wrangler d1 execute $DB --remote --config $Config --file $Migrate
}

$Version = [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

if ($VersionOnly) {
  Write-Host "▶ [版本] 上传新版本（不切生产流量）…"
  npx wrangler versions upload --config $Config --var "WORKER_VERSION:$Version"
  Write-Host ""
  Write-Host "✓ 完成。WORKER_VERSION=$Version（版本上传，未切生产，cron 未受影响）"
} else {
  Write-Host "▶ [部署] wrangler deploy（含 web/dist 静态资源）…"
  npx wrangler deploy --config $Config $ContainersFlag --var "WORKER_VERSION:$Version"

  # wrangler deploy 会清空 Cloudflare 上的所有 cron 触发器。
  # 部署完毕后立即通过 CF API 恢复默认时间表。
  # 自定义 cron 表达式：$env:EDGESONIC_CRON="*/30 * * * *"（默认每小时整点）。
  $CronExpr = if ($env:EDGESONIC_CRON) { $env:EDGESONIC_CRON } else { "0 */1 * * *" }

  # 从 wrangler.toml 解析 account_id 和 name
  $ConfigContent = Get-Content $Config -Raw
  $AcctLine = $ConfigContent | Select-String -Pattern 'account_id\s*=\s*"([^"]*)"'
  $NameLine = $ConfigContent | Select-String -Pattern '(?m)^\s*name\s*=\s*"([^"]*)"'
  $AccountId = if ($AcctLine) { $AcctLine.Matches.Groups[1].Value } else { "" }
  $WorkerName = if ($NameLine) { $NameLine.Matches.Groups[1].Value } else { "edgesonic" }

  Write-Host ""
  Write-Host "✓ 完成。WORKER_VERSION=$Version"

  if ($env:CLOUDFLARE_API_TOKEN -and $AccountId -and $WorkerName) {
    Write-Host "▶ [Cron] 恢复 cron 触发器（$CronExpr）…"
    $CronBody = "[{`"cron`":`"$CronExpr`"}]"
    try {
      $CronResp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts/$WorkerName/schedules" `
        -Method PUT `
        -Headers @{ Authorization = "Bearer $($env:CLOUDFLARE_API_TOKEN)"; "Content-Type" = "application/json" } `
        -Body $CronBody
      if ($CronResp.success) {
        Write-Host "✓ Cron 已恢复：$CronExpr"
      } else {
        Write-Host "⚠ Cron 自动恢复失败，请到 Settings → Cloudflare → `"Ensure default cron`""
        Write-Host "  CF 响应：$($CronResp | ConvertTo-Json -Depth 3 | Select-Object -First 1)"
      }
    } catch {
      Write-Host "⚠ Cron 自动恢复失败，请到 Settings → Cloudflare → `"Ensure default cron`""
      Write-Host "  错误：$($_.Exception.Message)"
    }
  } else {
    Write-Host "  提醒：未设置 CLOUDFLARE_API_TOKEN，无法自动恢复 cron。"
    Write-Host "  请到 Settings → Cloudflare → `"Ensure default cron`" 重新应用定时任务（见 worker/CF_CRON.md）。"
    Write-Host "  或设置 CLOUDFLARE_API_TOKEN 环境变量后重新运行，deploy.ps1 将自动恢复。"
  }
}