#!/usr/bin/env bash
# RoomSense · Cloudflare 命令行包装
#
# 为什么要包一层：
#   1) 系统没单独装 Node，npx 在 WorkBuddy 的目录里，终端默认找不到它
#   2) 每次打一长串 export 太烦，还容易漏
#
# 用法（跟 wrangler 一模一样，前面多一句 bash tools/cf.sh）：
#   bash tools/cf.sh whoami
#   bash tools/cf.sh d1 create roomsense-db
#   bash tools/cf.sh deploy
#
# 凭证写在 tools/.env.cloudflare（已 gitignore，不会上 GitHub）：
#   cp tools/.env.cloudflare.example tools/.env.cloudflare
#   然后填上 CLOUDFLARE_API_TOKEN 和 CLOUDFLARE_ACCOUNT_ID

set -euo pipefail
cd "$(dirname "$0")/.."

# ── 1. 把 WorkBuddy 自带的 Node 加进 PATH（仅本次运行有效，不污染系统）──
WB_NODE="$HOME/.workbuddy-ai/binaries/node/versions/22.22.2/bin"
[ -d "$WB_NODE" ] && export PATH="$WB_NODE:$PATH"

if ! command -v npx >/dev/null 2>&1; then
  echo "✗ 还是找不到 npx。"
  echo "  检查一下：$WB_NODE 这个目录还在吗？"
  echo "  不在的话去 https://nodejs.org/ 下载 macOS Installer (.pkg) 装一个。"
  exit 1
fi

# ── 2. 读凭证 ──
if [ -f tools/.env.cloudflare ]; then
  set -a
  # shellcheck disable=SC1091
  . tools/.env.cloudflare
  set +a
fi

# ── 3. 校验：用 API Token 就免了浏览器登录 ──
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat <<HINT

  还没配置 Cloudflare API Token。

  ① 打开 https://dash.cloudflare.com/profile/api-tokens
  ② Create Token → 找 "Edit Cloudflare Workers" 模板 → Use template
  ③ 权限保持默认，Account Resources 选你的账号，一路下一步到创建
  ④ 复制那个 token（只显示一次，关掉就没了）

  然后把它写进 tools/.env.cloudflare：

      cp tools/.env.cloudflare.example tools/.env.cloudflare
      打开 tools/.env.cloudflare，把 CLOUDFLARE_API_TOKEN= 后面贴上你的 token

  另外再填 CLOUDFLARE_ACCOUNT_ID：
  打开 https://dash.cloudflare.com → 右侧栏最下面能找到 Account ID，
  或者在 Workers & Pages 页面右边。

HINT
  exit 1
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "✗ 缺 CLOUDFLARE_ACCOUNT_ID（去 Cloudflare 后台右侧栏底部抄）"
  echo "  填进 tools/.env.cloudflare 里"
  exit 1
fi

# ── 4. 交给 wrangler ──
exec npx --no-install wrangler "$@"
