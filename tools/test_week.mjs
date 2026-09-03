/**
 * 周次来源的测试（销售明细 vs 广告投放）
 *
 * 跑法：node --experimental-sqlite tools/test_week.mjs
 *
 * 背景（Yitta 2026-09-03 提问）：
 *   1. 广告投放表的「周次」能不能自动算？  → 能，给个「日期」列即可
 *   2. 销售明细表要不要加「周次」列？      → 不要，系统从订单日期自动算
 *
 * 覆盖：
 *   1. 销售明细：不填周次 → 从订单日期自动算
 *   2. 销售明细：填了周次 → 以手填为准（临时覆盖通道）
 *   3. 销售明细：手填周次与日期打架 → buildDashboard 告警，不静默
 *   4. 广告：只填周次 → 向后兼容，原样入库
 *   5. 广告：只填日期 → 自动算周次（该周任意一天都归同一周）
 *   6. 广告：周次和日期都填 → 以周次为准，冲突时返回 conflict 计数
 *   7. 广告：两者都空 → 入库后 buildDashboard 告警（ACOS 会静默偏低，必须显形）
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

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(join(ROOT, 'seed.sql'), 'utf8'));
  return db;
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

/** 干净库：清掉 seed 里会干扰断言的数据（销售明细 / 广告） */
function bareDb() {
  const db = freshDb();
  db.exec('DELETE FROM sales_orders; DELETE FROM ads;');
  return db;
}

const { buildDashboard, importCsv } = await import(join(ROOT, 'src/worker.js'));

const salesCsv = (rows) =>
  ['订单日期,平台,订单号,SKU,品类,销量,商品销售额,邮费收入,币种,汇率']
    .concat(rows)
    .join('\n');

const adsCsv = (header, rows) => [header].concat(rows).join('\n');

/* ============================================================
 * 1. 销售明细：不填周次 → 自动算
 * ========================================================== */
console.log('\n===== 1. 销售明细：周次自动从订单日期推算 =====');
{
  const db = bareDb();
  const env = { DB: d1Adapter(db) };
  // 锚点：W35 = 2026-08-22(周六) ~ 08-28(周五)，W36 = 08-29 ~ 09-04
  const r = await importCsv(env, {
    type: 'sales',
    csv: salesCsv([
      '2026-08-21,Bunnings,T1,S-A,床垫,1,100,10,AUD,',
      '2026-08-22,Bunnings,T2,S-A,床垫,1,100,10,AUD,',
      '2026-08-28,Bunnings,T3,S-A,床垫,1,100,10,AUD,',
      '2026-08-29,Bunnings,T4,S-A,床垫,1,100,10,AUD,',
    ]),
  });
  ok(r.ok && r.inserted === 4, `导入 4 行（inserted=${r.inserted}）`);

  const got = Object.fromEntries(
    db.prepare('SELECT order_date, week_label FROM sales_orders').all().map((x) => [x.order_date, x.week_label])
  );
  ok(got['2026-08-21'] === 'W34', `08-21 → W34（实际 ${got['2026-08-21']}）`);
  ok(got['2026-08-22'] === 'W35', `08-22 → W35（实际 ${got['2026-08-22']}）`);
  ok(got['2026-08-28'] === 'W35', `08-28 → W35（实际 ${got['2026-08-28']}）`);
  ok(got['2026-08-29'] === 'W36', `08-29 → W36（实际 ${got['2026-08-29']}）`);
}

/* ============================================================
 * 2. 销售明细：手填周次 → 以手填为准
 * ========================================================== */
console.log('\n===== 2. 销售明细：手填周次是覆盖通道 =====');
{
  const db = bareDb();
  const env = { DB: d1Adapter(db) };
  await importCsv(env, {
    type: 'sales',
    csv: ['订单日期,平台,订单号,SKU,品类,销量,商品销售额,邮费收入,币种,汇率,周次',
          '2026-08-22,Bunnings,T1,S-A,床垫,1,100,10,AUD,,W99'].join('\n'),
  });
  const row = db.prepare('SELECT week_label FROM sales_orders WHERE order_no=?').get('T1');
  ok(row.week_label === 'W99', `手填 W99 覆盖掉自动推算的 W35（实际 ${row.week_label}）`);
}

/* ============================================================
 * 3. 销售明细：手填周次与日期打架 → 告警
 * ========================================================== */
console.log('\n===== 3. 销售明细：周次与日期对不上要告警（不许静默）=====');
{
  const db = bareDb();
  const env = { DB: d1Adapter(db) };
  // 先放一行干净的，确认不误报
  await importCsv(env, {
    type: 'sales',
    csv: salesCsv(['2026-08-22,Bunnings,T-OK,S-A,床垫,1,100,10,AUD,']),
  });
  const clean = await buildDashboard(env);
  ok(
    !clean.warnings.some((w) => /周次/.test(w)),
    '周次正确时不报周次告警',
    clean.warnings.filter((w) => /周次/.test(w)).join(' | ')
  );

  // 再放一行打架的
  await importCsv(env, {
    type: 'sales',
    csv: ['订单日期,平台,订单号,SKU,品类,销量,商品销售额,邮费收入,币种,汇率,周次',
          '2026-08-22,Bunnings,T-BAD,S-A,床垫,1,100,10,AUD,,W34'].join('\n'),
  });
  const bad = await buildDashboard(env);
  const w = bad.warnings.find((x) => /周次/.test(x));
  ok(!!w, '打架时报出周次告警');
  ok(w && /1 行/.test(w), `告警里写明是 1 行（实际：${w}）`);
  ok(w && /不用填周次/.test(w), '告警里直接给出处理建议（删掉该列）');
}

/* ============================================================
 * 4. 广告：只填周次（向后兼容）
 * ========================================================== */
console.log('\n===== 4. 广告：只填周次 → 原样入库（向后兼容）=====');
{
  const db = bareDb();
  const env = { DB: d1Adapter(db) };
  const r = await importCsv(env, {
    type: 'ads',
    csv: adsCsv('周次,平台,广告活动,花费,广告销售额,订单数', ['W35,Bunnings,XFKF-S-A (Auto),50,300,3']),
  });
  ok(r.ok && r.inserted === 1, `导入 1 行（inserted=${r.inserted}）`);
  const row = db.prepare('SELECT week_label, campaign, spend FROM ads').get();
  ok(row.week_label === 'W35', `周次原样保留（实际 ${row.week_label}）`);
  ok(r.autoWeek === 0, `autoWeek=0，没走自动推算（实际 ${r.autoWeek}）`);
}

/* ============================================================
 * 5. 广告：只填日期 → 自动算周次（该周任意一天都归同一周）
 * ========================================================== */
console.log('\n===== 5. 广告：只填日期 → 自动算周次 =====');
{
  const db = bareDb();
  const env = { DB: d1Adapter(db) };
  const r = await importCsv(env, {
    type: 'ads',
    // W35 = 08-22(周六) ~ 08-28(周五)，7 天各来一行，都应归到 W35
    csv: adsCsv('日期,平台,广告活动,花费,广告销售额,订单数', [
      '2026-08-22,Bunnings,XFKF-S-A (Auto),10,60,1',
      '2026-08-24,Bunnings,XFKF-S-A (Auto),10,60,1',
      '2026-08-28,Bunnings,XFKF-S-A (Auto),10,60,1',
      '2026-08-29,Bunnings,XFKF-S-A (Auto),10,60,1',
    ]),
  });
  ok(r.inserted === 4, `导入 4 行（inserted=${r.inserted}）`);
  ok(r.autoWeek === 4, `autoWeek=4，四行都走了自动推算（实际 ${r.autoWeek}）`);

  // ads 表不存日期列，日期只用来推算 week_label；按插入顺序断言即可
  const weeks = db.prepare('SELECT week_label FROM ads ORDER BY id').all().map((x) => x.week_label);
  ok(weeks[0] === 'W35', `08-22（周六·周首日）→ W35（实际 ${weeks[0]}）`);
  ok(weeks[1] === 'W35', `08-24（周一·周中间）→ W35（实际 ${weeks[1]}）`);
  ok(weeks[2] === 'W35', `08-28（周五·周末尾）→ W35（实际 ${weeks[2]}）`);
  ok(weeks[3] === 'W36', `08-29（下周六）→ W36（实际 ${weeks[3]}）`);
}

/* ============================================================
 * 6. 广告：周次 + 日期都填 → 以周次为准，冲突要计数
 * ========================================================== */
console.log('\n===== 6. 广告：周次优先，冲突不静默 =====');
{
  const db = bareDb();
  const env = { DB: d1Adapter(db) };
  const r = await importCsv(env, {
    type: 'ads',
    csv: adsCsv('日期,周次,平台,广告活动,花费,广告销售额,订单数', [
      '2026-08-22,W35,Bunnings,XFKF-S-A (Auto),10,60,1',
      '2026-08-24,W40,Bunnings,XFKF-S-A (Auto),10,60,1',
    ]),
  });
  ok(r.conflict === 1, `1 行冲突被记下（conflict=${r.conflict}）`);
  const rows = db.prepare('SELECT week_label FROM ads ORDER BY id').all();
  ok(rows[0].week_label === 'W35', `一致的那行 → W35（实际 ${rows[0].week_label}）`);
  ok(rows[1].week_label === 'W40', `冲突的那行以手填 W40 为准（实际 ${rows[1].week_label}）`);
}

/* ============================================================
 * 7. 广告：周次和日期都空 → buildDashboard 告警
 * ========================================================== */
console.log('\n===== 7. 广告：没周次 → 告警（否则 ACOS 静默偏低）=====');
{
  const db = bareDb();
  const env = { DB: d1Adapter(db) };
  await importCsv(env, {
    type: 'ads',
    csv: adsCsv('平台,广告活动,花费,广告销售额,订单数', ['Bunnings,XFKF-S-A (Auto),50,300,3']),
  });
  const row = db.prepare('SELECT week_label FROM ads').get();
  ok(!String(row.week_label || '').trim(), `周次确实是空的（实际 "${row.week_label}"）`);

  const d = await buildDashboard(env);
  const w = d.warnings.find((x) => /行广告数据没有周次/.test(x));
  ok(!!w, '看板报出「广告没周次」告警');
  ok(w && /1 行/.test(w), `告警里写明是 1 行（实际：${w}）`);
  ok(w && /日期/.test(w), '告警里提示可以填日期列自动算');
}

/* ============================================================
 * 8. 端到端：广告只给日期，也能正确落进毛利/ACOS
 * ========================================================== */
console.log('\n===== 8. 端到端：只填日期的广告，能算进 8 月 ACOS =====');
{
  const db = bareDb();
  const env = { DB: d1Adapter(db) };

  // 8 月销售：S-A 卖 10 件 × A$110
  await importCsv(env, {
    type: 'sales',
    csv: salesCsv(['2026-08-22,Bunnings,T1,S-A,床垫,10,1000,100,AUD,']),
  });
  // SKU 主数据给个成本，否则毛利算不出来
  db.prepare("UPDATE sku_master SET cost=?, cost_currency='AUD' WHERE sku=?").run(40, 'S-A');

  // 广告：只给日期（8/24 属 W35，落在 8 月）
  await importCsv(env, {
    type: 'ads',
    csv: adsCsv('日期,平台,广告活动,花费,广告销售额,订单数', ['2026-08-24,Bunnings,XFKF-S-A (Auto),100,1100,10']),
  });

  const d = await buildDashboard(env);
  const row = (d.marginData.rows || []).find((x) => x.sku === 'S-A');
  ok(!!row, 'S-A 出现在毛利表里');
  ok(row && row.adsSpend === 100, `广告花费 100 被算进去了（实际 ${row && row.adsSpend}）`);
  ok(row && Math.abs(row.acos - (100 / 1100) * 100) < 0.01, `ACOS = 100/1100 ≈ 9.09%（实际 ${row && row.acos}）`);
  ok(
    !d.warnings.some((x) => /行广告数据没有周次/.test(x)),
    '不再报「广告没周次」'
  );
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
