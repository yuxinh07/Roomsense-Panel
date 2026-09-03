/**
 * 多币种 / 邮费收入 专项测试
 *
 * 跑法：node --experimental-sqlite tools/test_fx.mjs
 *
 * 校验口径（2026-09-03 与 Yitta 确认）：
 *   营收(AUD) = (商品销售额 + 邮费收入) × 汇率
 *   goods / shipping 存原币种，fx_rate 是「原币种 → AUD」，revenue 是折算后 AUD
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolveAmounts, buildDashboard, importCsv } from '../src/worker.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✔ ${msg}`);
  } else {
    fail++;
    console.log(`  ✘ ${msg} ${extra}`);
  }
};
const near = (a, b) => Math.abs(a - b) < 0.005;

/* ---------- 1. 单函数测试 ---------- */
console.log('\n===== resolveAmounts 单测 =====\n');

const meta = { fx_usd_aud: '1.50' };

// 1) USD 商品 + 邮费，行内汇率
{
  const r = { currency: 'USD', goods: 100, shipping: 20, fx_rate: 1.5, week_label: 'W35' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 180), 'USD 商品100 + 邮费20，汇率1.5 → 180', JSON.stringify(a));
  ok(a.goods === 100 && a.shipping === 20, '  └ goods/shipping 存原币种');
  ok(a.currency === 'USD' && near(a.fx, 1.5), '  └ currency/fx 正确');
}

// 2) USD 没填行内汇率 → 用 meta.fx_usd_aud 兜底
{
  const r = { currency: 'USD', goods: 100, shipping: 0, week_label: 'W34' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 150), 'USD 无行内汇率，用全局 fx_usd_aud=1.5 → 150', JSON.stringify(a));
}

// 3) 只填销售额 + USD → 整笔折算
{
  const r = { currency: 'USD', revenue: 200, week_label: 'W34' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 300), 'USD 只填销售额 200 → 300', JSON.stringify(a));
  ok(a.shipping === 0, '  └ 邮费补 0');
}

// 4) 历史兼容：只填销售额 + AUD → fx=1，原值不变
{
  const r = { revenue: 4737, week_label: 'W35' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 4737) && a.fx === 1, '只填销售额+无币种 → fx=1，营收=4737（兼容历史）', JSON.stringify(a));
}

// 5) 历史兼容：币种显式写 AUD
{
  const r = { currency: 'AUD', revenue: 1234.5, week_label: 'W35' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 1234.5), '币种 AUD → 不折算，仍是 1234.5', JSON.stringify(a));
}

// 6) USD 缺汇率（行内没填 + meta=0）→ fx=0，营收按 0 计
{
  const saveMeta = { fx_usd_aud: '0' };
  const r = { currency: 'USD', goods: 100, shipping: 20, week_label: 'W35' };
  const a = resolveAmounts(r, saveMeta);
  ok(near(a.revenueAud, 0) && a.fx === 0, 'USD 缺汇率 → fx=0，营收按 0 计（不静默当 1）', JSON.stringify(a));
}

// 7) 其他币种（EUR/GBP）→ fx=0，营收按 0 计（暂不支持）
{
  const r = { currency: 'EUR', goods: 100, shipping: 0, fx_rate: 1.6, week_label: 'W34' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 0) && a.fx === 0, 'EUR → fx=0（当前架构只支持 AUD/USD）', JSON.stringify(a));
}

// 8) 中文列名
{
  const r = { 币种: 'USD', 平台销售额: 200, 运费收入: 30, 汇率: 1.5, 周次: 'W34' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 345), '中文列名：平台销售额200 + 运费30，汇率1.5 → 345', JSON.stringify(a));
}

// 9) 带货币符号和千分位
{
  const r = { currency: 'usd', goods: '1,234.50', shipping: '$65.50', fx_rate: 1.5, week_label: 'W34' };
  const a = resolveAmounts(r, meta);
  ok(near(a.goods, 1234.5) && near(a.shipping, 65.5), '清洗 $ 和千分位：1,234.50 / $65.50', JSON.stringify(a));
  ok(near(a.revenueAud, 1950), '  └ 折算营收 = (1234.5+65.5)×1.5 = 1950', JSON.stringify(a));
  ok(a.currency === 'USD', '  └ 币种小写 usd 归一为 USD');
}

// 10) 空值不误判
{
  const r = { currency: '', goods: '', shipping: '', revenue: '500', week_label: 'W35' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 500), '空字符串列被跳过，落到销售额 500', JSON.stringify(a));
}

// 12) AUD 行写不写汇率都不被折算
{
  const r = { currency: 'AUD', goods: 100, shipping: 0, fx_rate: 99, week_label: 'W34' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 100) && a.fx === 1, 'AUD 行 ×99 也不行，fx 强制为 1', JSON.stringify(a));
}

// 13) 英文列名 + 单价自动 × Qty —— 模拟 Yitta 截图里的 Temu - US 那行
{
  const r = {
    Channel: 'Temu - US',
    'Transaction ID': 'PO-012-15335115361910658',
    SKU: 'XFKF-MA-1772-26-KS',
    Qty: 1,
    'Unit Price ex.GST': 120,
    'Postage ex.GST': 0,
    'Sales Currency': 'USD',
    'Order Rate to AUD': 1.5483,
  };
  const a = resolveAmounts(r, meta);
  // 120 × 1 = 120 USD，× 1.5483 = 185.796 → 186 AUD
  ok(near(a.goods, 120) && near(a.shipping, 0), '英文列名解析：单价120 / 邮费单价0', JSON.stringify(a));
  ok(near(a.revenueAud, 185.796), '  └ 单价×Qty=120 USD × 1.5483 = 185.796 AUD', JSON.stringify(a));
  ok(a.currency === 'USD' && near(a.fx, 1.5483), '  └ 币种/汇率正确');
}

// 14) 英文列名 + Qty>1 时邮费也乘数量
{
  const r = {
    Qty: 3, 'Unit Price ex.GST': 50, 'Postage ex.GST': 8,
    'Sales Currency': 'AUD', 'Order Rate to AUD': 1,
  };
  const a = resolveAmounts(r, meta);
  // (50 + 8) × 3 × 1 = 174 AUD
  ok(near(a.goods, 150) && near(a.shipping, 24), 'Qty=3 时邮费也乘：商品150 / 邮费24', JSON.stringify(a));
  ok(near(a.revenueAud, 174), '  └ 营收 = (150+24) × 1 = 174 AUD');
}

// 15) 旧格式「销售额」+ 无币种 → fx=1（兼容历史）
{
  const r = { revenue: 100 };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 100) && a.fx === 1, '旧格式销售额，无币种 → AUD 100', JSON.stringify(a));
}

/* ---------- 2. 端到端：建库 → 插混合币种 → 聚合 ---------- */
console.log('\n===== 端到端：D1 模拟 =====\n');

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

/** 把 node:sqlite 包装成 D1 的接口形态（与 test_local.mjs 同一套）
 *  注意：bind() 必须返回【新的】statement。真实 D1 的 bind 返回新对象，
 *  如果返回同一个 stmt，batch 里的多行会共享 args，全被最后一行覆盖。 */
function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      const make = (args) => ({
        bind(...a) { return make(a); },
        all() {
          try { return Promise.resolve({ results: sqlite.prepare(sql).all(...args) }); }
          catch (e) { console.error('SQL 失败:', sql, args, e.message); return Promise.resolve({ results: [] }); }
        },
        run() {
          const r = sqlite.prepare(sql).run(...args);
          return Promise.resolve({ meta: { changes: Number(r.changes) } });
        },
        first() {
          return Promise.resolve(sqlite.prepare(sql).all(...args)[0] || null);
        },
      });
      return make([]);
    },
    batch(stmts) {
      for (const s of stmts) s.run();
      return Promise.resolve([]);
    },
  };
}
const env = { DB: d1Adapter(db) };

// 汇率：全局 1.50（兜底）—— 实际 Yitta 的数据每行都有行内汇率，这里没行内的 USD 才用兜底
// 周次锚点：W23 = 2026-05-30（周六），一周 = 周六 ~ 周五
//   W34 = 08-15 ~ 08-21  ← 2026-08-20/21 落这里
//   W35 = 08-22 ~ 08-28  ← 2026-08-27/28 落这里（与 Yitta 确认的「W35 = 8/22-8/28」一致）
db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES('fx_usd_aud','1.50')`).run();

// 直接调内部函数不方便，走 HTTP-ish 的 import 接口
const rows = [
  // W34 AUD：商品 900 + 邮费 100 = 1000 AUD（不折算）
  { order_date: '2026-08-20', platform: 'Bunnings', order_no: 'T1', sku: 'S1', category: '床垫', qty: 1, goods: 900, shipping: 100, currency: 'AUD' },
  // W34 USD（无行内汇率，靠 meta.fx_usd_aud 兜底 1.5）：商品 200 + 邮费 50 = 250 × 1.5 = 375 AUD
  { order_date: '2026-08-21', platform: 'Bunnings', order_no: 'T2', sku: 'S2', category: '床垫', qty: 1, goods: 200, shipping: 50, currency: 'USD' },
  // W35 USD（带行内汇率 1.5483，模拟 Temu - US）：商品 500 + 邮费 100 = 600 × 1.5483 = 928.98 AUD
  { order_date: '2026-08-27', platform: 'Amazon', order_no: 'T3', sku: 'S3', category: '枕头', qty: 2, goods: 500, shipping: 100, currency: 'USD', fx_rate: 1.5483 },
  // W35 EUR：当前架构不支持 → 营收 0 + 告警
  { order_date: '2026-08-28', platform: 'Kmart', order_no: 'T4', sku: 'S4', category: '枕头', qty: 1, goods: 300, shipping: 0, currency: 'EUR' },
];

// 走 importCsv，喂 CSV 文本 —— 与用户从多维表导出后导入的真实链路一致
const csv = [
  '订单日期,平台,订单号,SKU,品类,销量,商品销售额,邮费收入,币种,汇率',
  ...rows.map((r) =>
    [r.order_date, r.platform, r.order_no, r.sku, r.category, r.qty, r.goods, r.shipping, r.currency, r.fx_rate || ''].join(',')
  ),
].join('\n');

const imported = await importCsv(env, { type: 'sales', csv, hasHeader: true, mode: 'append' });
ok(imported.ok === true && imported.inserted === 4, '导入 4 行混合币种明细', JSON.stringify(imported));

const dash = await buildDashboard(env);

ok(dash.meta && dash.meta.curWeek === 'W35', '当前周 W35（8/22-8/28，与 Yitta 确认口径一致）', JSON.stringify(dash.meta?.curWeek));
ok(near(dash.weeklyData.W34, 1375), 'W34 = 1000(AUD不折算) + 250×1.5(USD兜底) = 1375', `实际 ${dash.weeklyData?.W34}`);
ok(near(dash.weeklyData.W35, 929), 'W35 = 600×1.5483(USD行内) + 0(EUR不支持) ≈ 929', `实际 ${dash.weeklyData?.W35}`);

// 告警现在不止货币一条（还有缺成本 / 费率未核实 / 无广告数据），
// 所以改成「必须包含 EUR 那条」，而不是断言总数
const w = dash.warnings || [];
ok(w.some((x) => /EUR/.test(x)), 'EUR 触发「不支持币种」告警', JSON.stringify(w));

const fxRates = dash.meta?.fxRates || {};
ok(fxRates.fx_usd_aud === '1.50', 'meta.fxRates 回传 fx_usd_aud', JSON.stringify(fxRates));

// 平台维度也应已折算
const amazon = (dash.platData || []).find((p) => p.name === 'Amazon');
ok(amazon && near(amazon.thisWeek, 928.98), '平台维度 W35 Amazon = 928.98 AUD', JSON.stringify(amazon));

// 库里存的应是原币种
const raw = db.prepare(`SELECT sku, goods, shipping, currency, fx_rate, revenue FROM sales_orders WHERE sku='S3'`).get();
ok(raw && raw.goods === 500 && raw.shipping === 100 && near(raw.fx_rate, 1.5483) && near(raw.revenue, 928.98),
  '库里存原币种 500/100 USD，汇率 1.5483（行内），折算营收 928.98', JSON.stringify(raw));

// AUD 行不能被误乘汇率
const audRow = db.prepare(`SELECT goods, shipping, currency, fx_rate, revenue FROM sales_orders WHERE sku='S1'`).get();
ok(audRow && near(audRow.fx_rate, 1) && near(audRow.revenue, 1000),
  'AUD 行 fx=1，营收 = 900+100 = 1000（没被套用 USD 汇率）', JSON.stringify(audRow));

// EUR 行不能套用美元汇率
const eurRow = db.prepare(`SELECT goods, currency, fx_rate, revenue FROM sales_orders WHERE sku='S4'`).get();
ok(eurRow && eurRow.currency === 'EUR' && eurRow.fx_rate === 0 && eurRow.revenue === 0,
  'EUR 行没套用美元汇率，fx=0 营收=0', JSON.stringify(eurRow));

/* ---------- 3. BOM 回导：从多维表导出的 CSV 带 BOM，必须能正常解析 ---------- */
console.log('\n===== BOM 回导 =====\n');

const db2 = new DatabaseSync(':memory:');
db2.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const env2 = { DB: d1Adapter(db2) };
db2.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES('fx_usd_aud','1.50')`).run();

// 直接读 multitable/06 模板，它带 UTF-8 BOM
const tplCsv = readFileSync(new URL('../multitable/06_销售明细_每周填写.csv', import.meta.url), 'utf8');
ok(tplCsv.charCodeAt(0) === 0xfeff, '模板文件确实带 UTF-8 BOM');

const rBom = await importCsv(env2, { type: 'sales', csv: tplCsv, hasHeader: true, mode: 'append' });
ok(rBom.ok === true && rBom.inserted === 3, '带 BOM 的 CSV 能导入 3 行', JSON.stringify(rBom));

const bomRow = db2.prepare(`SELECT sku, goods, shipping, currency, fx_rate, revenue FROM sales_orders WHERE sku LIKE 'XFKF-PL-1167F-WH'`).get();
ok(bomRow && bomRow.currency === 'USD' && near(bomRow.goods, 38) && near(bomRow.shipping, 5),
  'USD 行按新列解析正确（38 商品 + 5 邮费）', JSON.stringify(bomRow));
// 模板里汇率列填了 1.5483 → (38+5) × 1.5483 = 66.5769
ok(bomRow && near(bomRow.fx_rate, 1.5483) && near(bomRow.revenue, 66.5769),
  '  └ 折算营收 = (38+5) × 1.5483 = 66.5769（用模板里的行内汇率）', JSON.stringify(bomRow));

const bomAud = db2.prepare(`SELECT goods, shipping, currency, fx_rate, revenue FROM sales_orders WHERE sku LIKE 'XFKF-MA-1772-26-Q'`).get();
ok(bomAud && near(bomAud.revenue, 459), 'AUD 行 = 419+40 = 459，未折算', JSON.stringify(bomAud));

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
