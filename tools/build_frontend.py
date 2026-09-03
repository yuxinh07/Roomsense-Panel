#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把离线版 dashboard.html 拆成：
  public/index.html        —— 页面骨架（HTML + CSS），不含业务数据
  public/data.fallback.js  —— 离线兜底数据（原 6 大数据常量原样保留）
  public/app.js            —— 渲染函数 renderDashboard(DATA) + 启动逻辑（优先 API，失败回退兜底数据）

用法: python3 tools/build_frontend.py [源dashboard.html路径]
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(ROOT), "outputs", "dashboard.html")
PUB = os.path.join(ROOT, "public")

CONSTS = ["weeklyData", "invData", "skuWeeklyData", "catData", "platData", "invSuggestData"]


def read_lines(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read().split("\n")


def find_block(lines, start_idx):
    """从 const X = {|[ 开始，按括号配平找到结束行（含结尾分号），返回 (end_idx, text)"""
    depth = 0
    for i in range(start_idx, len(lines)):
        line = lines[i]
        for ch in line:
            if ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
        if depth <= 0 and i > start_idx:
            return i, "\n".join(lines[start_idx:i + 1])
    raise RuntimeError("未找到块结束: %s" % lines[start_idx])


def main():
    lines = read_lines(SRC)
    total = len(lines)

    # 定位主 <script> 段（最后一个裸 <script>，chart.js 是带 src 的）
    script_start = None
    script_end = None
    for i, l in enumerate(lines):
        if l.strip() == "<script>" and script_start is None:
            script_start = i
        if l.strip() == "</script>" and script_start is not None:
            script_end = i
    if script_start is None or script_end is None:
        raise RuntimeError("未找到内联 <script> 段")

    html_part = lines[:script_start]
    body_part = lines[script_end + 1:]
    script_lines = lines[script_start + 1:script_end]

    # 抽取 6 个数据常量
    blocks = {}
    drop_ranges = []
    for name in CONSTS:
        pat = re.compile(r"^\s*(?:const|let|var)\s+%s\s*=" % name)
        idx = None
        for i, l in enumerate(script_lines):
            if pat.match(l):
                idx = i
                break
        if idx is None:
            raise RuntimeError("未找到常量: %s" % name)
        end_idx, text = find_block(script_lines, idx)
        text = text.strip()
        if not text.endswith(";"):
            text += ";"
        blocks[name] = text
        drop_ranges.append((idx, end_idx))

    # 删除这些常量定义行
    drop = set()
    for a, b in drop_ranges:
        for i in range(a, b + 1):
            drop.add(i)
    kept = [l for i, l in enumerate(script_lines) if i not in drop]

    # ---------- public/data.fallback.js ----------
    fb = ["// 离线兜底数据：由 tools/build_frontend.py 从原 dashboard.html 自动生成",
          "// 当 /api/dashboard 不可用（本地双击打开 / 未部署后端）时，看板使用这份数据渲染。",
          "window.ROOMSENSE_FALLBACK = {"]
    for name in CONSTS:
        fb.append("  %s: %s" % (name, blocks[name].split("=", 1)[1].strip().rstrip(";")) + ",")
    fb.append("  kpi: {")
    fb.append("    total: 37852.38, thisWeek: 4737, netJuly: 13843, adsJuly: 1054")
    fb.append("  },")
    fb.append("  meta: { period: '2026年6月7日 — 8月28日 (W23-W35)', updatedAt: '2026-08-28 17:00' }")
    fb.append("};")
    with open(os.path.join(PUB, "data.fallback.js"), "w", encoding="utf-8") as f:
        f.write("\n".join(fb) + "\n")

    # ---------- public/app.js ----------
    boot = """
// ===== 启动：优先 API，失败回退离线兜底数据 =====
const API_ENDPOINT = window.ROOMSENSE_API || '/api/dashboard';

function applyKpi(D) {
  const kpi = D.kpi;
  if (!kpi) return;
  const set = (id, val, prefix) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) {
      el.textContent = (prefix || 'A$') + Number(val).toLocaleString('en-AU', {
        minimumFractionDigits: Number(val) % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2
      });
    }
  };
  set('kpi-total', kpi.total);
  set('kpi-week', kpi.thisWeek);
  set('kpi-net', kpi.netJuly);
  set('kpi-ads', kpi.adsJuly);
  if (D.meta) {
    const up = document.getElementById('meta-updated');
    if (up && D.meta.updatedAt) up.textContent = '更新时间：' + D.meta.updatedAt;
    const pr = document.getElementById('meta-period');
    if (pr && D.meta.period) pr.textContent = '数据周期：' + D.meta.period;
  }
}

function setStatus(text, ok) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'sync-status ' + (ok ? 'ok' : 'warn');
}

async function boot() {
  let data = null;
  try {
    const res = await fetch(API_ENDPOINT, { headers: { 'Accept': 'application/json' } });
    if (res.ok) {
      data = await res.json();
      if (data && data.weeklyData) {
        setStatus('● 数据源：在线数据库（实时）', true);
      } else {
        data = null;
      }
    }
  } catch (e) {
    data = null;
  }
  if (!data) {
    data = window.ROOMSENSE_FALLBACK;
    setStatus('● 数据源：本地兜底快照（未连接到数据库）', false);
  }
  renderDashboard(data);
  applyKpi(data);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
"""

    app = ["// RoomSense 看板渲染逻辑（由 tools/build_frontend.py 生成）",
           "// renderDashboard(DATA) 内部使用的数据全部来自参数 DATA：",
           "//   weeklyData / invData / skuWeeklyData / catData / platData / invSuggestData",
           "function renderDashboard(DATA) {",
           "  const {",
           "    weeklyData, invData, skuWeeklyData, catData, platData, invSuggestData",
           "  } = DATA;",
           ""]
    app.extend(kept)
    app.append("}  // end renderDashboard")
    app.append("")
    app.append(boot)
    with open(os.path.join(PUB, "app.js"), "w", encoding="utf-8") as f:
        f.write("\n".join(app) + "\n")

    # ---------- public/index.html ----------
    html = "\n".join(html_part)

    # KPI 元素加 id
    kpi_ids = {
        "CNA7pCFcEX4vQoZ4hu5gTb": "kpi-total",
        "65YKShkpsr5x4svjP3Gg7F": "kpi-net",
        "u9qTpYokYQFsKOD72uzYRn": "kpi-week",
        "VYt6CBabVeQzsHqW3G6RQ9": "kpi-ads",
    }
    for node_id, new_id in kpi_ids.items():
        html = html.replace(
            '<div class="kpi-value" data-page-node-id="%s">' % node_id,
            '<div class="kpi-value" id="%s" data-page-node-id="%s">' % (new_id, node_id))

    # 更新时间 / 数据周期 加 id
    html = html.replace(
        '数据周期：2026年6月7日 — 8月28日 (W23-W35)',
        '<span id="meta-period">数据周期：2026年6月7日 — 8月28日 (W23-W35)</span>')
    html = html.replace(
        '更新时间：2026-08-28 17:00',
        '<span id="meta-updated">更新时间：2026-08-28 17:00</span>')

    # 注入状态条样式 + 脚本引用
    status_css = """
  <style>
    .sync-status{display:inline-block;margin-left:8px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
    .sync-status.ok{background:#dcfce7;color:#166534}
    .sync-status.warn{background:#fef3c7;color:#92400e}
    .admin-entry{position:fixed;right:18px;bottom:18px;z-index:99;display:flex;gap:8px}
    .admin-entry a{padding:10px 16px;border-radius:10px;background:#4f46e5;color:#fff;
      text-decoration:none;font-size:13px;font-weight:600;box-shadow:0 6px 18px rgba(79,70,229,.35)}
    .admin-entry a.gray{background:#374151;box-shadow:0 6px 18px rgba(55,65,81,.3)}
  </style>
</head>"""
    html = html.replace("</head>", status_css, 1)

    # header meta 里插入状态标签
    html = html.replace(
        '<span class="dot" data-page-node-id="MbrfOG59voNdPFkBBstE7O"></span>',
        '<span class="dot" data-page-node-id="MbrfOG59voNdPFkBBstE7O"></span>'
        '<span id="sync-status" class="sync-status">● 正在加载数据…</span>', 1)

    # 原内联 <script>...</script> 已被移除，这里改为引用拆分后的两个外部脚本
    inject = (
        '<script src="./data.fallback.js"></script>\n'
        '<script src="./app.js"></script>\n'
        '<div class="admin-entry">'
        '<a href="./admin.html">数据录入 / 矫正</a>'
        '</div>\n'
    )
    html = html + inject + "\n".join(body_part)
    with open(os.path.join(PUB, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)

    print("生成完成:")
    for p in ["index.html", "app.js", "data.fallback.js"]:
        fp = os.path.join(PUB, p)
        print("  %-22s %8d bytes" % (p, os.path.getsize(fp)))
    print("源常量行数:", {k: v.count("\n") + 1 for k, v in blocks.items()})


if __name__ == "__main__":
    main()
