#!/usr/bin/env bash
# RoomSense · 推送到 GitHub
#
# 两种方式，选一个就行：
#
#   A. SSH（推荐，配一次永久生效）
#      1) GitHub → Settings → SSH and GPG keys → New SSH key
#      2) 粘贴：cat ~/.ssh/id_ed25519.pub
#      3) bash tools/push_github.sh
#
#   B. 个人访问令牌（临时、不想配 SSH 时用）
#      1) GitHub → Settings → Developer settings → Personal access tokens
#         → Tokens (classic) → Generate new token → 勾 repo
#      2) GITHUB_TOKEN=ghp_xxx bash tools/push_github.sh
#
# 用法：
#   bash tools/push_github.sh                      # 推送
#   bash tools/push_github.sh --status             # 只体检，不推送
#   bash tools/push_github.sh git@github.com:用户/仓库.git
#
# 本脚本不含任何密钥，可以安全提交。

set -euo pipefail
cd "$(dirname "$0")/.."

# --status：只体检不推送
STATUS_ONLY=0
if [ "${1:-}" = "--status" ]; then STATUS_ONLY=1; shift; fi

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  REPO_URL="$(git remote get-url origin 2>/dev/null || true)"
fi
if [ -z "$REPO_URL" ]; then
  REPO_URL="git@github.com:yuxinh07/Roomsense-Panel.git"
fi

# 有 GITHUB_TOKEN 就走 HTTPS，不再需要 SSH 公钥
TOKEN="${GITHUB_TOKEN:-}"
if [ -n "$TOKEN" ]; then
  REPO_HTTPS="https://github.com/$(echo "$REPO_URL" | sed -E 's#.*[:/]([^/]+)/([^/]+)(\.git)?$#\1/\2#').git"
fi

C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_DIM=$'\033[90m'; C_OFF=$'\033[0m'
ok()   { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
bad()  { printf '%s  ✗%s %s\n' "$C_RED"   "$C_OFF" "$1"; }
warn() { printf '%s  !%s %s\n' "$C_YEL"   "$C_OFF" "$1"; }
dim()  { printf '%s%s%s\n'     "$C_DIM"   "$1"     "$C_OFF"; }

printf '\n== RoomSense → GitHub ==\n\n'
dim "目标仓库：$REPO_URL"

# ── 1. GitHub 认证 ──
printf '\n[1/5] 检查 GitHub 连接\n'
if [ -n "$TOKEN" ]; then
  whoami_json="$(curl -s -H "Authorization: token $TOKEN" https://api.github.com/user || true)"
  login="$(echo "$whoami_json" | grep -oE '"login": *"[^"]+"' | head -1 | sed -E 's/.*: *"(.*)"/\1/')"
  if [ -n "$login" ]; then
    ok "令牌有效，已登录为 $login"
  else
    bad "令牌无效或权限不足"
    dim "  需要勾上 repo 权限。重新生成：GitHub → Settings → Developer settings"
    dim "  → Personal access tokens → Tokens (classic) → Generate new token"
    exit 1
  fi
else
  if ssh -T -o ConnectTimeout=10 -o BatchMode=yes git@github.com 2>&1 | grep -qi "successfully authenticated\|You've successfully"; then
    ok "SSH 已认证"
  elif ssh -T -o ConnectTimeout=10 -o BatchMode=yes git@github.com 2>&1 | grep -qi "permission denied"; then
    bad "GitHub 认不出你这台机器"
    cat <<HINT

  还差一步：把公钥加到 GitHub。

    $(cat ~/.ssh/id_ed25519.pub 2>/dev/null || echo "（找不到公钥，先跑 ssh-keygen）")

  复制上面这行 → GitHub 右上角头像 → Settings → SSH and GPG keys
  → New SSH key → 粘贴 → Add SSH key

  加完重新跑本脚本。

  嫌麻烦？用令牌更快（不用配 SSH）：
    GITHUB_TOKEN=ghp_你的令牌 bash tools/push_github.sh
HINT
    exit 1
  else
    bad "连不上 GitHub（网络问题？）"
    exit 1
  fi
fi

# ── 2. 仓库存在吗 ──
# 注意：私有仓库对未授权请求一律返回 404，和「不存在」长一个样。
# 所以这里必须用已认证的方式探测，不能拿匿名 curl 的 404 当结论。
printf '\n[2/5] 检查仓库是否存在\n'
repo_slug="$(echo "$REPO_URL" | sed -E 's#.*[:/]([^/]+)/([^/]+)(\.git)?$#\1/\2#')"
if [ -n "$TOKEN" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "https://api.github.com/repos/$repo_slug")"
  if [ "$code" = "200" ]; then
    vis="$(curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/$repo_slug" | grep -oE '"private": *(true|false)' | head -1 | grep -oE 'true|false')"
    if [ "$vis" = "true" ]; then
      ok "仓库存在，且是 Private"
    elif [ "${ALLOW_PUBLIC:-0}" = "1" ]; then
      warn "仓库存在，但是 Public（已显式允许，继续）"
    else
      bad "仓库存在，但它是 Public！"
      warn "  默认拦下了。确认要公开推真实数据就加 ALLOW_PUBLIC=1"
      exit 1
    fi
  else
    bad "仓库不可见（HTTP $code）—— 不存在，或令牌看不到它"
    cat <<HINT

  去 https://github.com/new 建：
    Repository name : Roomsense-Panel
    可见性          : ● Private   ← 必须选这个
    初始化选项      : 全都别勾（空仓库最好推）

  建好后重新跑本脚本。
HINT
    exit 1
  fi
else
  if git ls-remote "$REPO_URL" HEAD >/dev/null 2>&1; then
    ok "仓库可访问"
    warn "  （SSH 方式判断不了可见性，请自己确认它是 Private）"
  else
    bad "访问不了 $REPO_URL"
    cat <<HINT

  可能原因（私有仓库和不存在，报错一模一样，只能你自己分辨）：
    a) 仓库还没建 → 去 https://github.com/new 建，选 Private，别勾初始化
    b) 仓库建了但没权限 → 用你的账号建的才推得上去
    c) 名字打错了     → GitHub 仓库名不区分大小写，但连字符要对

  想让我帮你判断？用令牌跑一次，能查到确切的可见性：
    GITHUB_TOKEN=ghp_你的令牌 bash tools/push_github.sh
HINT
    exit 1
  fi
fi

if [ "$STATUS_ONLY" -eq 1 ]; then
  printf '\n'
  ok "体检完成（--status 模式，未推送）"
  dim "  要推送：bash tools/push_github.sh"
  exit 0
fi

# ── 3. 敏感文件扫描 ──
printf '\n[3/5] 扫描敏感文件\n'
leak=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  bad "会被提交：$f"
  leak=1
done < <(git ls-files | grep -iE '(^|/)\.env$|^\.dev\.vars|secret|credential|\.pem$|\.key$|id_rsa|id_ed25519' || true)

if [ "$leak" -eq 1 ]; then
  cat <<HINT

  上面这些文件含凭证，不能提交。
  先加到 .gitignore，或执行 git rm --cached <文件> 移出版本控制。
HINT
  exit 1
fi
ok "没有凭证类文件被追踪"
dim "  （.env.feishu / .dev.vars 已在 .gitignore 中，不会被推上去）"

# ── 4. 真实数据提醒 ──
printf '\n[4/5] 确认推送内容\n'
cat <<WARN
${C_YEL}  这个仓库里有你的真实经营数据，推上去就收不回来：${C_OFF}

    seed.sql                         销售 / 库存 / 广告的真实数据
    tools/fixtures/feishu_sales.json 从飞书导出的 63 行真实订单
    multitable/*.csv                 SKU 与库存明细

  推到 Public = 全网可见（含竞争对手），且 Git 历史会永久留痕，删不干净。
  已确认无密钥泄漏：无 GitHub token / SSH 私钥 / PEM / AWS key。
WARN
printf '\n'
read -r -p "  确认推到 $repo_slug？输入 yes 继续： " confirm
if [ "$confirm" != "yes" ]; then
  warn "已取消，什么都没推。"
  exit 0
fi

# ── 5. 推送 ──
printf '\n[5/5] 推送\n'
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ -n "$TOKEN" ]; then
  # remote 里不存令牌（存了就是明文落盘），只在 push 这一瞬间带上
  PUSH_URL="$(echo "$REPO_HTTPS" | sed -E 's#https://#https://x-access-token:'"$TOKEN"'@#')"
else
  PUSH_URL="$REPO_URL"
fi
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "${REPO_HTTPS:-$REPO_URL}"
else
  git remote add origin "${REPO_HTTPS:-$REPO_URL}"
fi
dim "  分支：$BRANCH"
dim "  提交数：$(git rev-list --count HEAD)"
dim "  远端 origin → ${REPO_HTTPS:-$REPO_URL}"

git push -u "$PUSH_URL" "$BRANCH"

printf '\n'
ok "推送完成"
cat <<TIP

  仓库地址：https://github.com/$repo_slug

  以后改完代码，两步推上去：
    git add -A
    git commit -m "改了什么"
    bash tools/push_github.sh

  想确认有没有泄露：去仓库页面看 Settings → 最底部 Danger Zone，
  如果显示 "Change repository visibility" 且当前是 Private，就对了。
TIP
