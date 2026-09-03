#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 seed.sql：把当前离线看板 dashboard.html 里已有的数据原样写入 D1。

策略（渐进接管）：
  现有数据其实是「聚合值」，没有订单明细，所以先全部以 overrides（人工矫正值）
  的形式落库 —— 部署后看板显示的内容与现在完全一致。
  等你导入了某张表的真实明细后，删掉对应的 override，就自动切换为按明细聚合：
    DELETE FROM overrides WHERE key LIKE 'weekly.%';   -- 周销售趋势改为自动聚合
    DELETE FROM overrides WHERE key LIKE 'skuWeek.%';  -- SKU 趋势改为自动聚合
    DELETE FROM overrides WHERE key='platData';        -- 平台分布改为自动聚合
    DELETE FROM overrides WHERE key='catData';         -- 品类分析改为自动聚合
库存 inventory / sku_master 是明细表，直接 INSERT。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(ROOT), "outputs", "dashboard.html")

CONSTS = ["weeklyData", "invData", "skuWeeklyData", "catData", "platData", "invSuggestData"]


def load_js_object(path):
    """用 py_mini 方式不可行，这里直接用正则抓取对应常量并通过 json5-ish 规范化解析"""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()

    out = {}
    for name in CONSTS:
        m = re.search(r"(?:const|let|var)\s+%s\s*=\s*" % name, text)
        if not m:
            raise RuntimeError("找不到常量 %s" % name)
        start = text.index("{", m.end()) if text[m.end()] in "{[" else None
        # 找到定义后的第一个 { 或 [
        i = m.end()
        while i < len(text) and text[i] not in "{[":
            i += 1
        open_ch = text[i]
        close_ch = "}" if open_ch == "{" else "]"
        depth = 0
        for j in range(i, len(text)):
            if text[j] in "{[":
                depth += 1
            elif text[j] in "}]":
                depth -= 1
                if depth == 0:
                    raw = text[i:j + 1]
                    break
        else:
            raise RuntimeError("括号未配平: %s" % name)
        out[name] = parse_js_literal(raw)
    return out


def parse_js_literal(raw):
    """把 JS 对象/数组字面量转成 Python：允许 单引号、尾逗号、null/true/false、裸 key"""
    s = raw
    # 裸 key -> 引号 key
    s = re.sub(r"([{,]\s*)([A-Za-z_$][\w$]*)\s*:", r'\1"\2":', s)
    # 单引号字符串 -> 双引号（内容里没有单引号双引号冲突的简单场景）
    def conv_str(m):
        body = m.group(1).replace('"', '\\"')
        return '"%s"' % body
    s = re.sub(r"'([^'\\]*)'", conv_str, s)
    # null / undefined
    s = re.sub(r"\bundefined\b", "null", s)
    # 去掉尾逗号
    s = re.sub(r",(\s*[}\]])", r"\1", s)
    # 行注释
    s = re.sub(r"//[^\n]*", "", s)
    return json.loads(s)


def esc(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    data = load_js_object(SRC)
    lines = [
        "-- 自动生成：把当前离线看板的数据灌入 D1（tools/build_seed.py）",
        "-- 执行: npx wrangler d1 execute roomsense-db --file=./seed.sql",
        "",
        "DELETE FROM overrides;",
        "DELETE FROM inventory;",
        "DELETE FROM sku_master;",
        "",
        "-- 1) 周销售趋势（人工矫正值，导入明细后可删）",
    ]

    for wk, val in data["weeklyData"].items():
        lines.append(
            "INSERT INTO overrides(key, value, note) VALUES('weekly.%s', '%s', '迁移自离线看板');"
            % (wk, val))

    lines.append("")
    lines.append("-- 2) SKU × 周 销量（人工矫正值）")
    labels = None
    for sku, arr in data["skuWeeklyData"].items():
        # skuWeeklyData 的周标签与 weeklyData 顺序一致（W23 起）
        weeks = list(data["weeklyData"].keys())
        for idx, qty in enumerate(arr):
            if qty is None:
                continue
            wk = weeks[idx] if idx < len(weeks) else "W%d" % (23 + idx)
            lines.append(
                "INSERT OR REPLACE INTO overrides(key, value, note) VALUES('skuWeek.%s.%s', '%s', '迁移自离线看板');"
                % (sku, wk, qty))

    lines.append("")
    lines.append("-- 3) 平台分布 / 品类分析（整体覆盖）")
    lines.append(
        "INSERT INTO overrides(key, value, note) VALUES('platData', %s, '迁移自离线看板');"
        % esc(json.dumps(data["platData"], ensure_ascii=False)))
    lines.append(
        "INSERT INTO overrides(key, value, note) VALUES('catData', %s, '迁移自离线看板');"
        % esc(json.dumps(data["catData"], ensure_ascii=False)))

    lines.append("")
    lines.append("-- 4) KPI")
    lines.append("INSERT INTO overrides(key, value, note) VALUES('kpi.total', '37852.38', '用户确认口径');")
    lines.append("INSERT INTO overrides(key, value, note) VALUES('kpi.thisWeek', '4737', '8/22-8/28 用户确认总额');")
    lines.append("INSERT INTO overrides(key, value, note) VALUES('kpi.netJuly', '13843', '7月净结算额');")
    lines.append("INSERT INTO overrides(key, value, note) VALUES('kpi.adsJuly', '1054', '7月广告投入');")

    lines.append("")
    lines.append("-- 5) SKU 主数据（品类）")
    for r in data["invData"]:
        sku = r.get("sku")
        if not sku:
            continue
        lines.append(
            "INSERT OR REPLACE INTO sku_master(sku, category, safety_days) VALUES(%s, %s, 21);"
            % (esc(sku), esc(r.get("type", ""))))

    lines.append("")
    lines.append("-- 6) 库存明细")
    for r in data["invData"]:
        sku = r.get("sku")
        if not sku:
            continue
        lines.append(
            "INSERT OR REPLACE INTO inventory(sku, on_hand, inbound, safety_stock, eta, updated_at) "
            "VALUES(%s, %s, %s, %s, %s, datetime('now'));" % (
                esc(sku),
                esc(r.get("inv", 0)),
                esc(r.get("recv", 0)),
                esc(r.get("safety", 0)),
                esc(r.get("eta", "") or ""),
            ))

    lines.append("")
    lines.append(
        "-- 7) 库存表在无销售明细时（d7/可售天数算不出来），先沿用离线看板的结论")
    lines.append(
        "INSERT INTO overrides(key, value, note) VALUES('invData', %s, '迁移自离线看板');"
        % esc(json.dumps(data["invData"], ensure_ascii=False)))
    lines.append(
        "INSERT INTO overrides(key, value, note) VALUES('invSuggestData', %s, '迁移自离线看板');"
        % esc(json.dumps(data["invSuggestData"], ensure_ascii=False)))

    out = os.path.join(ROOT, "seed.sql")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("生成 seed.sql: %d 行, %d bytes" % (len(lines), os.path.getsize(out)))
    print("SKU 数量:", len(data["skuWeeklyData"]), "| 库存行:", len(data["invData"]))


if __name__ == "__main__":
    main()
