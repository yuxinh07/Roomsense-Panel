/**
 * 本地验证：用 Node 内置 SQLite 模拟 D1，跑一遍 schema + seed + buildDashboard。
 * 运行: node --experimental-sqlite tools/test_local.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard, importCsv, insertSales } from '../src/worker.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const db = new DatabaseSync(':memory:');

db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
console.log('✔ schema + seed 执行成功');

/** 把 node:sqlite 包装成 D1 的接口形态
 *  注意：bind() 必须返回【新的】statement。真实 D1 的 bind 返回新对象，
 *  如果这里返回同一个 stmt，batch 里的多行会共享 args，导致全被最后一行覆盖。 */
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
          const rows = sqlite.prepare(sql).all(...args);
          return Promise.resolve(rows[0] || null);
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

const d = await buildDashboard(env);

console.log('\n===== 聚合结果 =====');
console.log('周次列表 :', d.meta.weeks.join(' '));
console.log('当前周   :', d.meta.curWeek, '| 上周:', d.meta.lastWeek);
console.log('weeklyData:', JSON.stringify(d.weeklyData));
console.log('KPI      :', JSON.stringify(d.kpi));
console.log('\nSKU 趋势（前 3）:');
Object.entries(d.skuWeeklyData).slice(0, 3).forEach(([k, v]) => console.log('  ', k.padEnd(22), JSON.stringify(v)));
console.log('\nplatData 前 4:', JSON.stringify(d.platData.slice(0, 4)));
console.log('catData      :', JSON.stringify(d.catData));
console.log('\ninvSuggestData 前 3:', JSON.stringify(d.invSuggestData.slice(0, 3)));
console.log('invData 前 2      :', JSON.stringify(d.invData.slice(0, 2)));

/* ---------- 校验 ---------- */
const expect = (cond, msg) => console.log((cond ? '✔ ' : '✘ ') + msg);
console.log('\n===== 校验 =====');
expect(Object.keys(d.weeklyData).length === 13, 'weeklyData 有 13 周');
expect(d.weeklyData.W35 === 4737, 'W35 = 4737');
expect(d.kpi.total === 37852.38, '累计销售额 = 37852.38');
expect(d.skuWeeklyData['PL-1169R'] && d.skuWeeklyData['PL-1169R'].slice(-1)[0] === 0,
  'PL-1169R 的 W35 = 0（本周无销量）');
expect(Object.keys(d.skuWeeklyData).length === 10, 'SKU 趋势 10 个 SKU');
expect(d.platData.length === 12, '平台 12 行');
expect(d.platData[0].name === 'Bunnings' && d.platData[0].thisWeek === 1515.65, 'Bunnings W35 = 1515.65');
expect(d.catData.length === 2, '品类 2 行');
expect(d.invData.length === 16 && d.invSuggestData.length === 16, '库存 16 行');

/* ---------- 导入流程 ---------- */
console.log('\n===== 导入流程测试 =====');
const csv = [
  'order_date,platform,order_no,sku,category,qty,revenue',
  '2026-08-24,Bunnings,BN-9001,XFKF-MA-1772-26-Q,床垫,1,459.00',
  '2026-08-25,Amazon Marketplace,AM-9002,XFKF-PL-1167F-WH,枕头,2,86.00',
].join('\n');
const r1 = await importCsv(env, { type: 'sales', csv, hasHeader: true, mode: 'append' });
console.log('导入销售明细:', JSON.stringify(r1));

const d2 = await buildDashboard(env);
console.log('新周次出现:', d2.meta.weeks.join(' '), '| 当前周:', d2.meta.curWeek);

// 矫正值优先于明细
await env.DB.prepare(
  `INSERT INTO overrides(key,value,note) VALUES('weekly.W35','4737','test')
   ON CONFLICT(key) DO UPDATE SET value='4737'`).run();
const d3 = await buildDashboard(env);
expect(d3.weeklyData.W35 === 4737, '矫正值覆盖自动聚合：W35 仍为 4737');

// 库存导入
const invCsv = 'sku,on_hand,inbound,safety_stock,eta\nXFKF-PL-1169R-WH,0,43,30,2026-09-15';
const r2 = await importCsv(env, { type: 'inventory', csv: invCsv, hasHeader: true });
console.log('导入库存:', JSON.stringify(r2));

console.log('\n全部检查完成。');
