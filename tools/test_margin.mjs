/**
 * 毛利聚合 + 库存快照 + 安全库存 的测试
 *
 * 跑法：node --experimental-sqlite tools/test_margin.mjs
 *
 * 覆盖：
 *   1. 周次锚点（W35 = 8/22-8/28，与 Yitta 确认口径一致）
 *   2. buildMargin：单位经济模型、成本缺失降级、RMB 折算、广告分摊、安全垫
 *   3. 库存快照：导入自动追加、同日覆盖、异日新增
 *   4. 安全库存：手工值优先 / 自动算 = 日均 × buffer
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

/* ---------- 建库：直接吃 schema.sql + seed.sql，与线上建表路径一致 ---------- */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(join(ROOT, 'seed.sql'), 'utf8'));
  return db;
}

/** D1 适配器。注意 bind() 必须返回「新的」statement —— 真实 D1 如此，
 *  模拟器写成返回 this 会让 batch 里所有行共享最后一次 bind 的参数。 */
function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      const make = (args) => ({
        bind(...a) { return make(a); },
        all() { return Promise.resolve({ results: sqlite.prepare(sql).all(...args) }); },
        run() { sqlite.prepare(sql).run(...args); return Promise.resolve({ success: true }); },
        first() { return Promise.resolve(sqlite.prepare(sql).get(...args) || null); },
      });
      return make([]);
    },
    batch(stmts) { for (const s of stmts) s.run(); return Promise.resolve([]); },
  };
}

const { buildMargin, buildDashboard, importCsv } = await import(join(ROOT, 'src/worker.js'));

/* ============================================================
 * 1. 周次锚点
 * ========================================================== */
console.log('\n===== 1. 周次锚点（W35 必须是 8/22-8/28）=====');
{
  const db = freshDb();
  const meta = Object.fromEntries(
    db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value])
  );
  ok(meta.week_epoch_date === '2026-05-30',
    `schema 里 week_epoch_date = 2026-05-30`, `实际 ${meta.week_epoch_date}`);

  // 用真实的导入链路验证：塞 4 个日期进去看落到哪一周
  const env = { DB: d1Adapter(db) };
  const csv = [
    '订单日期,平台,订单号,SKU,品类,销量,商品销售额,邮费收入,币种,汇率',
    '2026-08-21,Bunnings,A1,S-A,床垫,1,100,0,AUD,1',   // W34 最后一天
    '2026-08-22,Bunnings,A2,S-B,床垫,1,100,0,AUD,1',   // W35 第一天
    '2026-08-28,Bunnings,A3,S-C,床垫,1,100,0,AUD,1',   // W35 最后一天
    '2026-08-29,Bunnings,A4,S-D,床垫,1,100,0,AUD,1',   // W36 第一天
  ].join('\n');
  await importCsv(env, { type: 'sales', csv, hasHeader: true, mode: 'append' });
  const wk = Object.fromEntries(
    db.prepare('SELECT sku, week_label FROM sales_orders').all().map((r) => [r.sku, r.week_label])
  );
  ok(wk['S-A'] === 'W34', '2026-08-21 → W34', `实际 ${wk['S-A']}`);
  ok(wk['S-B'] === 'W35', '2026-08-22 → W35（Yitta 口径的周起始日）', `实际 ${wk['S-B']}`);
  ok(wk['S-C'] === 'W35', '2026-08-28 → W35（周结束日）', `实际 ${wk['S-C']}`);
  ok(wk['S-D'] === 'W36', '2026-08-29 → W36', `实际 ${wk['S-D']}`);
}

/* ============================================================
 * 2. buildMargin 单位经济模型
 * ========================================================== */
console.log('\n===== 2. 毛利：单位经济模型 =====');
{
  // 8 月的销售明细。S1 卖 10 件，营收 1000 → ASP 100
  const sales = [
    { order_date: '2026-08-05', sku: 'S1', category: '床垫', qty: 10, revenue: 1000 },
    { order_date: '2026-08-12', sku: 'S2', category: '枕头', qty: 20, revenue: 800 },
    // 7 月的，不该被算进 8 月
    { order_date: '2026-07-20', sku: 'S1', category: '床垫', qty: 99, revenue: 99999 },
  ];
  // S1 成本 300 RMB ÷ 4.7 = 63.83 AUD；S2 成本 20 AUD（直接 AUD 计价）
  const skuMaster = [
    { sku: 'S1', category: '床垫', cost: 300, cost_currency: 'RMB' },
    { sku: 'S2', category: '枕头', cost: 20, cost_currency: 'AUD' },
    { sku: 'S3', category: '床垫', cost: 0, cost_currency: 'RMB' },  // 没填成本
  ];
  const meta = { fx_aud_cny: '4.70', fulfil_pct: '30', margin_month: '2026-08' };
  const m = buildMargin(sales, skuMaster, [], meta);

  ok(m.month === '2026-08', '按 meta.margin_month 取 8 月', m.month);
  ok(m.skuCount === 3, '3 个 SKU 全列出（含没销量的 S3，方便看缺什么）', `实际 ${m.skuCount}`);

  const s1 = m.rows.find((r) => r.sku === 'S1');
  ok(near(s1.qty, 10) && near(s1.revenue, 1000), 'S1 只统计 8 月（7 月那行没混进来）',
    `qty=${s1.qty} rev=${s1.revenue}`);
  ok(near(s1.asp, 100), 'S1 ASP = 1000/10 = 100', `实际 ${s1.asp}`);
  ok(near(s1.unitCostAud, 63.83), 'S1 采购成本 = 300 RMB ÷ 4.70 = 63.83 AUD', `实际 ${s1.unitCostAud}`);
  ok(near(s1.unitFulfil, 30), 'S1 佣金+履约 = 100 × 30% = 30', `实际 ${s1.unitFulfil}`);
  ok(near(s1.unitMargin, 6.17), 'S1 单件毛利 = 100 − 63.83 − 30 = 6.17', `实际 ${s1.unitMargin}`);
  ok(near(s1.marginPct, 6.17), 'S1 毛利率 = 6.17%', `实际 ${s1.marginPct}`);
  ok(near(s1.grossProfit, 61.7), 'S1 8月毛利额 = 6.17 × 10 = 61.7', `实际 ${s1.grossProfit}`);

  const s2 = m.rows.find((r) => r.sku === 'S2');
  ok(near(s2.unitCostAud, 20), 'S2 成本已是 AUD，不折算', `实际 ${s2.unitCostAud}`);
  ok(near(s2.asp, 40), 'S2 ASP = 800/20 = 40', `实际 ${s2.asp}`);
  ok(near(s2.unitMargin, 8), 'S2 单件毛利 = 40 − 20 − 12 = 8', `实际 ${s2.unitMargin}`);
  ok(near(s2.marginPct, 20), 'S2 毛利率 = 20%', `实际 ${s2.marginPct}`);

  const s3 = m.rows.find((r) => r.sku === 'S3');
  ok(s3.hasCost === false, 'S3 没填成本 → hasCost=false');
  ok(s3.unitMargin === null && s3.marginPct === null && s3.safety === null,
    'S3 毛利/毛利率/安全垫全是 null（不拿估算值冒充）', JSON.stringify(s3));
  ok(m.missingCost === 1, 'missingCost 统计到 1 个 SKU 缺成本', `实际 ${m.missingCost}`);
}

/* ============================================================
 * 3. 广告分摊 + 投流安全垫（Yitta 真正要的判据）
 * ========================================================== */
console.log('\n===== 3. 广告分摊 + 投流安全垫 =====');
{
  const sales = [
    { order_date: '2026-08-05', sku: 'XFKF-MA-1772-26-D', category: '床垫', qty: 10, revenue: 3000 },
    { order_date: '2026-08-06', sku: 'XFKF-PL-1167F-WH', category: '枕头', qty: 20, revenue: 1000 },
  ];
  const skuMaster = [
    { sku: 'XFKF-MA-1772-26-D', category: '床垫', cost: 700, cost_currency: 'RMB' }, // 148.94 AUD
    { sku: 'XFKF-PL-1167F-WH', category: '枕头', cost: 60, cost_currency: 'RMB' },   // 12.77 AUD
  ];
  // W34 = 08-15~08-21，W35 = 08-22~08-28，都落在 8 月
  const ads = [
    // campaign 名带 SKU 前缀 → 精确匹配到 MA-1772-26-D
    { week_label: 'W35', campaign: 'XFKF-MA-1772-26 (Auto)', spend: 300, ad_sales: 2000, orders: 8 },
    // campaign 名对不上任何 SKU → 按营收占比摊
    { week_label: 'W34', campaign: 'Brand Defense', spend: 100, ad_sales: 500, orders: 2 },
  ];
  const meta = { fx_aud_cny: '4.70', fulfil_pct: '30', margin_month: '2026-08' };
  const m = buildMargin(sales, skuMaster, ads, meta);

  ok(m.adsHasData === true, '识别到 8 月有广告数据');
  ok(near(m.adsTotal, 400), '广告总花费 = 300 + 100 = 400', `实际 ${m.adsTotal}`);

  const d = m.rows.find((r) => r.sku === 'XFKF-MA-1772-26-D');
  // ASP 300 → 成本 148.94 → 履约 90 → 毛利 61.06 → 毛利率 20.35%
  ok(near(d.adsSpend, 375), 'MA-1772-26-D 广告 = 300(精确匹配) + 100×3000/4000(按营收摊) = 375',
    `实际 ${d.adsSpend}`);
  ok(near(d.marginPct, 20.35), '毛利率 = (300 − 148.94 − 90)/300 = 20.35%', `实际 ${d.marginPct}`);
  ok(near(d.acos, 12.5), 'ACOS = 375/3000 = 12.5%', `实际 ${d.acos}`);
  ok(near(d.safety, 7.85), '安全垫 = 20.35% − 12.5% = 7.85 个百分点', `实际 ${d.safety}`);
  ok(d.safety > 0, '安全垫 > 0 → 投流在边际上赚钱');
  ok(near(d.netProfit, 235.64), '投流后净利 = 毛利 610.64 − 广告 375 = 235.64', `实际 ${d.netProfit}`);

  const p = m.rows.find((r) => r.sku === 'XFKF-PL-1167F-WH');
  ok(near(p.adsSpend, 25), 'PL-1167F 只摊到 100×1000/4000 = 25', `实际 ${p.adsSpend}`);
  // ASP 50 → 成本 12.77 → 履约 15 → 毛利 22.23 → 毛利率 44.47% → ACOS 2.5% → 安全垫 41.97
  ok(near(p.safety, 41.97), 'PL-1167F 安全垫 = 44.47% − 2.5% ≈ 41.97（比床垫高得多）', `实际 ${p.safety}`);
  ok(p.safety > d.safety,
    '关键：枕头 ACOS 更低但真正该加投的是它 —— 安全垫 41.97 vs 7.85',
    `枕头 ${p.safety} vs 床垫 ${d.safety}`);
}

console.log('\n===== 4. 无广告数据时的降级 =====');
{
  const sales = [{ order_date: '2026-08-05', sku: 'S1', qty: 10, revenue: 1000 }];
  const skuMaster = [{ sku: 'S1', cost: 300, cost_currency: 'RMB' }];
  const meta = { fx_aud_cny: '4.70', fulfil_pct: '30', margin_month: '2026-08' };
  const m = buildMargin(sales, skuMaster, [], meta);
  const s1 = m.rows[0];
  ok(m.adsHasData === false, 'ads 表空 → adsHasData=false');
  ok(s1.acos === null, 'ACOS = null（「无数据」，不是「零花费」）', `实际 ${s1.acos}`);
  ok(s1.safety === null, '安全垫 = null（没有 ACOS 就算不出）');
  ok(near(s1.netProfit, s1.grossProfit), '净利暂时等于毛利', `${s1.netProfit} vs ${s1.grossProfit}`);

  // 广告落在别的月份，也不能算进 8 月
  const m2 = buildMargin(sales, skuMaster,
    [{ week_label: 'W31', campaign: 'XFKF-S1 (Auto)', spend: 500 }], meta); // W31 = 07-25~07-31
  ok(m2.adsHasData === false && m2.adsTotal === 0,
    '7 月的广告不会被算进 8 月', `hasData=${m2.adsHasData} total=${m2.adsTotal}`);
}

/* ============================================================
 * 5. 库存快照
 * ========================================================== */
console.log('\n===== 5. 库存快照（历史） =====');
{
  const db = freshDb();
  const env = { DB: d1Adapter(db) };
  const csvOf = (date, onHand) => [
    '快照日期,SKU,品类,现有库存,在途,安全库存,预计到货',
    `${date},XFKF-MA-1772-26-Q,床垫,${onHand},10,0,`,
  ].join('\n');

  const r1 = await importCsv(env, { type: 'inventory', csv: csvOf('2026-08-01', 30), hasHeader: true });
  ok(r1.upserted === 1 && r1.snapshotDate === '2026-08-01',
    '导入时按指定快照日期写历史', JSON.stringify(r1));

  const r2 = await importCsv(env, { type: 'inventory', csv: csvOf('2026-08-08', 22), hasHeader: true });
  ok(r2.snapshotDate === '2026-08-08', '第二次导入（不同日期）', JSON.stringify(r2));

  // 同一天重复导入 → 覆盖，不产生重复行
  await importCsv(env, { type: 'inventory', csv: csvOf('2026-08-08', 20), hasHeader: true });
  const snaps = db.prepare('SELECT * FROM inventory_snapshot ORDER BY snapshot_date').all();
  ok(snaps.length === 2, '同日重复导入只覆盖，快照仍是 2 条', `实际 ${snaps.length} 条`);
  ok(snaps[0].on_hand === 30 && snaps[1].on_hand === 20,
    '快照记录了历史变化：08-01 有 30 件 → 08-08 剩 20 件',
    JSON.stringify(snaps.map((s) => [s.snapshot_date, s.on_hand])));

  // inventory 主表始终是当前值
  const cur = db.prepare("SELECT on_hand FROM inventory WHERE sku='XFKF-MA-1772-26-Q'").get();
  ok(cur && cur.on_hand === 20, 'inventory 主表保留最新值 20', JSON.stringify(cur));

  // 不填快照日期 → 用今天
  const r3 = await importCsv(env, {
    type: 'inventory', hasHeader: true,
    csv: 'SKU,品类,现有库存,在途,安全库存,预计到货\nXFKF-MA-1772-26-Q,床垫,15,10,0,',
  });
  const today = new Date().toISOString().slice(0, 10);
  ok(r3.snapshotDate === today, '没填快照日期时用今天', `${r3.snapshotDate} vs ${today}`);
  ok(db.prepare('SELECT COUNT(*) c FROM inventory_snapshot').get().c === 3,
    '累计 3 条快照', String(db.prepare('SELECT COUNT(*) c FROM inventory_snapshot').get().c));
}

/* ============================================================
 * 6. 安全库存：手工优先 / 自动算
 * ========================================================== */
console.log('\n===== 6. 安全库存 =====');
{
  const db = freshDb();
  // seed.sql 里有硬编码的 invData / invSuggestData 矫正值，会整体覆盖自动聚合。
  // 这一节要验证的是「自动算」，先把这两个 override 摘掉。
  db.prepare("DELETE FROM overrides WHERE key IN ('invData','invSuggestData')").run();
  const env = { DB: d1Adapter(db) };
  // 8 月 1~28 日每天一条明细：S-A 每天 1 件（日均 1），S-B 隔天 1 件（共 14 件，日均 0.5）
  // 必须按天铺开 —— 全塞在一天的话，日均会被算成「那一天的销量」，严重高估。
  const lines = ['订单日期,平台,订单号,SKU,品类,销量,商品销售额,邮费收入,币种,汇率'];
  for (let i = 1; i <= 28; i++) {
    const d = `2026-08-${String(i).padStart(2, '0')}`;
    lines.push(`${d},P,A${i},S-A,床垫,1,100,0,AUD,1`);
    lines.push(`${d},P,B${i},S-B,床垫,${i % 2},100,0,AUD,1`);
  }
  await importCsv(env, { type: 'sales', csv: lines.join('\n'), hasHeader: true, mode: 'append' });
  // 库存：S-A 手工填安全库存 50；S-B 填 0 → 自动算
  await importCsv(env, {
    type: 'inventory', hasHeader: true,
    csv: [
      'SKU,品类,现有库存,在途,安全库存,预计到货',
      'S-A,床垫,60,0,50,',
      'S-B,床垫,60,0,0,',
    ].join('\n'),
  });

  const dash = await buildDashboard(env);
  const a = dash.invData.find((r) => r.sku === 'S-A');
  const b = dash.invData.find((r) => r.sku === 'S-B');

  ok(a.safetyStock === 50 && a.safetyAuto === false,
    'S-A 用手工填的安全库存 50', JSON.stringify({ ss: a.safetyStock, auto: a.safetyAuto }));
  // S-B 日均 0.5，buffer 14 天 → SS = ceil(0.5×14) = 7
  ok(b.safetyStock === 7 && b.safetyAuto === true,
    'S-B 自动算：日均 0.5 × 缓冲 14 天 = 7', JSON.stringify({ ss: b.safetyStock, auto: b.safetyAuto }));
  ok(a.leadTime === 45, '默认补货提前期 45 天（海运，待 Yitta 核实）', String(a.leadTime));

  // 分级阈值改成看提前期（leadTime 45 + buffer 14 = 59）：
  ok(a.days === 60, 'S-A 日均 1、库存 60 → 可售 60 天', `${a.days} 天`);
  ok(a.statusText === '尚可', 'S-A：59 ≤ 60 < 118 → 尚可', `${a.days}天 → ${a.statusText}`);
  // S-A 目标库存 = ceil(1 × 59) + SS 50 = 109；现有 60、在途 0 → 建议补 49
  ok(a.suggest === 49, 'S-A 建议补货 = 目标 109 − 现有 60 − 在途 0 = 49', `${a.suggest}`);

  ok(b.days === 120, 'S-B 日均 0.5、库存 60 → 可售 120 天', `${b.days} 天`);
  ok(b.statusText === '充足', 'S-B：120 ≥ 118 → 充足', `${b.days}天 → ${b.statusText}`);
  // S-B 目标 = ceil(0.5 × 59) + 7 = 37 < 现有 60 → 不用补
  ok(b.suggest === 0, 'S-B 库存已超目标（37 < 60）→ 不建议补货', `${b.suggest}`);
}

/* ============================================================
 * 7. 毛利告警要出现在 dashboard 里
 * ========================================================== */
console.log('\n===== 7. 毛利告警 =====');
{
  const db = freshDb();
  const env = { DB: d1Adapter(db) };
  const dash = await buildDashboard(env);
  ok(dash.marginData && Array.isArray(dash.marginData.rows), 'dashboard 返回 marginData.rows');
  const w = dash.warnings || [];
  ok(w.some((x) => /采购成本/.test(x)), '有「缺采购成本」告警');
  ok(w.some((x) => /估算费率/.test(x)), '有「费率是估算值」告警');
  ok(w.some((x) => /没有广告数据/.test(x)), '有「缺广告数据」告警');
  ok(dash.marginData.missingCost === dash.marginData.skuCount,
    `所有 ${dash.marginData.skuCount} 个 SKU 都缺成本（当前 sku_master 里 cost 全是 0）`);
}

/* ============================================================
 * 8. 成本模型 v2：按售价% 与 按件绝对额 分开
 *
 * 为什么要拆：快递/处理费是按件收的，不是按售价等比收的。
 * 一刀切百分比会让低单价商品（枕头）毛利虚高、高单价商品（床垫）毛利虚低，
 * 加投决策会做反。这里用两个极端例子把这个偏差钉死。
 * ========================================================== */
console.log('\n===== 8. 成本模型 v2（% 与 按件 分开）=====');
{
  // 床垫：ASP 419，佣金 15%，单件履约 45（快递+出入库）
  // 枕头：ASP  38，佣金 15%，单件履约 12
  const sales = [
    { sku: 'MA-M', order_date: '2026-08-10', revenue: 419, qty: 1, category: '床垫' },
    { sku: 'PL-P', order_date: '2026-08-10', revenue: 38, qty: 1, category: '枕头' },
  ];
  const master = [
    { sku: 'MA-M', cost: 800, cost_currency: 'RMB', fulfil_pct: 0, fulfil_per_unit: 45 },
    { sku: 'PL-P', cost: 120, cost_currency: 'RMB', fulfil_pct: 0, fulfil_per_unit: 12 },
  ];
  const meta = { margin_month: '2026-08', fx_aud_cny: 4.7, fulfil_pct: 0, fulfil_per_unit: 0, fulfil_pct_confirmed: '1' };
  const d = buildMargin(sales, master, [], meta);
  const mm = d.rows.find((r) => r.sku === 'MA-M');
  const pp = d.rows.find((r) => r.sku === 'PL-P');

  ok(mm.fulfilPerUnit === 45, `床垫单件履约费 45（实际 ${mm.fulfilPerUnit}）`);
  ok(mm.asp === 419, `床垫 ASP 419（实际 ${mm.asp}）`);
  ok(Math.abs(mm.unitFulfil - 45) < 0.01, `床垫履约只算按件部分：0% × 419 + 45 = 45（实际 ${mm.unitFulfil}）`);
  // 采购成本 800 / 4.7 = 170.21
  ok(Math.abs(mm.unitCostAud - 170.21) < 0.02, `床垫采购成本 800/4.7 = 170.21（实际 ${mm.unitCostAud}）`);
  ok(Math.abs(mm.unitMargin - (419 - 170.21 - 45)) < 0.02,
    `床垫单件毛利 = 419 − 170.21 − 45 = 203.79（实际 ${mm.unitMargin}）`);

  ok(pp.unitFulfil === 12, `枕头履约 12（实际 ${pp.unitFulfil}）`);
  ok(Math.abs(pp.unitCostAud - 25.53) < 0.02, `枕头采购成本 120/4.7 = 25.53（实际 ${pp.unitCostAud}）`);
  ok(Math.abs(pp.unitMargin - (38 - 25.53 - 12)) < 0.02,
    `枕头单件毛利 = 38 − 25.53 − 12 = 0.47（实际 ${pp.unitMargin}）`);

  // 关键：枕头实际履约费率 12/38 = 31.6%，床垫 45/419 = 10.7%
  const pillowPct = (12 / 38) * 100;
  const mattressPct = (45 / 419) * 100;
  ok(pillowPct > mattressPct * 2.5,
    `低单价的枕头履约费率 ${pillowPct.toFixed(1)}% 远高于床垫 ${mattressPct.toFixed(1)}% —— 一刀切会失真`);
}

console.log('\n===== 8b. 旧行为不炸：fulfil_per_unit 为 0 时退化成纯百分比 =====');
{
  const sales = [{ sku: 'X', order_date: '2026-08-10', revenue: 100, qty: 1, category: 'c' }];
  const master = [{ sku: 'X', cost: 100, cost_currency: 'AUD', fulfil_pct: 30, fulfil_per_unit: 0 }];
  const meta = { margin_month: '2026-08', fx_aud_cny: 4.7, fulfil_pct: 30, fulfil_per_unit: 0, fulfil_pct_confirmed: '1' };
  const d = buildMargin(sales, master, [], meta);
  const r = d.rows.find((x) => x.sku === 'X');
  ok(Math.abs(r.unitFulfil - 30) < 0.01, `履约 = 100 × 30% + 0 = 30（实际 ${r.unitFulfil}）`);
  ok(Math.abs(r.unitMargin - (-30)) < 0.01, `单件毛利 = 100 − 100 − 30 = −30（实际 ${r.unitMargin}）`);
}

console.log('\n===== 8c. 全局兜底：SKU 没填就用 meta.fulfil_per_unit =====');
{
  const sales = [{ sku: 'Y', order_date: '2026-08-10', revenue: 200, qty: 1, category: 'c' }];
  const master = [{ sku: 'Y', cost: 50, cost_currency: 'AUD', fulfil_pct: 0, fulfil_per_unit: 0 }];
  const meta = { margin_month: '2026-08', fx_aud_cny: 4.7, fulfil_pct: 10, fulfil_per_unit: 25, fulfil_pct_confirmed: '1' };
  const d = buildMargin(sales, master, [], meta);
  const r = d.rows.find((x) => x.sku === 'Y');
  // ASP 200 × 10% = 20，加按件 25 → 45
  ok(Math.abs(r.unitFulfil - 45) < 0.01, `履约 = 200 × 10% + 25 = 45（实际 ${r.unitFulfil}）`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
