#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
1) 重排「周销售统计」板块里的图表卡片
2) 在「周销售统计」板块末尾追加「产品定位矩阵」与「黑五行动计划」

用法: python3 tools/reorder_and_inject.py [dashboard.html 路径]
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(ROOT), "outputs", "dashboard.html")

# ============================================================
# 一、图表卡片的新顺序（按 canvas id）
#   各周销售额统计 → SKU周销售统计 → 各平台周销售占比
#   → (SKU累计销量 + 6月VS7月费用结构) → (库存水位状态 → 广告投放效果)
# ============================================================
CARDS = [
    ("weeklySalesChart", "各周销售额统计 (W23-W35)", ""),
    ("skuWeeklyChart", "SKU 周销售统计 (W23-W35)", "full"),
    ("channelChart", "各平台周销售占比", "full"),
    ("skuChart", "SKU 累计销量 TOP 10", ""),
    ("costChart", "6月 vs 7月 费用结构对比 (AUD)", ""),
    ("inventoryChart", "库存水位状态", ""),
    ("adChart", "广告投放效果 (Amazon 各 Campaign)", ""),
]

# ============================================================
# 二、产品定位矩阵
#   数据口径：W23-W35 累计销量（原始 Excel 聚合）；
#            估算销售额 = 累计销量 × W34 可核验周品类均价（床垫 A$332 / 枕头 A$43）；
#            动量 = 近4周(W32-35)周均 ÷ 前9周(W23-31)周均；
#            ACOS 来自 Amazon Campaign 数据（自动/手动）
# ============================================================
TAGS = {
    "主力加投":  ("#dbeafe", "#1e40af"),
    "潜力培育":  ("#dcfce7", "#166534"),
    "维持观察":  ("#f3f4f6", "#374151"),
    "减投去化":  ("#fef3c7", "#92400e"),
    "断货重启":  ("#ede9fe", "#5b21b6"),
    "清仓/停补": ("#fee2e2", "#991b1b"),
}

# sku, 品类, 13周销量, 近4周, 动量, 动销周, 库存, 在途, 可售天, ACOS(自动/手动), 估算销售, 定位, 黑五决策
POSITION = [
    ("XFKF-MA-1772-26-D", "床垫", 18, 10, "2.81 ↑", "9/13", 2, 20, "14", "7.3% / 27.7%", 5974,
     "主力加投", "库存告急，先补货再加投；手动广告 ACOS 27.7% 需压预算"),
    ("XFKF-MA-1666-34-Q", "床垫", 14, 6, "1.69 ↑", "9/13", 19, 34, "33", "6.4% / 50.5%(已停)", 4647,
     "主力加投", "自动广告 ACOS 6.4% 全场最优，加大投流；手动保持暂停"),
    ("XFKF-MA-1667-30-K", "床垫", 6, 4, "4.50 ↑↑", "4/13", 18, 25, "待核验", "4.6% / 10.4%", 1991,
     "主力加投", "动量最强（4.5x），加大投流测试；动销周偏少需先养 Listing"),
    ("XFKF-PL-1167F-WH", "枕头", 28, 11, "1.46 ↑", "8/13", 25, 53, "待核验", "9.4% (已停)", 1204,
     "潜力培育", "枕头线唯一在跑的款，补货到位后重启广告，主推加购"),
    ("XFKF-MA-1772-26-Q", "床垫", 20, 5, "0.75 ↓", "8/13", 44, 64, "314", "7.3% / 27.7%", 6638,
     "减投去化", "销售额第一但动量下滑，可售 314 天严重过剩，黑五去库存"),
    ("XFKF-MA-1667-30-D", "床垫", 11, 2, "0.50 ↓", "8/13", 19, 30, "待核验", "4.6% / 10.4%", 3651,
     "维持观察", "动量下滑但 ACOS 优秀，维持预算，黑五观察转化"),
    ("XFKF-MA-1772-26-KS", "床垫", 8, 2, "0.75 ↓", "6/13", 22, 30, "157", "7.3% / 27.7%", 2655,
     "减投去化", "可售 157 天，减少手动广告预算，黑五捆绑去化"),
    ("XFKF-MA-1772-26-S", "床垫", 7, 2, "0.90 →", "4/13", 12, 20, "待核验", "7.3% / 27.7%", 2323,
     "减投去化", "动销仅 4/13 周，暂停手动广告，仅保留自动"),
    ("XFKF-PL-1168R-WH", "枕头", 21, 4, "0.53 ↓", "7/13", 27, 48, "93", "9.4% (已停)", 903,
     "减投去化", "可售 93 天、动销放缓，暂不重开广告，黑五清一波"),
    ("XFKF-PL-1169R-WH", "枕头", 43, 0, "0.00 断货", "7/13", 0, 43, "0", "9.4% (已停)", 1849,
     "断货重启", "销量冠军断货 5 周，到货后立刻重开广告冲黑五，建议补 150 件"),
    ("XFKF-MA-1666-34-S", "床垫", "<6", "-", "—", "未进TOP10", 7, 10, "待核验", "6.4% / 50.5%(已停)", None,
     "清仓/停补", "13周销量未进 TOP10，暂停追加补货，黑五捆绑/Outlet 出清"),
    ("XFKF-MA-1666-34-KS", "床垫", "<6", "-", "—", "未进TOP10", 12, 15, "待核验", "6.4% / 50.5%(已停)", None,
     "清仓/停补", "同上，先核验 Listing 是否正常上架与曝光"),
    ("XFKF-MA-1666-34-D", "床垫", "<6", "-", "—", "未进TOP10", 7, 10, "待核验", "6.4% / 50.5%(已停)", None,
     "清仓/停补", "同上"),
    ("XFKF-MA-1667-30-S", "床垫", "<6", "-", "—", "未进TOP10", 11, 15, "待核验", "4.6% / 10.4%", None,
     "清仓/停补", "同上；系列 ACOS 健康，可留一件做黑五凑单品"),
    ("XFKF-MA-1667-30-KS", "床垫", "<6", "-", "—", "未进TOP10", 13, 15, "待核验", "4.6% / 10.4%", None,
     "清仓/停补", "同上"),
    ("XFKF-MA-1667-30-Q", "床垫", "<6", "-", "—", "未进TOP10", 32, 39, "110", "4.6% / 10.4%", None,
     "清仓/停补", "压货最重：库存 32 + 在途 39 = 71 件，立即暂停补货并出清"),
]

# ============================================================
# 三、黑五行动计划（黑五 2026-11-27，今天 T-86）
# ============================================================
ACTIONS = [
    ("XFKF-MA-1772-26-D", "主力加投",
     "立即补 30 件（空运，海运来不及）",
     "10/27 起自动广告预算 +60%",
     "黑五主推款，手动广告 ACOS 压到 20% 以内再加",
     "黑五周销 25 件+"),
    ("XFKF-MA-1666-34-Q", "主力加投",
     "确认在途 34 件到仓时间",
     "自动广告预算 +50%，手动保持暂停",
     "黑五主推款，配合 Coupon 拉转化",
     "黑五周销 20 件+"),
    ("XFKF-MA-1667-30-K", "主力加投",
     "补 20 件；Listing 补图与 A+ 页面",
     "启动手动精准词，小预算测试",
     "若 ROAS 稳住 8 以上，黑五当周翻倍预算",
     "黑五周销 12 件+"),
    ("XFKF-PL-1167F-WH", "潜力培育",
     "确认在途 53 件到仓；重启 PL-WH 自动广告",
     "广告预算回到 A$20/天，观察 ACOS",
     "作为床垫加购品做捆绑（床垫+枕头套装）",
     "黑五周销 15 件+"),
    ("XFKF-MA-1772-26-Q", "减投去化",
     "暂停追加补货（在途 64 件已足够）",
     "广告预算 -30%，手动广告暂停",
     "黑五用「Queen 特价 + 枕頭加购」去库存",
     "去化 30 件库存"),
    ("XFKF-MA-1667-30-D", "维持观察",
     "维持现有库存节奏",
     "预算不变，每周复盘 ROAS",
     "黑五维持常态投放，不追量",
     "稳住周均 1 件"),
    ("XFKF-MA-1772-26-KS", "减投去化",
     "暂停补货（在途 30 件）",
     "手动广告预算 -50%",
     "黑五捆绑出清（KS + 枕頭组合）",
     "去化 15 件库存"),
    ("XFKF-MA-1772-26-S", "减投去化",
     "暂停补货（在途 20 件）",
     "仅保留自动广告，手动全停",
     "黑五不单独投，做凑单赠品",
     "去化 8 件库存"),
    ("XFKF-PL-1168R-WH", "减投去化",
     "暂停补货（在途 48 件）",
     "广告保持暂停",
     "黑五清仓价出清，回笼现金",
     "去化 20 件库存"),
    ("XFKF-PL-1169R-WH", "断货重启",
     "补 150 件（海运+空运拆分，先空运 50 件救急）",
     "到货即重启 PL-WH 自动广告，预算 A$30/天",
     "黑五冲枕头线销量王，重养 Listing 权重",
     "到货后 4 周内销 60 件"),
    ("6 个未动销 SKU", "清仓/停补",
     "暂停所有追加补货；核验 Listing 上架状态与曝光",
     "不投放广告；做站内 Outlet / 捆绑",
     "黑五清仓专场，定价保本或微亏出清",
     "出清 82 件库存 + 拦截 104 件在途"),
]


def tag(text):
    bg, fg = TAGS.get(text, ("#f3f4f6", "#374151"))
    return '<span class="tag" style="background:%s;color:%s;font-weight:700">%s</span>' % (bg, fg, text)


def extract_cards(html):
    """提取所有 chart-card 的完整 HTML，按 canvas id 索引"""
    cards = {}
    for m in re.finditer(r'<div class="chart-card"', html):
        start = m.start()
        depth = 0
        i = start
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
        block = html[start:i]
        cid = re.search(r'<canvas id="([^"]+)"', block)
        if cid:
            cards[cid.group(1)] = block
    return cards


def rebuild_chart_section(html):
    cards = extract_cards(html)

    # 只重排「周销售统计」板块里的 7 张卡
    order = [c[0] for c in CARDS]
    missing = [c for c in order if c not in cards]
    if missing:
        raise RuntimeError("找不到图表卡片: %s" % missing)

    out = []
    for cid, title, grid_cls in CARDS:
        block = cards[cid]
        # 同步更新卡片标题
        block = re.sub(r'(<h3[^>]*>)[^<]*(</h3>)', lambda m: m.group(1) + title + m.group(2),
                       block, count=1)
        cls = "chart-grid full" if grid_cls == "full" else "chart-grid"
        out.append('  <div class="%s">\n%s\n  </div>\n' % (cls, block))

    new_block = "\n".join(out)

    # 定位替换区间：从「周销售统计」标题之后，到 <!-- Inventory Table --> 之前
    start = html.index('周销售统计</div>') + len('周销售统计</div>')
    end = html.index('<!-- Inventory Table -->')
    return html[:start] + "\n" + new_block + "\n  " + html[end:]


def build_position_section():
    rows = []
    for (sku, cat, qty, r4, mom, act, inv, recv, days, acos, rev, pos, dec) in POSITION:
        rev_s = "A$%s" % format(rev, ",") if rev else "—"
        rows.append(
            "        <tr>\n"
            "          <td><strong>%s</strong></td>\n"
            "          <td>%s</td>\n"
            "          <td>%s</td>\n"
            "          <td>%s</td>\n"
            "          <td>%s</td>\n"
            "          <td>%s</td>\n"
            "          <td>%s</td>\n"
            "          <td>%s</td>\n"
            "          <td>%s</td>\n"
            "          <td style=\"font-size:12px\">%s</td>\n"
            "          <td>%s</td>\n"
            "          <td>%s</td>\n"
            "          <td style=\"font-size:12px;color:#4b5563\">%s</td>\n"
            "        </tr>" % (sku, cat, qty, r4, mom, act, inv, recv, days, acos, rev_s, tag(pos), dec))

    return """
  <!-- Product Positioning Matrix -->
  <div class="section-title">产品定位矩阵 · 黑五投流与清仓决策</div>
  <div class="table-card">
    <h3>产品定位矩阵（基于 W23-W35 销售数据）</h3>
    <table>
      <thead>
        <tr>
          <th>SKU</th><th>品类</th><th>13周销量</th><th>近4周</th><th>动量</th>
          <th>动销周</th><th>库存</th><th>在途</th><th>可售天</th>
          <th>ACOS 自动/手动</th><th>估算销售额</th><th>定位</th><th>黑五决策</th>
        </tr>
      </thead>
      <tbody>
%s
      </tbody>
    </table>
    <div style="margin-top:12px;font-size:12px;color:#6b7280;line-height:1.8">
      <strong>口径说明：</strong>13周销量来自原始订单聚合（W23-W35）；
      估算销售额 = 累计销量 × W34 可核验周品类均价（床垫 A$332 / 枕头 A$43），<b>为估算值</b>；
      动量 = 近4周(W32-35)周均 ÷ 前9周(W23-31)周均，&gt;1.2 上升、0.8-1.2 平稳、&lt;0.8 下滑；
      ACOS 来自 Amazon Campaign（1÷ROAS）；可售天数来自库存 / 日均销，标"待核验"表示销量过低无法测算。<br>
      <strong>结论速览：</strong>主力加投 3 款（MA-1772-26-D、MA-1666-34-Q、MA-1667-30-K）·
      潜力培育 1 款（PL-1167F）· 减投去化 5 款 · 断货重启 1 款（PL-1169R）·
      清仓/停补 6 款（合计库存 82 件 + 在途 104 件）。
    </div>
  </div>
""" % ("\n".join(rows))


def build_action_section():
    rows = []
    for (sku, pos, a1, a2, a3, goal) in ACTIONS:
        rows.append(
            "        <tr>\n"
            "          <td><strong>%s</strong></td>\n"
            "          <td>%s</td>\n"
            "          <td style=\"font-size:12.5px\">%s</td>\n"
            "          <td style=\"font-size:12.5px\">%s</td>\n"
            "          <td style=\"font-size:12.5px\">%s</td>\n"
            "          <td style=\"font-weight:700;color:#4f46e5\">%s</td>\n"
            "        </tr>" % (sku, tag(pos), a1, a2, a3, goal))

    return """
  <!-- Black Friday Action Plan -->
  <div class="section-title">黑五行动计划（按 SKU）</div>
  <div class="table-card">
    <h3>黑五行动计划 · 黑五 2026-11-27（今天 T-86）</h3>
    <table>
      <thead>
        <tr>
          <th>SKU</th><th>定位</th>
          <th>立即动作（9月 · T-86）</th>
          <th>10月动作（T-55 → T-30）</th>
          <th>黑五动作（11月 T-30 → T-0）</th>
          <th>目标</th>
        </tr>
      </thead>
      <tbody>
%s
      </tbody>
    </table>
    <div style="margin-top:12px;font-size:12px;color:#6b7280;line-height:1.8">
      <strong>关键时点：</strong>海运 45-60 天 / 空运 15-20 天 —— 现在下单海运，10 月底到仓是最后窗口；
      9月28日前（T-60）完成 Listing 与 A+ 页面优化；10月27日（T-30）启动广告预热；
      11月27-30 日黑五网一爆发。<br>
      <strong>优先级：</strong>① PL-1169R 补货救急（销量冠军断货 5 周）→
      ② MA-1772-26-D 补货（库存仅 2 件）→
      ③ 暂停 6 个未动销 SKU 的追加补货（可拦截在途 104 件）。
    </div>
  </div>
""" % ("\n".join(rows))


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        html = f.read()

    html = rebuild_chart_section(html)

    anchor = "  <!-- Inventory Table -->"
    inject = build_position_section() + build_action_section() + "\n"
    html = html.replace(anchor, inject + anchor, 1)

    with open(SRC, "w", encoding="utf-8") as f:
        f.write(html)

    print("已更新:", SRC)
    print("  - 图表卡片重排为 7 张，新顺序：")
    for i, (cid, title, cls) in enumerate(CARDS, 1):
        print("     %d. %s%s" % (i, title, "  [整行]" if cls == "full" else ""))
    print("  - 新增「产品定位矩阵」%d 行" % len(POSITION))
    print("  - 新增「黑五行动计划」%d 行" % len(ACTIONS))


if __name__ == "__main__":
    main()
