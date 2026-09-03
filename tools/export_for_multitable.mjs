/**
 * 把数据库里的现有数据导出成 CSV，用于初始化多维表。
 * 生成的 CSV 可直接导入飞书多维表格 / Notion / 金山多维表格 / Excel。
 *
 * 运行: node --experimental-sqlite tools/export_for_multitable.mjs
 * 输出: multitable/*.csv
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'multitable');
fs.mkdirSync(OUT, { recursive: true });

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));

const q = (sql, ...args) => db.prepare(sql).all(...args);

/** 简单 CSV 转义 */
function csv(headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // ﻿ = UTF-8 BOM。飞书 / Excel 导入中文 CSV 没 BOM 会乱码；
  // 再导回系统时 worker 的 parseCsv 会自动剥掉 BOM，不影响解析
  return '\uFEFF' + [headers.join(',')]
    .concat(rows.map((r) => headers.map((h) => esc(r[h])).join(',')))
    .join('\n') + '\n';
}

const files = [];

// ---------- 1. 周销售汇总（现有 13 周，作为历史基线） ----------
const weekly = q("SELECT key, value FROM overrides WHERE key LIKE 'weekly.%'")
  .map((r) => ({ 周次: r.key.replace('weekly.', ''), 销售额AUD: Number(r.value) }))
  .sort((a, b) => Number(a.周次.slice(1)) - Number(b.周次.slice(1)));
fs.writeFileSync(path.join(OUT, '01_周销售汇总.csv'),
  csv(['周次', '销售额AUD'], weekly), 'utf8');
files.push(['01_周销售汇总.csv', weekly.length + ' 行']);

// ---------- 2. SKU 周销量明细 ----------
const skuWeek = q("SELECT key, value FROM overrides WHERE key LIKE 'skuWeek.%'")
  .map((r) => {
    const p = r.key.replace('skuWeek.', '').split('.');
    return { SKU: p[0], 周次: p[1], 销量: Number(r.value) };
  })
  .sort((a, b) => a.SKU.localeCompare(b.SKU) || Number(a.周次.slice(1)) - Number(b.周次.slice(1)));
fs.writeFileSync(path.join(OUT, '02_SKU周销量.csv'),
  csv(['SKU', '周次', '销量'], skuWeek), 'utf8');
files.push(['02_SKU周销量.csv', skuWeek.length + ' 行']);

// ---------- 3. 库存 ----------
// 快照日期留空 = 导入时用当天；想补录历史就填 YYYY-MM-DD。
// 每次导入都会往 inventory_snapshot 追加一条，同一天重复导入只覆盖、不重复。
const inv = q(`SELECT i.sku, m.category, i.on_hand, i.inbound, i.safety_stock, i.eta
               FROM inventory i LEFT JOIN sku_master m ON m.sku = i.sku
               ORDER BY i.sku`)
  .map((r) => ({
    快照日期: '', SKU: r.sku, 品类: r.category || '', 现有库存: r.on_hand,
    在途: r.inbound, 安全库存: r.safety_stock, 预计到货: r.eta || '',
  }));
fs.writeFileSync(path.join(OUT, '03_库存.csv'),
  csv(['快照日期', 'SKU', '品类', '现有库存', '在途', '安全库存', '预计到货'], inv), 'utf8');
files.push(['03_库存.csv', inv.length + ' 行（快照日期留空=今天）']);

// ---------- 4. SKU 主数据 ----------
const master = q('SELECT sku, name, category, spec, cost, cost_currency, price_aud, fulfil_pct, lead_time_days, safety_days FROM sku_master ORDER BY sku')
  .map((r) => ({
    SKU: r.sku, 品名: r.name || '', 品类: r.category || '', 规格: r.spec || '',
    采购价: r.cost, 币种: r.cost_currency, 售价AUD: r.price_aud,
    履约费率: r.fulfil_pct, 单件履约费: r.fulfil_per_unit,
    补货提前期: r.lead_time_days, 安全库存天数: r.safety_days,
  }));
fs.writeFileSync(path.join(OUT, '04_SKU主数据.csv'),
  csv(['SKU', '品名', '品类', '规格', '采购价', '币种', '售价AUD', '履约费率', '单件履约费', '补货提前期', '安全库存天数'], master), 'utf8');
files.push(['04_SKU主数据.csv', master.length + ' 行']);

// ---------- 5. 平台周销售额（W35 / W34） ----------
const plat = JSON.parse(
  q("SELECT value FROM overrides WHERE key='platData'")[0]?.value || '[]');
fs.writeFileSync(path.join(OUT, '05_平台周销售额.csv'),
  csv(['平台', 'W35销售额', 'W34销售额', '占比'],
    plat.map((r) => ({ 平台: r.name, W35销售额: r.thisWeek, W34销售额: r.lastWeek, 占比: r.share }))),
  'utf8');
files.push(['05_平台周销售额.csv', plat.length + ' 行']);

// ---------- 6. 销售明细（空白模板，每周往这里填） ----------
// 口径（2026-09-03 简化版）：营收(AUD) = (商品销售额 + 邮费收入) × 汇率
//   商品销售额 / 邮费收入 填【原币种】金额
//   币种只支持 AUD / USD 两种
//   汇率列填结算单里的 Order Rate to AUD（AUD=1，USD=实际汇率）
//   留空也行 —— USD 行会用后台 meta.fx_usd_aud 兜底
const TPL = [
  // 日期, 平台, 订单号, SKU, 品类, 销量, 商品销售额, 邮费收入, 币种, 汇率
  ['2026-08-24', 'Bunnings',         'BN-1001', 'XFKF-MA-1772-26-Q', '床垫', 1, 419.00, 40.00, 'AUD', 1],
  ['2026-08-25', 'Amazon Marketplace','AM-2003','XFKF-PL-1167F-WH', '枕头', 1,  38.00,  5.00, 'USD', 1.5483],
  ['2026-08-26', 'Kmart',            'KM-3007', 'XFKF-MA-1666-34-S', '床垫', 1, 259.00,  0,    'AUD', 1],
];
fs.writeFileSync(path.join(OUT, '06_销售明细_每周填写.csv'),
  csv(['订单日期', '平台', '订单号', 'SKU', '品类', '销量', '商品销售额', '邮费收入', '币种', '汇率'],
    TPL.map((r) => ({
      订单日期: r[0], 平台: r[1], 订单号: r[2], SKU: r[3], 品类: r[4],
      销量: r[5], 商品销售额: r[6], 邮费收入: r[7], 币种: r[8], 汇率: r[9],
    }))), 'utf8');
files.push(['06_销售明细_每周填写.csv', '模板 3 行（AUD + USD 各一例）']);

// ---------- 7. 广告投放（空白模板） ----------
// 「日期」和「周次」二选一，推荐填日期 —— 系统自动算周次，省得你去对 W 号。
// 填该周任意一天都行（周六到周五都归同一个 W 号）；两个都填以周次为准。
fs.writeFileSync(path.join(OUT, '07_广告投放.csv'),
  csv(['日期', '周次', '平台', '广告活动', '花费', '广告销售额', '订单数'], [
    { 日期: '2026-08-24', 周次: '', 平台: 'Amazon', 广告活动: 'XFKF-MA-1666-34 (Auto)', 花费: 40, 广告销售额: 628, 订单数: 4 },
  ]), 'utf8');
files.push(['07_广告投放.csv', '模板 1 行']);

// ---------- 8. SKU 采购成本（唯一必填项）----------
// 「8月毛利」算不出来的唯一原因就是这张表是空的。
// 只留 3 列 —— 填的东西越少，越可能真的被填上。
const costRows = q('SELECT sku, name, category, cost, cost_currency FROM sku_master ORDER BY category, sku')
  .map((r) => ({ SKU: r.sku, 品名: r.name || '', 品类: r.category || '', 采购价: r.cost || '' }));
fs.writeFileSync(path.join(OUT, '08_SKU成本_待填.csv'),
  csv(['SKU', '品名', '品类', '采购价'], costRows), 'utf8');
files.push(['08_SKU成本_待填.csv', costRows.length + ' 行 ← 只填这一列']);

console.log('已导出到 multitable/ —— 这些 CSV 可直接导入多维表：\n');
for (const [f, n] of files) console.log(`  ${f.padEnd(26)} ${n}`);
console.log(
  '\n下一步：把 08_SKU成本_待填.csv 的「采购价」填好（RMB 或 AUD 都行，币种在 04 那张表改），\n' +
  '导回来之后产品定位矩阵就能算出每个 SKU 的毛利和投流安全垫。'
);
