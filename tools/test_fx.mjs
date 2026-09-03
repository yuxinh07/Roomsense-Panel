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

const meta = { fx_usd_aud: '1.50', 'fx_usd_aud.W35': '1.60' };

// 1) USD 商品 + 邮费，行内汇率
{
  const r = { currency: 'USD', goods: 100, shipping: 20, fx_rate: 1.5, week_label: 'W35' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 180), 'USD 商品100 + 邮费20，汇率1.5 → 180', JSON.stringify(a));
  ok(a.goods === 100 && a.shipping === 20, '  └ goods/shipping 存原币种');
  ok(a.currency === 'USD' && near(a.fx, 1.5), '  └ currency/fx 正确');
}

// 2) 按周汇率优先于全局汇率
{
  const r = { currency: 'USD', goods: 100, shipping: 0, week_label: 'W35' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 160), 'W35 用按周汇率 1.6 → 160（优先于全局 1.5）', JSON.stringify(a));
}

// 3) 非 W35 用全局汇率
{
  const r = { currency: 'USD', goods: 100, shipping: 0, week_label: 'W34' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 150), 'W34 用全局汇率 1.5 → 150', JSON.stringify(a));
}

// 4) 只填销售额 + USD → 整笔折算
{
  const r = { currency: 'USD', revenue: 200, week_label: 'W34' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 300), 'USD 只填销售额 200 → 300', JSON.stringify(a));
  ok(a.shipping === 0, '  └ 邮费补 0');
}

// 5) 历史兼容：只填销售额 + AUD → fx=1，原值不变
{
  const r = { revenue: 4737, week_label: 'W35' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 4737) && a.fx === 1, '只填销售额+无币种 → fx=1，营收=4737（兼容历史）', JSON.stringify(a));
}

// 6) 历史兼容：币种显式写 AUD
{
  const r = { currency: 'AUD', revenue: 1234.5, week_label: 'W35' };
  const a = resolveAmounts(r, meta);
  ok(near(a.revenueAud, 1234.5), '币种 AUD → 不折算，仍是 1234.5', JSON.stringify(a));
}

// 7) 缺汇率 → fx=0，营收按 0 计（不静默按 1 折算）
{
  const saveMeta = { ...meta, fx_usd_aud: '0' };
  delete saveMeta['fx_usd_aud.W35'];
  const r = { currency: 'USD', goods: 100, shipping: 20, week_label: 'W35' };
  const a = resolveAmounts(r, meta && saveMeta);
  ok(near(a.revenueAud, 0) && a.fx === 0, 'USD 缺汇率 → fx=0，营收按 0 计（不静默当 1）', JSON.stringify(a));
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

// 汇率：全局 1.50，W34 单独 1.60
// 注意：schema 里 week_epoch_date=2026-06-07 / week_epoch_label=23，
// 所以 2026-08-20/21 落在 W33，2026-08-27/28 落在 W34
db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES('fx_usd_aud','1.50')`).run();
db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES('fx_usd_aud.W34','1.60')`).run();

// 直接调内部函数不方便，走 HTTP-ish 的 import 接口
const rows = [
  // W33 AUD：商品 900 + 邮费 100 = 1000 AUD（不折算）
  { order_date: '2026-08-20', platform: 'Bunnings', order_no: 'T1', sku: 'S1', category: '床垫', qty: 1, goods: 900, shipping: 100, currency: 'AUD' },
  // W33 USD：商品 200 + 邮费 50 = 250 USD × 全局 1.5 = 375 AUD
  { order_date: '2026-08-21', platform: 'Bunnings', order_no: 'T2', sku: 'S2', category: '床垫', qty: 1, goods: 200, shipping: 50, currency: 'USD' },
  // W34 USD：商品 500 + 邮费 100 = 600 USD × 按周 1.6 = 960 AUD
  { order_date: '2026-08-27', platform: 'Amazon', order_no: 'T3', sku: 'S3', category: '枕头', qty: 2, goods: 500, shipping: 100, currency: 'USD' },
  // W34 EUR：没配 fx_eur_aud → 营收 0（关键：不能套用美元汇率 1.5/1.6）
  { order_date: '2026-08-28', platform: 'Kmart', order_no: 'T4', sku: 'S4', category: '枕头', qty: 1, goods: 300, shipping: 0, currency: 'EUR' },
];

// 走 importCsv，喂 CSV 文本 —— 与用户从多维表导出后导入的真实链路一致
const csv = [
  '订单日期,平台,订单号,SKU,品类,销量,商品销售额,邮费收入,币种',
  ...rows.map((r) =>
    [r.order_date, r.platform, r.order_no, r.sku, r.category, r.qty, r.goods, r.shipping, r.currency].join(',')
  ),
].join('\n');

const imported = await importCsv(env, { type: 'sales', csv, hasHeader: true, mode: 'append' });
ok(imported.ok === true && imported.inserted === 4, '导入 4 行混合币种明细', JSON.stringify(imported));

const dash = await buildDashboard(env);

ok(dash.meta && dash.meta.curWeek === 'W34', '当前周 W34', JSON.stringify(dash.meta?.curWeek));
ok(near(dash.weeklyData.W33, 1375), 'W33 = 1000(AUD不折算) + 250×1.5(USD) = 1375', `实际 ${dash.weeklyData?.W33}`);
ok(near(dash.weeklyData.W34, 960), 'W34 = 600×1.6(USD) + 0(EUR缺汇率) = 960', `实际 ${dash.weeklyData?.W34}`);

const w = dash.warnings || [];
ok(w.length === 1 && /EUR/.test(w[0]), 'EUR 缺汇率触发 1 条告警', JSON.stringify(w));

const fxRates = dash.meta?.fxRates || {};
ok(fxRates.fx_usd_aud === '1.50' && fxRates['fx_usd_aud.W34'] === '1.60', 'meta.fxRates 回传汇率配置', JSON.stringify(fxRates));

// 平台维度也应已折算
const amazon = (dash.platData || []).find((p) => p.name === 'Amazon');
ok(amazon && near(amazon.thisWeek, 960), '平台维度 W34 Amazon = 960 AUD', JSON.stringify(amazon));

// 库里存的应是原币种
const raw = db.prepare(`SELECT sku, goods, shipping, currency, fx_rate, revenue FROM sales_orders WHERE sku='S3'`).get();
ok(raw && raw.goods === 500 && raw.shipping === 100 && near(raw.fx_rate, 1.6) && near(raw.revenue, 960),
  '库里存原币种 500/100 USD，汇率 1.6，折算营收 960', JSON.stringify(raw));

// AUD 行不能被误乘汇率（这是刚修掉的 bug，留用例防回归）
const audRow = db.prepare(`SELECT goods, shipping, currency, fx_rate, revenue FROM sales_orders WHERE sku='S1'`).get();
ok(audRow && near(audRow.fx_rate, 1) && near(audRow.revenue, 1000),
  'AUD 行 fx=1，营收 = 900+100 = 1000（没被套用 USD 汇率）', JSON.stringify(audRow));

// EUR 行不能套用美元汇率（刚修掉的第二个 bug）
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
ok(bomRow && near(bomRow.revenue, 64.5), '  └ 折算营收 = (38+5)×1.5 = 64.5', JSON.stringify(bomRow));

const bomAud = db2.prepare(`SELECT goods, shipping, currency, fx_rate, revenue FROM sales_orders WHERE sku LIKE 'XFKF-MA-1772-26-Q'`).get();
ok(bomAud && near(bomAud.revenue, 459), 'AUD 行 = 419+40 = 459，未折算', JSON.stringify(bomAud));

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
