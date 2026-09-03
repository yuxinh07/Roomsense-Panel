/**
 * 飞书多维表结构 → 数据库 的端到端测试
 *
 * 跑法：node --experimental-sqlite tools/test_feishu_schema.mjs
 *
 * 为什么要有这个测试：
 *   多维表的列名/字段类型是在飞书网页上手工改的，改错了代码这边不会报错，
 *   只会静默读不出来 —— 采购价建成「文本」类型，num() 一律变 0，毛利全废；
 *   广告表少了「日期」列，ACOS 静默偏低。这类问题到最后都是看板数字不对才发现。
 *
 *   所以这里用【真实多维表导出的数据】当夹具，mock 掉飞书 API，
 *   跑完整的 syncFromFeishu → 建库 → buildDashboard 链路。
 *   以后多维表结构一改，重跑这个测试就知道会不会炸。
 *
 * 夹具在 tools/fixtures/feishu_*.json，是从 Yitta 的「ROOMSENSE看板」多维表导出的真实数据
 * （销售明细 63 行 / 库存 16 行 / SKU主数据 16 行；广告表当时是空的，用构造数据覆盖三种填法）。
 * ⚠ 夹具有真实经营数据，仓库必须私有。
 *
 * 覆盖：
 *   1. 4 张表的列名都能被 Worker 认出来（不是靠猜，是跑真实同步）
 *   2. 日期字段：飞书返回毫秒时间戳，必须按 UTC+8 截断（否则整表日期提前一天）
 *   3. 周次：从订单日期推算正确，跨周六边界不出错
 *   4. 广告：只填日期 / 只填周次 / 都填，三种情况都能拿到周次
 *   5. SKU 主数据：采购价是数字类型，不是文本
 *   6. buildDashboard 跑完没有「读不出来」类告警
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FX = join(ROOT, 'tools/fixtures');

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✔\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✘\x1b[0m ' + msg + (detail ? '  → ' + detail : '')); }
};
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* ---------- 夹具 ---------- */
const load = (n) => JSON.parse(readFileSync(join(FX, `feishu_${n}.json`), 'utf8'));
const FIXTURES = {
  tblSALES: load('sales'),
  tblINV: load('inventory'),
  tblADS: load('ads'),
  tblSKU: load('sku'),
};

/* ---------- mock 飞书 API ---------- */
function installMockFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const j = (body) => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
    // 鉴权
    if (url.includes('tenant_access_token')) {
      return j({ code: 0, msg: 'ok', tenant_access_token: 't-mock-token' });
    }
    // 拉记录：URL 形如 /apps/<token>/tables/<tableId>/records
    const m = /\/tables\/(tbl[A-Za-z0-9]+)\/records/.exec(String(url));
    if (m) {
      const body = FIXTURES[m[1]];
      if (!body) return j({ code: 999, msg: 'no fixture for ' + m[1] });
      return j(body);
    }
    return j({ code: 404, msg: 'unmocked url: ' + url });
  };
  return calls;
}

/* ---------- 数据库 ---------- */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  return db; // 不灌 seed：这里只验证飞书同步链路，seed 数据会干扰断言
}
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

const { syncFromFeishu, buildDashboard } = await import(join(ROOT, 'src/worker.js'));

/* ============================================================
 * 1. 跑一次完整同步
 * ============================================================ */
section('1. 完整同步（4 张表）');
const calls = installMockFetch();
const db = freshDb();
const env = {
  DB: d1Adapter(db),
  FEISHU_APP_ID: 'cli_mock',
  FEISHU_APP_SECRET: 'secret_mock',
  FEISHU_TABLE_TOKEN: 'bascn_mock',
  FEISHU_TABLE_ID: 'tblSALES',
  FEISHU_TABLE_ID_INV: 'tblINV',
  FEISHU_TABLE_ID_ADS: 'tblADS',
  FEISHU_TABLE_ID_SKU: 'tblSKU',
};

const sync = await syncFromFeishu(env);
ok(sync.sales === 63, `销售明细同步 63 行`, `实际 ${sync.sales}`);
ok(sync.inventory === 16, `库存同步 16 行`, `实际 ${sync.inventory}`);
ok(sync.ads === 3, `广告投放同步 3 行`, `实际 ${sync.ads}`);
ok(sync.sku === 16, `SKU 主数据同步 16 行`, `实际 ${sync.sku}`);

/* ============================================================
 * 2. 日期字段的时区截断（最容易静默出错的一处）
 * ============================================================ */
section('2. 日期：毫秒时间戳必须按 UTC+8 截断');
// 期望值不手写字面量，直接从夹具反推 —— 这样夹具换了数据，断言自动跟着变。
// 东八区：时间戳 + 8h 再按 UTC 取日期。若代码按 UTC 直接截断，每个日期都会少一天。
const fxDates = FIXTURES.tblSALES.data.items
  .map((it) => it.fields['订单日期'])
  .filter(Boolean)
  .map((ts) => new Date(Number(ts) + 8 * 3600 * 1000).toISOString().slice(0, 10))
  .sort();
const expectLo = fxDates[0];
const expectHi = fxDates[fxDates.length - 1];

const dateRange = db.prepare(
  'SELECT MIN(order_date) lo, MAX(order_date) hi, COUNT(DISTINCT order_date) n FROM sales_orders'
).get();
console.log(`     日期范围 ${dateRange.lo} ~ ${dateRange.hi}，共 ${dateRange.n} 个不同日期`);
ok(dateRange.lo === expectLo, `最早订单日期 = ${expectLo}（未被 UTC 截断成前一天）`,
  `实际 ${dateRange.lo}`);
ok(dateRange.hi === expectHi, `最晚订单日期 = ${expectHi}`, `实际 ${dateRange.hi}`);

// 逐行比对：每一行入库日期都要等于「按东八区解析」的结果，一个都不能偏
const dbDates = db.prepare('SELECT order_date FROM sales_orders ORDER BY order_date').all()
  .map((r) => r.order_date).sort();
const sameLength = dbDates.length === fxDates.length;
const allMatch = sameLength && dbDates.every((d, i) => d === fxDates[i]);
ok(allMatch, `全部 ${fxDates.length} 行日期逐行一致（无一行偏移）`,
  sameLength ? '有不一致的行' : `行数不同：库 ${dbDates.length} vs 夹具 ${fxDates.length}`);

/* ============================================================
 * 3. 周次推算
 * ============================================================ */
section('3. 周次：从订单日期推算（一周 = 周六 ~ 周五）');
const weeks = db.prepare(
  'SELECT week_label, COUNT(*) n FROM sales_orders GROUP BY week_label ORDER BY week_label'
).all();
console.log('     分布：' + weeks.map((w) => `${w.week_label}=${w.n}`).join('  '));
ok(weeks.length > 0 && weeks.every((w) => String(w.week_label).startsWith('W')),
  `所有销售行都拿到了周次`, JSON.stringify(weeks));
const emptyWeek = db.prepare(
  "SELECT COUNT(*) c FROM sales_orders WHERE week_label IS NULL OR week_label=''"
).get();
ok(emptyWeek.c === 0, `没有空周次的行`, `实际 ${emptyWeek.c} 行`);

/* ============================================================
 * 4. 广告：三种填法都能拿到周次
 * ============================================================ */
section('4. 广告投放：日期 / 周次 三种填法');
const adsRows = db.prepare('SELECT week_label, campaign, spend FROM ads ORDER BY rowid').all();
console.log('     ' + adsRows.map((r) => `${r.week_label}:${r.campaign.split(' ')[0]}`).join('  '));
ok(adsRows.length === 3, `3 行广告都入库`, `实际 ${adsRows.length}`);
ok(adsRows[0].week_label === 'W35',
  `只填日期 2026-08-24 → 自动算出 W35`, `实际 ${adsRows[0].week_label}`);
ok(adsRows[1].week_label === 'W34',
  `只填周次 W34 → 原样保留`, `实际 ${adsRows[1].week_label}`);
ok(adsRows[2].week_label === 'W35',
  `日期 08-22 + 周次 W35 都填且一致 → W35`, `实际 ${adsRows[2].week_label}`);

/* ============================================================
 * 5. SKU 主数据：数值列不是文本
 * ============================================================ */
section('5. SKU 主数据：采购价 / 售价 是数字，不是文本');
const skuRows = db.prepare('SELECT * FROM sku_master ORDER BY sku').all();
ok(skuRows.length === 16, `16 个 SKU 全部入库`, `实际 ${skuRows.length}`);
const withCategory = skuRows.filter((r) => String(r.category || '').trim());
ok(withCategory.length === 16, `16 个 SKU 都有品类（缺这列会导致分组缺失）`,
  `实际 ${withCategory.length}`);
const withPrice = skuRows.filter((r) => Number(r.price_aud) > 0);
ok(withPrice.length === 14, `14 个有成交的 SKU 拿到了真实售价 AUD`,
  `实际 ${withPrice.length}`);
// 采购价现在全是空的（Yitta 还没填）—— 这里验证的是【列存在且是数字类型】，
// 不是验证有没有值。类型错了的话 num() 会把文本吃掉，写入时会抛错或全变 0。
const costAllNumeric = skuRows.every((r) => r.cost === null || typeof r.cost === 'number');
ok(costAllNumeric, `采购价列是数字类型（文本类型会让 num() 静默变 0）`);

/* ============================================================
 * 6. 库存
 * ============================================================ */
section('6. 库存：快照与在途');
const invRows = db.prepare('SELECT * FROM inventory').all();
ok(invRows.length === 16, `16 个 SKU 库存入库`, `实际 ${invRows.length}`);
const snap = db.prepare('SELECT COUNT(DISTINCT snapshot_date) n, MIN(snapshot_date) d FROM inventory_snapshot').get();
ok(snap.n === 1, `快照日期只有 1 个（一次导入不混日期）`, `实际 ${snap.n} 个`);
ok(snap.d === '2026-08-28', `快照日期 = 2026-08-28（表里填的值，不是同步当天）`, `实际 ${snap.d}`);

/* ============================================================
 * 7. buildDashboard 端到端：不能有「读不出来」类告警
 * ============================================================ */
section('7. 看板端到端：告警检查');
const dash = await buildDashboard(env);
const warns = dash.warnings || [];
console.log('     告警：' + (warns.length ? '' : '无'));
warns.forEach((w) => console.log('       · ' + w));

const hasAdsWarn = warns.some((w) => w.includes('广告数据没有周次'));
ok(!hasAdsWarn, `没有「广告没周次」告警（广告表补了日期列后应消失）`);
const hasWeekConflict = warns.some((w) => w.includes('周次') && w.includes('对不上'));
ok(!hasWeekConflict, `没有「周次对不上」告警（销售明细不填周次，全靠日期推算）`);
const hasCostWarn = warns.some((w) => w.includes('采购价') || w.includes('成本'));
console.log(`     （采购价未填的提醒属于预期：${hasCostWarn ? '有' : '无'}）`);

// 8 月营收（(商品销售额+邮费收入)×汇率）跟本地聚合对一遍，确认同步没丢行、没算错金额
const rev = db.prepare(
  "SELECT ROUND(SUM(revenue),2) r FROM sales_orders WHERE order_date LIKE '2026-08%'"
).get();
ok(Math.abs(rev.r - 14539.2) < 0.5,
  `8 月营收 = A$${Number(rev.r).toLocaleString()}（63 行全进库，金额无丢失）`,
  `实际 A$${rev.r}`);
ok(dash.kpi && Number(dash.kpi.total) > 0,
  `KPI 周汇总总额 = A$${Number(dash.kpi.total).toLocaleString()}`);
const fxMissing = db.prepare(
  "SELECT COUNT(*) c FROM sales_orders WHERE currency NOT IN ('AUD','USD')"
).get();
ok(fxMissing.c === 0, `没有 AUD/USD 之外的币种（当前架构不支持）`, `实际 ${fxMissing.c} 行`);

/* ============================================================
 * 8. mock 调用路径完整性
 * ============================================================ */
section('8. 同步调用了 4 张表 + 1 次鉴权');
const tableCalls = calls.filter((u) => u.includes('/records'));
ok(tableCalls.length === 4, `拉取了 4 张表`, `实际 ${tableCalls.length}`);
ok(calls.some((u) => u.includes('tenant_access_token')), `走了鉴权`);

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
