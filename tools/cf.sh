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

# ── 3. 认证相关的子命令不需要 API Token ──
# wrangler login 走浏览器 OAuth，自己会存凭证，用不着手工建 API Token。
# 建不了 token 的人（见下面提示）直接走这条路就行。
CMD="${1:-}"
case "$CMD" in
  login|logout|whoami|--version|-v|help) SKIP_TOKEN_CHECK=1 ;;
  *) SKIP_TOKEN_CHECK=0 ;;
esac

# login 会在本机 8976 端口起一个回调服务器等浏览器带授权码回来。
# 如果终端里配了代理（HTTP_PROXY 之类），浏览器去连 localhost 也会被代理拦，
# 表现是浏览器那边显示授权成功、终端这边一直转圈等到超时。
# 所以 login 时把本机地址排除在代理之外。
if [ "$CMD" = "login" ] && [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
  export NO_PROXY="${NO_PROXY:-}localhost,127.0.0.1"
  export no_proxy="${no_proxy:-}localhost,127.0.0.1"
  echo "（检测到代理，已把 localhost 排除 —— 否则 OAuth 回调会被代理拦住）"
fi

if [ "$SKIP_TOKEN_CHECK" = "1" ]; then
  exec npx --no-install wrangler "$@"
fi

# ── 4. 校验 ──
# 已经用浏览器登录过的话，凭证在 ~/.wrangler 里，不在 .env.cloudflare，
# 这种情况不该再要求 API Token —— 否则登录后所有命令还是被拦在门外。
WRANGLER_CFG="$HOME/.wrangler/config/default.toml"
if [ -f "$WRANGLER_CFG" ] && grep -q "oauth_token" "$WRANGLER_CFG" 2>/dev/null; then
  # 浏览器已登录。ACCOUNT_ID 没配也不拦：wrangler 会列出账号让你挑。
  exec npx --no-install wrangler "$@"
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat <<HINT

  还没配置 Cloudflare API Token。有两条路，挑一条走：

  ── 方式 A：浏览器登录（不用建 token，推荐）──────────────────
    直接跑：  bash tools/cf.sh login
    会弹浏览器让你授权，授权完 wrangler 自己记住，以后不用再管。

  ── 方式 B：手工建 API Token ──────────────────────────────
    ① 打开 https://dash.cloudflare.com/profile/api-tokens
    ② Create Token → 找 "Edit Cloudflare Workers" 模板 → Use template
    ③ 权限保持默认，Account Resources 选你的账号，一路下一步到创建
    ④ 复制那个 token（只显示一次，关掉就没了）

    然后写进 tools/.env.cloudflare：

        cp tools/.env.cloudflare.example tools/.env.cloudflare
        打开 tools/.env.cloudflare，把 CLOUDFLARE_API_TOKEN= 后面贴上你的 token

    建不出来通常是这三个原因：
      · 进去的是 "API Keys" 而不是 "API Tokens" —— 这俩不是一个东西。
        老版 Global API Key 在页面最下面，跟 Token 分开，别抄那个。
      · 你是被别人邀请进账号的成员（Members），不是管理员，
        没有建 Token 的权限 → 改走方式 A，或者让管理员给你建。
      · 账号邮箱没验证 → 先去验证，否则页面上的按钮是灰的。

  另外还要填 CLOUDFLARE_ACCOUNT_ID：
  打开 https://dash.cloudflare.com → 右侧栏最下面能找到 Account ID，
  或者在 Workers & Pages 页面右边。

HINT
  exit 1
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "✗ 缺 CLOUDFLARE_ACCOUNT_ID（去 Cloudflare 后台右侧栏底部抄）"
  echo "  填进 tools/.env.cloudflare 里"
  echo "  不想建 token 的话，改用浏览器登录： bash tools/cf.sh login"
  exit 1
fi

# ── 5. 交给 wrangler ──
exec npx --no-install wrangler "$@"
