/**
 * 前端毛利面板（public/margin.js）的渲染测试
 *
 * 用最小 DOM 桩跑，不引 jsdom —— 只验证「有没有渲染出该有的东西」和「缺数据时会不会编造」。
 *
 * 跑法：node tools/test_margin_ui.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log('  \x1b[32m✔\x1b[0m ' + m); }
  else { fail++; console.log('  \x1b[31m✘\x1b[0m ' + m + (d ? '  → ' + d : '')); }
};

/* ---------- 最小 DOM 桩 ---------- */
function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', hidden: false, _lis: [],
    querySelectorAll(sel) {
      // 只支持 .margin-caveat li
      if (!/margin-caveat li/.test(sel)) return [];
      const n = (this.innerHTML.match(/<li><\/li>/g) || []).length;
      const self = this;
      return Array.from({ length: n }, (_, i) => ({
        set textContent(v) { self._lis[i] = v; },
        get textContent() { return self._lis[i]; },
      }));
    },
  };
}

/** 预建 margin-panel —— margin.js 只认这一个 id */
function withDom() {
  const els = { 'margin-panel': makeEl('margin-panel') };
  global.document = { getElementById: (id) => els[id] || null };
  global.window = {};
  return els;
}

/** 口径提醒是用 textContent 写的（防 XSS），所以要读 _lis 而不是 innerHTML */
const caveats = (box) => box._lis || [];

function loadMargin() {
  const src = readFileSync(join(ROOT, 'public/margin.js'), 'utf8');
  new Function(src)();          // margin.js 是 IIFE，挂到 window.RoomSenseMargin
  return global.window.RoomSenseMargin;
}

/* ---------- 构造数据 ---------- */
const baseRow = (over = {}) => ({
  sku: 'XFKF-MA-1772-26-D', cat: '床垫', qty: 10, revenue: 3000, asp: 300,
  unitCostAud: 148.94, fulfilPct: 30, unitFulfil: 90, unitMargin: 61.06,
  marginPct: 20.35, grossProfit: 610.64, adsSpend: 375, acos: 12.5,
  netProfit: 235.64, netPct: 7.85, safety: 7.85, hasCost: true,
  ...over,
});
const baseData = (rows, over = {}) => ({
  marginData: {
    month: '2026-08', fulfilPct: 30, fulfilPctConfirmed: false, fxAudCny: 4.7,
    adsTotal: 375, adsHasData: true, adsAllocated: 375,
    missingCost: 0, skuCount: rows.length, rows, ...over,
  },
});

/* ============================================================
 * 1. 正常渲染
 * ========================================================== */
console.log('\n===== 1. 正常渲染 =====');
{
  const els = withDom();
  const M = loadMargin();
  const box = els['margin-panel'];
  M.render(baseData([baseRow()]));

  ok(box.hidden === false, '有数据 → 面板显示');
  ok(/2026 年 08 月/.test(box.innerHTML), '标题带月份', box.innerHTML.slice(0, 120));
  ok(/安全垫 = 毛利率 − ACOS/.test(box.innerHTML), '副标题写明判据');
  ok(/XFKF-MA-1772-26-D/.test(box.innerHTML), '渲染出 SKU');
  ok(/A\$300/.test(box.innerHTML), 'ASP 用 A$ 格式化');
  ok(/\+7\.[89]/.test(box.innerHTML), '安全垫 7.85 显示为带正号的一位小数',
    box.innerHTML.match(/\+7\.\d/)?.[0] || '未匹配');
  ok(/稳赚·可加投/.test(box.innerHTML), '安全垫 7.85 → 「稳赚·可加投」');
  ok(caveats(box).some((c) => /估算值 30%/.test(c)),
    '费率未核实 → 口径提醒里写明是估算值', JSON.stringify(caveats(box)));
}

/* ============================================================
 * 2. 决策分档
 * ========================================================== */
console.log('\n===== 2. 决策分档（按安全垫）=====');
{
  const cases = [
    [25, '厚利·主力加投'],
    [7.85, '稳赚·可加投'],
    [2, '薄利·维持'],
    [-5, '投流亏损·减投'],
  ];
  for (const [safety, expect] of cases) {
    const els = withDom();
    loadMargin().render(baseData([baseRow({ safety })]));
    const html = els['margin-panel'].innerHTML;
    ok(html.includes(expect), `安全垫 ${safety} → ${expect}`,
      html.match(/>([^<]*加投|[^<]*维持|[^<]*减投)</)?.[1] || '未匹配');
  }
}

/* ============================================================
 * 3. 缺数据时不能编造
 * ========================================================== */
console.log('\n===== 3. 缺数据的降级（关键：不许编造）=====');
{
  // 3a. 缺采购成本
  const e1 = withDom();
  loadMargin().render(baseData([baseRow({
    hasCost: false, unitMargin: null, marginPct: null, grossProfit: null,
    netProfit: null, netPct: null, safety: null, unitCostAud: null,
  })], { missingCost: 1 }));
  const h1 = e1['margin-panel'].innerHTML;
  ok(/待填成本/.test(h1), '缺成本 → 决策显示「待填成本」');
  ok(/待填/.test(h1), '单件成本单元格显示「待填」');
  ok(!/加投/.test(h1), '缺成本时绝不给出「加投」建议');
  ok(caveats(e1['margin-panel']).some((c) => /1\/1 个 SKU 还没填采购成本/.test(c)),
    '口径提醒里说明缺几个 SKU', JSON.stringify(caveats(e1['margin-panel'])));

  // 3b. 有成本但没广告数据
  const e2 = withDom();
  loadMargin().render(baseData([baseRow({ acos: null, safety: null, adsSpend: 0 })],
    { adsHasData: false, adsTotal: 0 }));
  const h2 = e2['margin-panel'].innerHTML;
  ok(/缺广告数据/.test(h2), '无 ACOS → 决策显示「缺广告数据」');
  ok(/20\.4%/.test(h2), '但毛利率 20.35% 照常显示（这部分是真的）');
  ok(caveats(e2['margin-panel']).some((c) => /没有广告数据/.test(c)),
    '口径提醒说明缺广告数据', JSON.stringify(caveats(e2['margin-panel'])));

  // 3c. 本月无销量
  const e3 = withDom();
  loadMargin().render(baseData([baseRow({ qty: 0, revenue: 0, asp: 0 })]));
  ok(/本月无销量/.test(e3['margin-panel'].innerHTML), '8 月没卖动 → 不谈投流');
}

/* ============================================================
 * 4. 没有 marginData 时静默隐藏
 * ========================================================== */
console.log('\n===== 4. 无数据 → 隐藏（离线兜底场景）=====');
{
  const els = withDom();
  loadMargin().render({ weeklyData: {}, invData: [] });   // 老格式兜底数据
  ok(els['margin-panel'].hidden === true, '兜底数据没有 marginData → 面板隐藏，不报错');

  const e2 = withDom();
  loadMargin().render({ marginData: { rows: [] } });
  ok(e2['margin-panel'].hidden === true, 'rows 为空 → 隐藏');

  const e3 = withDom();
  loadMargin().render(undefined);
  ok(e3['margin-panel'].hidden === true, '传 undefined 也不崩');
}

/* ============================================================
 * 5. XSS 防护：口径提醒用 textContent 写
 * ========================================================== */
console.log('\n===== 5. XSS 防护 =====');
{
  const els = withDom();
  loadMargin().render(baseData([baseRow()]));
  const box = els['margin-panel'];
  const lis = box.querySelectorAll('.margin-caveat li');
  ok(lis.length > 0, '生成了口径提醒条目', String(lis.length));
  ok(lis.every((l) => typeof l.textContent === 'string' && l.textContent.length > 0),
    '提醒文本通过 textContent 写入（不当 HTML 解析）');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
