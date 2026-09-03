#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 4 个图表模块（SKU 累计销量 / 6月vs7月费用结构 / 库存水位 / 广告投放效果）
折叠进可隐藏面板：默认收起，点击按钮展开；展开后两列紧凑布局。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(ROOT), "outputs", "dashboard.html")

TARGET_IDS = ["skuChart", "costChart", "inventoryChart", "adChart"]


def find_chart_card(html, start, canvas_id):
    """从 start 开始向下找包含 canvas_id 的 chart-card 完整块"""
    m = re.search(r'<div class="chart-card"', html[start:])
    if not m:
        return None, -1, -1
    card_start = start + m.start()
    depth = 0
    i = card_start
    while i < len(html):
        if html.startswith("<div", i):
            depth += 1
            i += 4
        elif html.startswith("</div>", i):
            depth -= 1
            i += 6
            if depth == 0:
                break
        else:
            i += 1
    return html[card_start:i], card_start, i


def find_parent_grid(html, card_start):
    """从 card_start 向上找最近一个 chart-grid 容器的开头"""
    return html.rfind('<div class="chart-grid"', 0, card_start)


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        html = f.read()

    # 1) 定位 4 张卡的 chart-card
    #    从 canvas id 位置向上找最近的 <div class="chart-card"，再向下 div 配平
    cards = {}
    for cid in TARGET_IDS:
        m = re.search(r'<canvas id="%s"' % cid, html)
        if not m:
            raise RuntimeError("找不到 canvas: " + cid)
        canvas_pos = m.start()
        # 向上找最近的 chart-card 起点
        card_start = html.rfind('<div class="chart-card', 0, canvas_pos)
        if card_start < 0:
            raise RuntimeError("找不到 chart-card 容器: " + cid)
        # 向下 div 配平
        depth = 0
        i = card_start
        while i < len(html):
            if html.startswith("<div", i):
                depth += 1
                i += 4
            elif html.startswith("</div>", i):
                depth -= 1
                i += 6
                if depth == 0:
                    break
            else:
                i += 1
        cards[cid] = html[card_start:i]

    # 2) 删除原 2 个 chart-grid（包含这 4 张卡的两个 row）
    #    找到每个 card 的父 chart-grid 边界
    grid_starts = set()
    grid_ends = set()
    for cid, block in cards.items():
        idx = html.index(block)
        g_start = html.rfind('<div class="chart-grid', 0, idx)
        # 找到 grid 结束
        depth = 0
        i = g_start
        while i < len(html):
            if html.startswith("<div", i):
                depth += 1
                i += 4
            elif html.startswith("</div>", i):
                depth -= 1
                i += 6
                if depth == 0:
                    break
            else:
                i += 1
        grid_starts.add(g_start)
        grid_ends.add(i)

    # 合并相邻 grid 区间（同一段可能被两个 card 共享）
    # 实际上 Row3 和 Row4 是不同 grid，各自有 start/end
    ranges = sorted(zip(grid_starts, grid_ends))
    merged = []
    for s, e in ranges:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))

    # 注意：每个 chart-card 各自包在一个独立的 chart-grid 里（前一次重排的结果），
    # 所以这里会得到 4 个相邻区间。删除边界必须严格用 grid 自身位置，
    # 绝对不能向前找 "<!-- Charts Row" 注释 —— 那会误删前面不相关的模块。
    first_start = merged[0][0]
    last_end = merged[-1][1]
    # 向后跳到换行，吃掉尾部的空行
    nl = html.find("\n", last_end)
    delete_end = nl + 1 if nl != -1 else last_end

    # 安全校验：被删区间里只能包含目标 4 个 canvas，不能含其他 canvas
    deleted = html[first_start:delete_end]
    other_canvas = [c for c in re.findall(r'<canvas id="([^"]+)"', deleted)
                    if c not in TARGET_IDS]
    if other_canvas:
        raise RuntimeError("删除区间内包含非目标 canvas，已中止: %s" % other_canvas)

    html = html[:first_start] + html[delete_end:]

    # 3) 构造新的 collapsible 块（顺序：sku → cost → inventory → ad）
    new_block = """  <!-- Detail Analysis (Collapsible) -->
  <div class="collapsible-section" id="detailAnalysis">
    <button class="collapse-toggle" type="button" onclick="toggleCollapse('detailAnalysis')" aria-expanded="false">
      <span class="caret">▸</span>
      <span class="label">细节分析（4 个模块）</span>
      <span class="hint">SKU 累计销量 · 6月vs7月费用结构 · 库存水位状态 · 广告投放效果</span>
    </button>
    <div class="collapsible-body" hidden>
      <div class="chart-grid narrow">
%s
      </div>
    </div>
  </div>

""" % "\n".join("        " + cards[c] for c in TARGET_IDS)

    html = html[:first_start] + new_block + html[first_start:]

    # 4) 注入 CSS（在 .chart-container.tall 规则后追加）
    css_anchor = ".chart-container.tall { height: 360px; }"
    css_new = """
  /* Collapsible detail panel */
  .collapsible-section { margin-bottom: 16px; }
  .collapse-toggle {
    width: 100%;
    display: flex; align-items: center; gap: 10px;
    background: #f3f4f6;
    border: 1px dashed #d1d5db;
    border-radius: 10px;
    padding: 12px 16px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    color: #4b5563;
    text-align: left;
    transition: background .15s, border-color .15s, color .15s;
  }
  .collapse-toggle:hover { background: #e5e7eb; }
  .collapse-toggle .caret {
    display: inline-block;
    font-size: 11px;
    color: #6b7280;
    transition: transform .2s;
  }
  .collapse-toggle .hint {
    margin-left: auto;
    font-size: 12px;
    color: #9ca3af;
    font-weight: 400;
  }
  .collapsible-section.open .collapse-toggle {
    background: #eef2ff;
    border-color: #c7d2fe;
    color: #4338ca;
  }
  .collapsible-section.open .collapse-toggle .caret { transform: rotate(90deg); }
  .collapsible-body { margin-top: 12px; }
  .collapsible-section.open [hidden] { display: block !important; }

  /* Narrow 2-column layout for collapsible detail cards */
  .chart-grid.narrow {
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 0;
  }
  .chart-grid.narrow .chart-card { padding: 16px; }
  .chart-grid.narrow .chart-card h3 { font-size: 14px; margin-bottom: 10px; }
  .chart-grid.narrow .chart-container { height: 240px; }
  .chart-grid.narrow .chart-container.tall { height: 280px; }
"""
    if css_anchor in html:
        html = html.replace(css_anchor, css_anchor + css_new, 1)
    else:
        raise RuntimeError("CSS 锚点丢失: " + css_anchor)

    # 5) 注入 JS：toggleCollapse 全局函数（插在主内联 </script> 之前）
    if "function toggleCollapse" not in html:
        js_new = """
function toggleCollapse(id) {
  const sec = document.getElementById(id);
  if (!sec) return;
  const open = sec.classList.toggle('open');
  const body = sec.querySelector('.collapsible-body');
  if (body) body.hidden = !open;
  const btn = sec.querySelector('.collapse-toggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && window.Chart) {
    requestAnimationFrame(() => {
      sec.querySelectorAll('canvas').forEach(c => {
        const inst = Chart.getChart(c);
        if (inst) inst.resize();
      });
    });
  }
}

"""
        # 找主内联 script 闭合标签（最后一个 </script>）
        script_close = html.rfind("</script>")
        if script_close < 0:
            raise RuntimeError("找不到 </script> 锚点")
        html = html[:script_close] + js_new + html[script_close:]

    with open(SRC, "w", encoding="utf-8") as f:
        f.write(html)

    # 报告删除区段内容片段（用于确认）
    print("已更新:", SRC)
    print("  - 移除 %d 个 chart-grid 容器（包含 4 张卡）" % len(merged))
    print("  - 新增 1 个 collapsible 面板（默认收起）")
    print("  - 展开后 2 列紧凑布局：chart-card padding 24→16，chart-container 高度 300→240")


if __name__ == "__main__":
    main()
