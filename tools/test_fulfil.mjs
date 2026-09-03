/**
 * 成本明细拆分（fulfil_mode='breakdown'）的测试
 *
 * 跑法：node --experimental-sqlite tools/test_fulfil.mjs
 *
 * 背景：Yitta 2026-09-03 要求「让我填单项，你帮我核算总价」。
 * 原来只有 fulfil_pct / fulfil_per_unit 两个合计值，现在拆成 8 项明细。
 *
 * 这里重点盯三件容易静默出错的事：
 *   1. 8 项求和算得对不对（按件 4 项相加、百分比 4 项相加，不能串类）
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

const { buildMargin, pickBestSkuRows } = await import('../src/worker.js');

/* ============================================================
 * 1. 8 项求和：按件 4 项、百分比 4 项，不能串类
 * ========================================================== */
console.log('\n===== 1. 明细求和 =====');
{
  const db = freshDb();
  seedOne(db, {
    ship_first_leg: 18, ship_unload: 4, handling_inout: 9, ship_last_mile: 45,
    pct_sales: 5, pct_platform: 12, pct_payment: 1.75, pct_return: 3,
  });
  setMeta(db, 'fulfil_mode', 'breakdown');
  const m = buildMargin(db.prepare('SELECT * FROM sales_orders').all(), db.prepare('SELECT * FROM sku_master').all(), [], metaOf(db), { month: '2026-08' });
  const r = m.rows[0];

  ok(m.fulfilMode === 'breakdown', '模式切到 breakdown');
  ok(near(r.fulfilPerUnit, 76), '按件合计 = 18+4+9+45 = 76', `实得 ${r.fulfilPerUnit}`);
  ok(near(r.fulfilPct, 21.75), '费率合计 = 5+12+1.75+3 = 21.75%', `实得 ${r.fulfilPct}`);
  ok(near(r.unitFulfil, 163), '单件履约 = 400×21.75% + 76 = 163', `实得 ${r.unitFulfil}`);
  ok(near(r.unitCostAud, 187.5), '采购成本 = 900RMB ÷ 4.8 = 187.5', `实得 ${r.unitCostAud}`);
  ok(near(r.unitMargin, 49.5), '单件毛利 = 400 − 187.5 − 163 = 49.5', `实得 ${r.unitMargin}`);
  ok(near(r.marginPct, 12.38), '毛利率 = 49.5 / 400 = 12.38%', `实得 ${r.marginPct}`);
  ok(r.fulfilItems.length === 8, '明细返回 8 项', `实得 ${r.fulfilItems.length}`);
  ok(r.fulfilItems.some((i) => i.key === 'pct_sales' && near(i.value, 5)),
    '销售佣金算进费率小计（不是漏项）', JSON.stringify(r.fulfilItems.filter((i) => i.kind === 'pct')));
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
  seedOne(db, { ship_last_mile: 45, pct_platform: 12 }); // 只填 2 项，其余 6 项空
  setMeta(db, 'fulfil_mode', 'breakdown');
  const m = buildMargin(db.prepare('SELECT * FROM sales_orders').all(), db.prepare('SELECT * FROM sku_master').all(), [], metaOf(db), { month: '2026-08' });
  const r = m.rows[0];

  ok(m.missingItems.length === 6, '6 项未填 → missing 记 6 项', `实得 ${m.missingItems.length}`);
  ok(m.missingItems.includes('头程运费') && m.missingItems.includes('退货损耗'), '点名到具体项（头程运费、退货损耗）', m.missingItems.join('、'));
  ok(m.missingItems.includes('销售佣金'), '没填的销售佣金也点名（不会因为它新加就漏掉）', m.missingItems.join('、'));
  ok(!m.missingItems.includes('快递费') && !m.missingItems.includes('平台佣金'), '已填的项不进 missing');
  ok(r.fulfilMissing.length === 6, 'SKU 行级也带 missing，前端可逐行提示');

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
  ok(m2.missingItems.length === 8, '8 项全缺 → 全部点名告警（不会静默给个好看的毛利）', `实得 ${m2.missingItems.length}`);
  ok(m2.fulfilItemTotal === 8, '返回给前端的总项数是 8（告警分母，别在前端写死）', `实得 ${m2.fulfilItemTotal}`);
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
      销售佣金: 5, 平台佣金: 12, 支付手续费: 1.75, 退货损耗: 3,
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
  ok(a.pct_sales === 5, '销售佣金按中文列名落库', `${a.pct_sales}`);
  ok(a.pct_platform === 12 && a.pct_payment === 1.75 && a.pct_return === 3, '百分比其余 3 项落库', `${a.pct_platform}/${a.pct_payment}/${a.pct_return}`);
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

/* ============================================================
 * 6. 飞书空行 / 重复行去重
 *
 * 2026-09-03 在 Yitta 真实飞书表上发现：SKU 主数据 17 行里有 1 行重复、
 * 1 行只有 SKU 其余全空、1 行连 SKU 都没有。
 * 那个「只有 SKU」的空行会 UPSERT 覆盖同 SKU 的真实数据 —— 采购价变 0，
 * 毛利直接算不出来，而且不报错。所以入库前必须先挑行。
 * ========================================================== */
console.log('\n===== 6. 飞书空行/重复行去重 =====');
{
  const hasAll = () => true;      // 库里有全部明细列
  const hasNone = () => false;    // 老库：明细列一个都没有
  const skus = (rs) => rs.map((r) => r.SKU || r.sku);

  // 6.1 空行不能覆盖好数据（真实事故：XFKF-PL-1169R-WH 第 16 行全空）
  {
    const rows = pickBestSkuRows(
      [{ SKU: 'A', 采购价: 186.64, 品类: 'Pillow' }, { SKU: 'A' }],
      hasAll
    );
    ok(rows.length === 1, '同 SKU 只留一行', `实得 ${rows.length} 行`);
    ok(rows[0].采购价 === 186.64, '空行没覆盖掉真实采购价', `实得 ${rows[0].采购价}`);
  }

  // 6.2 只有 SKU 的行直接丢掉
  {
    const rows = pickBestSkuRows([{ SKU: 'B' }, { SKU: 'C', 品名: '有值' }], hasAll);
    ok(skus(rows).join() === 'C', '只有 SKU 的行被丢弃', `实得 ${JSON.stringify(skus(rows))}`);
  }

  // 6.3 连 SKU 都没有的行丢掉（飞书表末尾常有）
  {
    const rows = pickBestSkuRows([{ 品名: '没SKU' }, { SKU: 'D', 采购价: 5 }], hasAll);
    ok(skus(rows).join() === 'D', '无 SKU 行被丢弃', `实得 ${JSON.stringify(skus(rows))}`);
  }

  // 6.4 重复行取填得最全的那行（不看顺序）
  {
    const rows = pickBestSkuRows(
      [
        { SKU: 'E', 采购价: 1 },
        { SKU: 'E', 采购价: 2, 头程运费: 3, 快递费: 4, 平台佣金: 5 },
        { SKU: 'E', 采购价: 9, 头程运费: 8 },
      ],
      hasAll
    );
    ok(rows.length === 1 && rows[0].采购价 === 2, '取填得最全的那行（不是最后一行）', `实得 ${rows[0]?.采购价}`);
  }

  // 6.5 填得一样多时取后者 —— 跟以前「后面覆盖前面」的行为保持一致
  {
    const rows = pickBestSkuRows([{ SKU: 'F', 采购价: 1 }, { SKU: 'F', 采购价: 2 }], hasAll);
    ok(rows.length === 1 && rows[0].采购价 === 2, '分数相同取后出现的一行', `实得 ${rows[0]?.采购价}`);
  }

  // 6.6 英文列名（CSV 路径）也要能计分
  {
    const rows = pickBestSkuRows([{ sku: 'G', cost: 10 }, { sku: 'G' }], hasAll);
    ok(rows.length === 1 && rows[0].cost === 10, '英文列名同样生效', `实得 ${JSON.stringify(rows)}`);
  }

  // 6.7 老库没有明细列时，明细不算分，但基础列照常挑
  {
    const rows = pickBestSkuRows([{ SKU: 'H' }, { SKU: 'H', 采购价: 7 }], hasNone);
    ok(rows.length === 1 && rows[0].采购价 === 7, '老库（无明细列）仍能正确去重', `实得 ${JSON.stringify(rows)}`);
  }

  // 6.8 端到端：用 Yitta 飞书表里那段真实数据的形状跑一遍
  {
    const real = [
      { SKU: 'XFKF-PL-1169R-WH', 采购价: 186.64, 品类: 'Pillow', 头程运费: 22.5, 快递费: 208.12 },
      { SKU: 'XFKF-MA-1772-26-S', 采购价: 200.81, 头程运费: 48.8, 快递费: 90.49 },
      { SKU: 'XFKF-MA-1772-26-S', 采购价: 200.81, 头程运费: 48.8, 快递费: 90.49 }, // 重复行
      { SKU: 'XFKF-PL-1169R-WH', 币种: 'RMB' },                                    // 空行
      {},                                                                          // 连 SKU 都没有
    ];
    const rows = pickBestSkuRows(real, hasAll);
    ok(rows.length === 2, '17 行里的脏数据清完后剩 2 个 SKU', `实得 ${rows.length} 行`);
    const pillow = rows.find((r) => r.SKU === 'XFKF-PL-1169R-WH');
    ok(!!pillow && pillow.采购价 === 186.64, '枕头的真实采购价保住了', `实得 ${pillow?.采购价}`);
  }
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
