#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# EdgeSonic 手动部署脚本（用 wrangler CLI，不依赖 Cloudflare Git 集成）
# ---------------------------------------------------------------------------
# 用法（在仓库根或任意目录执行均可）：
#   ./scripts/deploy.sh                    构建前端 + 部署到生产
#   ./scripts/deploy.sh --migrate FILE     部署前先把某个 SQL 迁移应用到远端 D1
#   ./scripts/deploy.sh --version-only      只上传新版本(不切生产流量，用于灰度/预览)
#   ./scripts/deploy.sh --no-build          跳过前端构建(web/dist 已最新时)
#
# 前置：
#   - 本地存在 worker/wrangler.toml（含私有资源 id，已被 .gitignore 排除，不入库）。
#     首次： cp worker/wrangler.toml.example worker/wrangler.toml 并填入你的资源 id。
#   - 机密用 `cd worker && npx wrangler secret put <NAME>`，见 worker/SECRETS.md，
#     绝不写进 wrangler.toml 或脚本。
# ===========================================================================

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="worker/wrangler.toml"
DB="edgesonic-db"

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

if [ "$DO_BUILD" -eq 1 ]; then
  echo "▶ [构建] 安装依赖 + 生成前端 web/dist（worker 通过 [assets] 打包它）…"
  npm install
  npm run build:web
else
  echo "▶ [构建] 已跳过（--no-build）；确保 web/dist 是最新的。"
fi

if [ -n "$MIGRATE_FILE" ]; then
  echo "▶ [D1] 应用迁移到远端数据库 $DB： $MIGRATE_FILE"
  npx wrangler d1 execute "$DB" --remote --config "$CONFIG" --file "$MIGRATE_FILE"
fi

VERSION="$(date +%s)"
if [ "$VERSION_ONLY" -eq 1 ]; then
  echo "▶ [版本] 上传新版本（不切生产流量）…"
  npx wrangler versions upload --config "$CONFIG" --var WORKER_VERSION:"$VERSION"
else
  echo "▶ [部署] wrangler deploy（含 web/dist 静态资源）…"
  npx wrangler deploy --config "$CONFIG" --var WORKER_VERSION:"$VERSION"
fi

echo ""
echo "✓ 完成。WORKER_VERSION=$VERSION"
echo "  提醒：wrangler deploy 会清空动态配置的 cron —— 部署后到"
echo "        Settings → Cloudflare → \"Ensure default cron\" 重新应用定时任务（见 worker/CF_CRON.md）。"
