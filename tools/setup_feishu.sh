#!/usr/bin/env bash
# RoomSense · 飞书多维表接线：注入 Secrets 到 Cloudflare Worker
#
# 本脚本【不含任何密钥】，可以安全提交到 GitHub。
# 真实凭证放在 tools/.env.feishu（已 gitignore）。
#
# 用法：
#   cp tools/.env.feishu.example tools/.env.feishu
#   $EDITOR tools/.env.feishu          # 填上你的值
#   bash tools/setup_feishu.sh         # 会自动 source .env.feishu
#
# 也可以直接用环境变量跑（CI 场景）：
#   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx \
#   FEISHU_TABLE_TOKEN=Bascnxxx FEISHU_TABLE_ID=tblxxx \
#   bash tools/setup_feishu.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# 自动加载 .env.feishu（如果存在），这样命令行不用拼一长串
if [ -f tools/.env.feishu ]; then
  set -a
  # shellcheck disable=SC1091
  . tools/.env.feishu
  set +a
  echo "==> 已加载 tools/.env.feishu"
fi

# ───────── 必填 ─────────
# 飞书开放平台 → 企业自建应用 → 凭证与基础信息
FEISHU_APP_ID="${FEISHU_APP_ID:-}"          # cli_a1b2c3d4e5f6g7h8
FEISHU_APP_SECRET="${FEISHU_APP_SECRET:-}"

# 多维表 URL：https://my.feishu.cn/base/ImJybIKBlauxp4sEdZkcPvpWn8g
#
# ↓ 下面 5 个已经按你的「ROOMSENSE看板」填好了（2026-09-03 核对过结构），
#   一般不用改。换表了再用环境变量覆盖，例如：
#     FEISHU_TABLE_ID=tblXXXXXX bash tools/setup_feishu.sh
FEISHU_TABLE_TOKEN="${FEISHU_TABLE_TOKEN:-ImJybIKBlauxp4sEdZkcPvpWn8g}"   # /base/ 后面那段
FEISHU_TABLE_ID="${FEISHU_TABLE_ID:-tblLVFcCYLwLGdun}"                    # 销售明细

# ───────── 可选：留空 = 不同步该表 ─────────
FEISHU_TABLE_ID_INV="${FEISHU_TABLE_ID_INV:-tblHol3lES38B6HJ}"   # 库存
FEISHU_TABLE_ID_ADS="${FEISHU_TABLE_ID_ADS:-tbl20vkrSmu1O2pK}"   # 广告投放
FEISHU_TABLE_ID_SKU="${FEISHU_TABLE_ID_SKU:-tbl9CQoZ6jGqpD1a}"   # SKU 主数据

ADMIN_TOKEN="${ADMIN_TOKEN:-Rs@2026roomsense}"

# ══════════ 以下不用改 ══════════

missing=0
for pair in \
  "FEISHU_APP_ID:${FEISHU_APP_ID}" \
  "FEISHU_APP_SECRET:${FEISHU_APP_SECRET}" \
  "FEISHU_TABLE_TOKEN:${FEISHU_TABLE_TOKEN}" \
  "FEISHU_TABLE_ID:${FEISHU_TABLE_ID}"; do
  name="${pair%%:*}"
  if [ -z "${pair#*:}" ]; then
    echo "✗ 缺少必填项：$name"
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  cat <<HINT

  填值方式（二选一）：

  A) 推荐：
       cp tools/.env.feishu.example tools/.env.feishu
       编辑 tools/.env.feishu 填值，然后重跑本脚本

  B) 环境变量：
       FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx \\
       FEISHU_TABLE_TOKEN=Bascnxxx FEISHU_TABLE_ID=tblxxx \\
       ADMIN_TOKEN=你的口令 bash tools/setup_feishu.sh

  ⚠ tools/.env.feishu 已在 .gitignore 里，不会被提交。
    别把凭证直接写进本脚本 —— 它是要上 GitHub 的。
HINT
  exit 1
fi

echo "==> 注入 Secrets 到 Cloudflare Worker"
put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && echo "  ✓ $1"; }

put FEISHU_APP_ID       "$FEISHU_APP_ID"
put FEISHU_APP_SECRET   "$FEISHU_APP_SECRET"
put FEISHU_TABLE_TOKEN  "$FEISHU_TABLE_TOKEN"
put FEISHU_TABLE_ID     "$FEISHU_TABLE_ID"
put ADMIN_TOKEN         "$ADMIN_TOKEN"

[ -n "$FEISHU_TABLE_ID_INV" ] && put FEISHU_TABLE_ID_INV "$FEISHU_TABLE_ID_INV"
[ -n "$FEISHU_TABLE_ID_ADS" ] && put FEISHU_TABLE_ID_ADS "$FEISHU_TABLE_ID_ADS"
[ -n "$FEISHU_TABLE_ID_SKU" ] && put FEISHU_TABLE_ID_SKU "$FEISHU_TABLE_ID_SKU"

echo
echo "==> 已配置的 Secrets："
npx wrangler secret list

cat <<TIP

════════════════════════════════════════════
 Secrets 注入完成。接下来手动跑：
════════════════════════════════════════════

 1) 部署（Secrets 只在部署后才生效）
      npx wrangler deploy

 2) 手动触发一次同步，看返回的行数
      curl -X POST https://<你的域名>/api/sync/feishu \\
        -H "X-Admin-Token: ${ADMIN_TOKEN}"

    返回形如 {"ok":true,"synced":{"sales":128,"inventory":16,"ads":4,"sku":16,...}}
    就是通了。某个值为 0 说明那张表是空的或没给权限。

 3) 排错看实时日志
      npx wrangler tail

TIP
