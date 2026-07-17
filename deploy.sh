#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# EdgeSonic 手动部署脚本（用 wrangler CLI，不依赖 Cloudflare Git 集成）
# ---------------------------------------------------------------------------
# 用法（在仓库根或任意目录执行均可）：
#   ./deploy.sh                    构建前端 + 部署到生产
#   ./deploy.sh --migrate FILE     部署前先把某个 SQL 迁移应用到远端 D1
#   ./deploy.sh --version-only      只上传新版本(不切生产流量，用于灰度/预览)
#   ./deploy.sh --no-build          跳过前端构建(web/dist 已最新时)
#
# 前置：
#   - 本地存在 worker/wrangler.toml（含私有资源 id，已被 .gitignore 排除，不入库）。
#     首次： cp worker/wrangler.toml.example worker/wrangler.toml 并填入你的资源 id。
#   - 机密用 `cd worker && npx wrangler secret put <NAME>`，见 worker/SECRETS.md，
#     绝不写进 wrangler.toml 或脚本。
# ===========================================================================

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

CONFIG="worker/wrangler.toml"
DB="edgesonic-db"
# Sandbox 转码容器（049）走 [[containers]]，正常 deploy 会尝试用 Docker 构建镜像。
# 本地无 Docker 时用 --containers-rollout=none：只部署 Worker + 保留 Sandbox DO 绑定
# （避免 CF error 10064 孤立 DO），跳过容器构建/更新。需要更新容器镜像时删掉此变量并确保 Docker 运行。
CONTAINERS_FLAG="--containers-rollout=none"

MIGRATE_FILE=""
VERSION_ONLY=0
DO_BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate)      MIGRATE_FILE="${2:?--migrate 需要一个 .sql 文件路径}"; shift 2 ;;
    --version-only) VERSION_ONLY=1; shift ;;
    --no-build)     DO_BUILD=0; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1（--help 查看用法）" >&2; exit 2 ;;
  esac
done

if [ ! -f "$CONFIG" ]; then
  echo "✗ 缺少 $CONFIG" >&2
  echo "  先执行: cp worker/wrangler.toml.example worker/wrangler.toml 并填入你的 Cloudflare 资源 id" >&2
  exit 1
fi

if [ "$DO_BUILD" -eq 0 ] && [ -f web/dist/build-info.json ]; then
  BUILD_INFO="$(<web/dist/build-info.json)"
else
  BUILD_INFO="$(node scripts/build-info.mjs)"
fi
VERSION="$(node -e 'console.log(JSON.parse(process.argv[1]).version)' "$BUILD_INFO")"
BUILD_TIME="$(node -e 'console.log(JSON.parse(process.argv[1]).buildTime)' "$BUILD_INFO")"
node -e 'const v=JSON.parse(process.argv[1]); if (!v.version || !v.buildTime || Number.isNaN(Date.parse(v.buildTime))) process.exit(1)' "$BUILD_INFO"
export EDGESONIC_VERSION="$VERSION"
export EDGESONIC_BUILD_TIME="$BUILD_TIME"

if [ "$DO_BUILD" -eq 1 ]; then
  echo "▶ [构建] 安装锁定依赖 + 生成前端 web/dist（worker 通过 [assets] 打包它）…"
  npm ci
  npm run build:web
  test -s web/dist/build-info.json
else
  echo "▶ [构建] 已跳过（--no-build）；确保 web/dist 是最新的。"
fi

if [ -n "$MIGRATE_FILE" ]; then
  echo "▶ [D1] 应用迁移到远端数据库 ${DB}: $MIGRATE_FILE"
  npx wrangler d1 execute "$DB" --remote --config "$CONFIG" --file "$MIGRATE_FILE"
fi

if [ "$VERSION_ONLY" -eq 1 ]; then
  echo "▶ [版本] 上传新版本（不切生产流量）…"
  npx wrangler versions upload --config "$CONFIG" --var WORKER_VERSION:"$VERSION" --var EDGESONIC_VERSION:"$VERSION" --var EDGESONIC_BUILD_TIME:"$BUILD_TIME"
  echo ""
  echo "✓ 完成。WORKER_VERSION=$VERSION（版本上传，未切生产，cron 未受影响）"
else
  echo "▶ [部署] wrangler deploy（含 web/dist 静态资源）…"
  npx wrangler deploy --config "$CONFIG" $CONTAINERS_FLAG --var WORKER_VERSION:"$VERSION" --var EDGESONIC_VERSION:"$VERSION" --var EDGESONIC_BUILD_TIME:"$BUILD_TIME"

  # wrangler deploy 会清空 Cloudflare 上的所有 cron 触发器（[triggers] 留空时 CF 认为「无计划」）。
  # 部署完毕后立即通过 CF API 恢复默认时间表，避免每次 deploy 后都要手动点 UI。
  # 自定义 cron 表达式：export EDGESONIC_CRON="*/30 * * * *"（默认每小时整点）。
  CRON_EXPR="${EDGESONIC_CRON:-0 */1 * * *}"
  ACCOUNT_ID=$(grep -m1 '^account_id' "$CONFIG" | sed 's/[^"]*"\([^"]*\)".*/\1/')
  WORKER_NAME=$(grep -m1 '^name' "$CONFIG" | sed 's/[^"]*"\([^"]*\)".*/\1/')

  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "$ACCOUNT_ID" ] && [ -n "$WORKER_NAME" ]; then
    echo "▶ [Cron] 恢复 cron 触发器（${CRON_EXPR}）…"
    CF_RESP=$(curl -s -X PUT \
      "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/schedules" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data-raw "[{\"cron\":\"${CRON_EXPR}\"}]")
    if node -e 'let body=""; process.stdin.on("data", (chunk) => body += chunk); process.stdin.on("end", () => { try { process.exit(JSON.parse(body).success ? 0 : 1); } catch { process.exit(1); } });' <<<"$CF_RESP"; then
      echo "✓ Cron 已恢复：${CRON_EXPR}"
    else
      echo "✗ Cron 自动恢复失败。"
      echo "  CF 响应：$(echo "$CF_RESP" | cut -c1-300)"
      exit 1
    fi
  fi
  echo ""
  echo "✓ 完成。WORKER_VERSION=$VERSION"
fi
