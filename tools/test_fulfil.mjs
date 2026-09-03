/**
 * 成本明细拆分（fulfil_mode='breakdown'）的测试
 *
 * 跑法：node --experimental-sqlite tools/test_fulfil.mjs
 *
 * 背景：Yitta 2026-09-03 要求「让我填单项，你帮我核算总价」。
 * 原来只有 fulfil_pct / fulfil_per_unit 两个合计值，现在拆成 7 项明细。
 *
 * 这里重点盯三件容易静默出错的事：
 *   1. 7 项求和算得对不对（按件 4 项相加、百分比 3 项相加，不能串类）
 *   2. 取值优先级：SKU 的值 > meta 全局默认 > 0 —— 不能反过来被全局值盖掉
 *   3. 未填项必须进 missing 并告警，绝不能静默当 0（否则毛利被高估还看不出来）
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✔\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✘\x1b[0m ' + msg + (detail ? '  → ' + detail : '')); }
};
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) < eps;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  return db;
}
const metaOf = (db) => Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
const setMeta = (db, k, v) => db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/** 建一个 8 月卖了 1 件、营收 400 AUD 的场景 */
function seedOne(db, skuVals = {}) {
  const cols = ['sku', 'name', 'category', 'cost', 'cost_currency', 'price_aud'];
  const vals = ['S1', '测试SKU', '床垫', 900, 'RMB', 400];
  for (const [k, v] of Object.entries(skuVals)) { cols.push(k); vals.push(v); }
  db.prepare(`INSERT INTO sku_master(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...vals);
  db.prepare(
    "INSERT INTO sales_orders(order_date,week_label,platform,order_no,sku,category,qty,goods,shipping,currency,fx_rate,revenue,source) VALUES('2026-08-10','W33','Bunnings','T1','S1','床垫',1,348,52,'AUD',1,400,'csv')"
  ).run();
  setMeta(db, 'fx_aud_cny', 4.8); // 900 RMB ÷ 4.8 = A$187.5
}

const { buildMargin } = await import('../src/worker.js');

/* ============================================================
 * 1. 7 项求和：按件 4 项、百分比 3 项，不能串类
 * ========================================================== */
console.log('\n===== 1. 明细求和 =====');
{
  const db = freshDb();
  seedOne(db, {
    ship_first_leg: 18, ship_unload: 4, handling_inout: 9, ship_last_mile: 45,
    pct_platform: 12, pct_payment: 1.75, pct_return: 3,
  });
  setMeta(db, 'fulfil_mode', 'breakdown');
  const m = buildMargin(db.prepare('SELECT * FROM sales_orders').all(), db.prepare('SELECT * FROM sku_master').all(), [], metaOf(db), { month: '2026-08' });
  const r = m.rows[0];

  ok(m.fulfilMode === 'breakdown', '模式切到 breakdown');
  ok(near(r.fulfilPerUnit, 76), '按件合计 = 18+4+9+45 = 76', `实得 ${r.fulfilPerUnit}`);
  ok(near(r.fulfilPct, 16.75), '费率合计 = 12+1.75+3 = 16.75%', `实得 ${r.fulfilPct}`);
  ok(near(r.unitFulfil, 143), '单件履约 = 400×16.75% + 76 = 143', `实得 ${r.unitFulfil}`);
  ok(near(r.unitCostAud, 187.5), '采购成本 = 900RMB ÷ 4.8 = 187.5', `实得 ${r.unitCostAud}`);
  ok(near(r.unitMargin, 69.5), '单件毛利 = 400 − 187.5 − 143 = 69.5', `实得 ${r.unitMargin}`);
  ok(near(r.marginPct, 17.38), '毛利率 = 69.5 / 400 = 17.38%', `实得 ${r.marginPct}`);
  ok(r.fulfilItems.length === 7, '明细返回 7 项', `实得 ${r.fulfilItems.length}`);
  ok(m.missingItems.length === 0, '全部填齐时无缺项');
}

/* ============================================================
 * 2. 取值优先级：SKU 的值 > meta 全局默认 > 0
 * ========================================================== */
console.log('\n===== 2. 取值优先级 =====');
{
  // SKU 没填任何项 → 全用 meta 全局默认
  const db = freshDb();
  seedOne(db);
  setMeta(db, 'fulfil_mode', 'breakdown');
  setMeta(db, 'ship_last_mile', 50);
  setMeta(db, 'pct_platform', 15);
  const m = buildMargin(db.prepare('SELECT * FROM sales_orders').all(), db.prepare('SELECT * FROM sku_master').all(), [], metaOf(db), { month: '2026-08' });
  const r = m.rows[0];
  ok(near(r.fulfilPerUnit, 50), 'SKU 未填 → 用 meta 的快递费 50', `实得 ${r.fulfilPerUnit}`);
  ok(near(r.fulfilPct, 15), 'SKU 未填 → 用 meta 的平台佣金 15%', `实得 ${r.fulfilPct}`);

  // SKU 填了 → 必须盖掉 meta，不能被全局值盖回来
  const db2 = freshDb();
  seedOne(db2, { ship_last_mile: 12 }); // 枕头快递只要 12，全局 50 是床垫的
  setMeta(db2, 'fulfil_mode', 'breakdown');
  setMeta(db2, 'ship_last_mile', 50);
  const m2 = buildMargin(db2.prepare('SELECT * FROM sales_orders').all(), db2.prepare('SELECT * FROM sku_master').all(), [], metaOf(db2), { month: '2026-08' });
  ok(near(m2.rows[0].fulfilPerUnit, 12), 'SKU 填了 12 → 盖掉 meta 的 50（小件不被大件费率套用）', `实得 ${m2.rows[0].fulfilPerUnit}`);
}

/* ============================================================
 * 3. 未填项必须进 missing —— 这是最容易静默出错的地方
 * ========================================================== */
console.log('\n===== 3. 未填项不静默 =====');
{
  const db = freshDb();
  seedOne(db, { ship_last_mile: 45, pct_platform: 12 }); // 只填 2 项，其余 5 项空
  setMeta(db, 'fulfil_mode', 'breakdown');
  const m = buildMargin(db.prepare('SELECT * FROM sales_orders').all(), db.prepare('SELECT * FROM sku_master').all(), [], metaOf(db), { month: '2026-08' });
  const r = m.rows[0];

  ok(m.missingItems.length === 5, '5 项未填 → missing 记 5 项', `实得 ${m.missingItems.length}`);
  ok(m.missingItems.includes('头程运费') && m.missingItems.includes('退货损耗'), '点名到具体项（头程运费、退货损耗）', m.missingItems.join('、'));
  ok(!m.missingItems.includes('快递费') && !m.missingItems.includes('平台佣金'), '已填的项不进 missing');
  ok(r.fulfilMissing.length === 5, 'SKU 行级也带 missing，前端可逐行提示');

  // 未确认 → 告警；确认后 → 静音
  ok(m.breakdownConfirmed === false, '默认未确认（告警会出）');
  setMeta(db, 'fulfil_breakdown_confirmed', 1);
  const m2 = buildMargin(db.prepare('SELECT * FROM sales_orders').all(), db.prepare('SELECT * FROM sku_master').all(), [], metaOf(db), { month: '2026-08' });
  ok(m2.breakdownConfirmed === true, 'fulfil_breakdown_confirmed=1 后标记为已确认');
}

/* ============================================================
 * 4. 向后兼容：默认 pct 模式行为不变
 * ========================================================== */
console.log('\n===== 4. 向后兼容（默认 pct 模式）=====');
{
  const db = freshDb();
  seedOne(db, { fulfil_pct: 20, fulfil_per_unit: 30 });
  // 不设 fulfil_mode → 默认 pct
  const m = buildMargin(db.prepare('SELECT * FROM sales_orders').all(), db.prepare('SELECT * FROM sku_master').all(), [], metaOf(db), { month: '2026-08' });
  const r = m.rows[0];
  ok(m.fulfilMode === 'pct', '不设 fulfil_mode 时默认 pct');
  ok(near(r.fulfilPct, 20), '沿用 SKU 的 fulfil_pct = 20', `实得 ${r.fulfilPct}`);
  ok(near(r.fulfilPerUnit, 30), '沿用 SKU 的 fulfil_per_unit = 30', `实得 ${r.fulfilPerUnit}`);
  ok(r.fulfilItems.length === 0, 'pct 模式不返回明细项');

  // 明细全空 + 切到 breakdown → 履约成本归零，毛利被高估，必须告警
  const db2 = freshDb();
  seedOne(db2);
  setMeta(db2, 'fulfil_mode', 'breakdown');
  const m2 = buildMargin(db2.prepare('SELECT * FROM sales_orders').all(), db2.prepare('SELECT * FROM sku_master').all(), [], metaOf(db2), { month: '2026-08' });
  ok(m2.rows[0].unitFulfil === 0, '明细全空 → 履约成本 0');
  ok(m2.missingItems.length === 7, '7 项全缺 → 全部点名告警（不会静默给个好看的毛利）', `实得 ${m2.missingItems.length}`);
}

/* ============================================================
 * 5. 飞书中文列名 → 数据库列的映射
 *
 * 这是最容易静默出错的一环：列名差一个字，flatten 出来的对象里就没有这个 key，
 * upsertSkuMaster 取到 undefined → 存 NULL → 成本少算，且不报任何错。
 * 所以这里用飞书表头的真实中文名走一遍入库，逐列比对落库结果。
 * ========================================================== */
console.log('\n===== 5. 飞书中文列名映射 =====');
{
  const { upsertSkuMaster, flattenFeishuFields } = await import('../src/worker.js');
  const db = freshDb();
  const env = {
    DB: {
      prepare(sql) {
        const make = (args) => ({
          bind(...a) { return make(a); },
          all() { return Promise.resolve({ results: db.prepare(sql).all(...args) }); },
          run() { db.prepare(sql).run(...args); return Promise.resolve({ success: true }); },
          first() { return Promise.resolve(db.prepare(sql).get(...args) || null); },
        });
        return make([]);
      },
      batch(stmts) { for (const s of stmts) s.run(); return Promise.resolve([]); },
    },
  };

  // 完全用飞书表头的中文名，模拟 syncFromFeishu 传进来的记录
  // 走真实链路：飞书返回的 fields 先过 flattenFeishuFields（多选是数组，要拍平成字符串）
  await upsertSkuMaster(env, [
    flattenFeishuFields({
      SKU: 'XFKF-MA-1666-34-Q', 品名: '1666 34cm Queen', 品类: ['Mattress'], 规格: '1666 34cm Queen',
      采购价: 900, 币种: 'RMB', 售价AUD: 400.97,
      头程运费: 18, 卸货费: 4, 入出库处理费: 9, 快递费: 45,
      平台佣金: 12, 支付手续费: 1.75, 退货损耗: 3,
      补货提前期: 45, 安全库存天数: 21,
    }),
    flattenFeishuFields({
      SKU: 'XFKF-PL-1167F-WH', 品名: '1167F White', 品类: ['Pillow'], 规格: '1167F White',
      采购价: 30, 币种: 'RMB', 售价AUD: 15.42,
      // 只填 3 项，其余留空 → 应落 NULL（回落 meta），不能变 0
      快递费: 12, 平台佣金: 15, 支付手续费: 1.75,
    }),
  ]);

  const q = 'SELECT * FROM sku_master WHERE sku=?';
  const a = db.prepare(q).get('XFKF-MA-1666-34-Q');
  const b = db.prepare(q).get('XFKF-PL-1167F-WH');

  ok(!!a && !!b, '两条记录都进了库');
  ok(a.ship_first_leg === 18 && a.ship_unload === 4 && a.handling_inout === 9, '按件 4 项按中文列名落库', `${a.ship_first_leg}/${a.ship_unload}/${a.handling_inout}`);
  ok(a.ship_last_mile === 45, '快递费 45 落库', `${a.ship_last_mile}`);
  ok(a.pct_platform === 12 && a.pct_payment === 1.75 && a.pct_return === 3, '百分比 3 项落库', `${a.pct_platform}/${a.pct_payment}/${a.pct_return}`);
  ok(near(a.price_aud, 400.97) && near(a.cost, 900), '原有列不受影响（售价/采购价）');

  ok(b.ship_last_mile === 12, '枕头快递费 12 落库（小件不被大件费率套用）', `${b.ship_last_mile}`);
  ok(b.ship_first_leg === null, '没填的项落 NULL 而不是 0（NULL 才会回落 meta 默认值）', `实得 ${JSON.stringify(b.ship_first_leg)}`);
  ok(b.pct_return === null, '未填的退货损耗落 NULL', `实得 ${JSON.stringify(b.pct_return)}`);

  // 端到端：枕头没填头程运费，meta 配了 → 必须用上 meta 的值
  setMeta(db, 'fulfil_mode', 'breakdown');
  setMeta(db, 'ship_first_leg', 6);
  const m = buildMargin([], db.prepare('SELECT * FROM sku_master').all(), [], metaOf(db), { month: '2026-08' });
  const pillow = m.rows.find((r) => r.sku === 'XFKF-PL-1167F-WH');
  ok(near(pillow.fulfilPerUnit, 18), '枕头按件成本 = 快递12 + 头程6(来自meta) = 18', `实得 ${pillow?.fulfilPerUnit}`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
