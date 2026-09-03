/**
 * RoomSense 运营看板 API (Cloudflare Worker + D1)
 *
 * 路由：
 *   GET  /api/dashboard        看板所需的全部聚合数据（前端唯一依赖的接口）
 *   GET  /api/sales?week=W35   原始销售明细
 *   POST /api/sales            JSON 数组批量写入明细
 *   POST /api/import           粘贴/上传 CSV 批量导入（sales / inventory / ads / sku）
 *   DELETE /api/sales?week=W35 清空某周明细（重导前先清）
 *   GET  /api/overrides        查看所有人工矫正值
 *   PUT  /api/overrides        写入人工矫正值  {key, value, note}
 *   DELETE /api/overrides?key= 删除某个矫正值
 *   POST /api/sync/feishu      手动触发从飞书多维表同步（需配置 Secrets）
 *   GET  /api/health           健康检查
 *
 * 密钥全部来自 Worker 环境变量 / Secrets，前端页面永远拿不到。
 */

/**
 * 周次锚点：W23 的第一天是 2026-05-30（周六）。
 * 口径来源：seed.sql 里 overrides('weekly.W35') 的备注「8/22-8/28 用户确认总额」。
 * 反推：W35 需覆盖 8/22，则 W23 = 8/22 - (35-23)*7 = 2026-05-30。
 * 也就是说一周 = 周六 00:00 ~ 下周五 23:59（不是常见的周日/周一起始，按 Yitta 平台口径来）。
 * 改这里之前务必确认周起始日 —— 锚点错一天，整张看板的周次全部错位。
 */
const WEEK_EPOCH_DATE = '2026-05-30';
const WEEK_EPOCH_LABEL = 23;

/**
 * 毛利参数的兜底值。全部标「待核验」：
 * fulfil_pct 是行业经验值，不是 RoomSense 的真实费率 —— 一旦 Yitta 提供真实数字，
 * 必须写进 meta 覆盖掉，并在前端告警条里持续显形，避免拿估算值当真账用。
 */
const DEFAULT_FULFIL_PCT = 30;   // 佣金 + 履约（仓租/入出库/快递）合计占售价的百分比
const DEFAULT_ADS_ALLOC = 'by_revenue'; // 广告费分摊方式：按营收占比分摊到 SKU

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, hasDb: !!env.DB, time: new Date().toISOString() });
      }

      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }

      // 其余路径交给静态资源（Workers Assets: public/）
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },

  // 可选：定时从多维表同步（wrangler.toml 里的 crons）
  async scheduled(event, env, ctx) {
    if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_TABLE_TOKEN && env.FEISHU_TABLE_ID) {
      const r = await syncFromFeishu(env);
      console.log('[cron] feishu synced:', JSON.stringify(r));
    }
  },
};

/* ============================================================
 * 路由分发
 * ========================================================== */
async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/dashboard') {
    return json(await buildDashboard(env));
  }

  if (pathname === '/api/sales') {
    if (method === 'GET') {
      const week = url.searchParams.get('week');
      const sql = week
        ? 'SELECT * FROM sales_orders WHERE week_label=? ORDER BY order_date, id'
        : 'SELECT * FROM sales_orders ORDER BY order_date DESC, id DESC LIMIT 2000';
      const q = week ? env.DB.prepare(sql).bind(week) : env.DB.prepare(sql);
      return json({ rows: (await q.all()).results || [] });
    }
    if (method === 'POST') {
      await requireAdmin(request, env);
      const body = await request.json();
      const rows = Array.isArray(body) ? body : body.rows || [];
      return json({ inserted: await insertSales(env, rows) });
    }
    if (method === 'DELETE') {
      await requireAdmin(request, env);
      const week = url.searchParams.get('week');
      if (!week) return json({ error: 'missing ?week=' }, 400);
      const r = await env.DB.prepare('DELETE FROM sales_orders WHERE week_label=?').bind(week).run();
      return json({ deleted: r.meta?.changes ?? 0 });
    }
  }

  if (pathname === '/api/import' && method === 'POST') {
    await requireAdmin(request, env);
    const body = await request.json();
    return json(await importCsv(env, body));
  }

  if (pathname === '/api/overrides') {
    if (method === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM overrides ORDER BY key').all();
      return json({ rows: r.results || [] });
    }
    if (method === 'PUT') {
      await requireAdmin(request, env);
      const body = await request.json();
      if (!body.key) return json({ error: 'missing key' }, 400);
      await env.DB.prepare(
        `INSERT INTO overrides(key, value, note, updated_at)
         VALUES(?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, note=excluded.note,
                                        updated_at=datetime('now')`
      ).bind(body.key, JSON.stringify(body.value ?? null), body.note || '').run();
      return json({ ok: true, key: body.key });
    }
    if (method === 'DELETE') {
      await requireAdmin(request, env);
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'missing ?key=' }, 400);
      await env.DB.prepare('DELETE FROM overrides WHERE key=?').bind(key).run();
      return json({ ok: true, key });
    }
  }

  if (pathname === '/api/meta' && method === 'PUT') {
    await requireAdmin(request, env);
    const body = await request.json(); // {key, value}
    await env.DB.prepare(
      `INSERT INTO meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).bind(body.key, body.value).run();
    return json({ ok: true });
  }

  if (pathname === '/api/sync/feishu' && method === 'POST') {
    await requireAdmin(request, env);
    const r = await syncFromFeishu(env);
    return json({ ok: true, synced: r });
  }

  return json({ error: 'not found: ' + pathname }, 404);
}

/* ============================================================
 * 周次 → 日期
 * ========================================================== */
function weekStart(weekLabel, epochDate, epochWeek) {
  const n = Number(String(weekLabel).replace(/\D/g, ''));
  if (!Number.isFinite(n)) return '';
  const e = new Date(`${epochDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(e)) return '';
  return new Date(e + (n - epochWeek) * 7 * 86400000).toISOString().slice(0, 10);
}

/* ============================================================
 * SKU 级毛利（按自然月）
 * ------------------------------------------------------------
 * 为什么按自然月、不按周次：
 *   Yitta 问的是「8月毛利」。8/1–8/31 和 W31–W35 不是同一段时间
 *   （W31 从 7/25 起、W35 到 8/28 止），按周次取会把 7 月底算进来、8 月末漏掉。
 *   所以这里直接用 order_date 的前 7 位切月，不碰周次。
 *
 * 单位经济模型（每件，AUD，ex.GST）：
 *   ASP       = 该月营收 / 该月销量（营收已含邮费收入、已折成 AUD）
 *   采购成本  = sku_master.cost ÷ fx_aud_cny（RMB 计价时；AUD 计价直接用）
 *   佣金+履约 = ASP × fulfil_pct
 *   单件毛利  = ASP − 采购成本 − 佣金+履约
 *   毛利率    = 单件毛利 / ASP
 *
 * 投流判据（Yitta 真正要的答案）：
 *     安全垫 = 毛利率 − ACOS
 *   安全垫 > 0 → 投流在边际上赚钱，越大越该加投。
 *   注意 ACOS 低 ≠ 赚钱：毛利率 15% 的产品 ACOS 10% 只剩 5%，
 *   不如毛利率 40% 的产品 ACOS 20%（剩 20%）。只看 ACOS 会得出相反结论。
 *
 * 数据缺失的处理原则：宁可显示「待填」，不用估算值冒充真实账。
 *   采购成本没填 → hasCost=false，unitMargin / marginPct / safety 全部为 null
 *   fulfil_pct 未核实 → 照算，但在 warnings 里持续告警
 *   广告表没数据 → adsSpend=0、acos=null（null 表示「无数据」，不是「零花费」）
 * ========================================================== */
export function buildMargin(sales, skuMaster, ads, meta, opts = {}) {
  const month = opts.month || meta.margin_month || '2026-08';
  const epochDate = meta.week_epoch_date || WEEK_EPOCH_DATE;
  const epochWeek = Number(meta.week_epoch_label || WEEK_EPOCH_LABEL);
  const fxAudCny = Number(meta.fx_aud_cny || 0);
  const globalFulfil = Number(meta.fulfil_pct ?? DEFAULT_FULFIL_PCT);
  const globalPerUnit = Number(meta.fulfil_per_unit ?? 0);
  const confirmed = String(meta.fulfil_pct_confirmed || '0') === '1';
  const master = indexBy(skuMaster, 'sku');

  // ---- 1. 该月每 SKU 的营收 / 销量 ----
  const agg = {};
  for (const r of sales) {
    if (!r.sku || !r.order_date) continue;
    if (String(r.order_date).slice(0, 7) !== month) continue;
    const a = (agg[r.sku] = agg[r.sku] || { revenue: 0, qty: 0, category: r.category || '' });
    a.revenue += num(r.revenue);
    a.qty += num(r.qty);
    if (!a.category && r.category) a.category = r.category;
  }

  // ---- 2. 广告花费分摊到 SKU ----
  // ads 表只有 week_label 没有日期，先用周起始日归到月份；
  // campaign 名形如 "XFKF-MA-1666-34 (Auto)"，按去掉 XFKF- 前缀后的前缀匹配到 SKU。
  // campaign 名形如 "XFKF-MA-1772-26 (Auto)" —— 空格后面的 "(Auto)" / "(Manual)" / "Brand"
  // 是投放类型后缀，不是 SKU 的一部分。截掉再比，否则一个都匹配不上。
  const norm = (s) => String(s || '').toUpperCase().replace(/^XFKF-/, '').trim();
  const adsBySku = {};
  let adsTotal = 0;
  let adsHasData = false;
  for (const a of ads || []) {
    const wm = weekStart(a.week_label, epochDate, epochWeek).slice(0, 7);
    if (wm !== month) continue;
    adsHasData = true;
    const spend = num(a.spend);
    adsTotal += spend;
    const cn = norm(a.campaign).split(/\s+/)[0];
    const hit = Object.keys(agg).find((sku) => {
      const sn = norm(sku).split(/\s+/)[0];
      return cn && sn && (sn.startsWith(cn) || cn.startsWith(sn));
    });
    if (hit) {
      adsBySku[hit] = (adsBySku[hit] || 0) + spend;
    } else {
      // campaign 匹配不上 SKU：先攒着，稍后按营收占比摊
      adsBySku.__unmatched = (adsBySku.__unmatched || 0) + spend;
    }
  }
  const monthRevenue = sum(Object.values(agg).map((a) => a.revenue));
  const unmatched = adsBySku.__unmatched || 0;
  if (unmatched > 0 && monthRevenue > 0) {
    for (const [sku, a] of Object.entries(agg)) {
      adsBySku[sku] = (adsBySku[sku] || 0) + (unmatched * a.revenue) / monthRevenue;
    }
  }
  delete adsBySku.__unmatched;

  // ---- 3. 逐 SKU 算单位经济 ----
  // 明细没数据的 SKU 也要列出来（从 sku_master / inventory 兜底），
  // 否则 Yitta 看不到「哪些 SKU 还缺成本」，填表无从下手。
  const skuSet = uniq([...Object.keys(agg), ...skuMaster.map((m) => m.sku), ...(opts.extraSkus || [])])
    .filter(Boolean);

  const rows = skuSet.map((sku) => {
    const m = master[sku] || {};
    const a = agg[sku] || { revenue: 0, qty: 0, category: '' };
    const qty = num(a.qty);
    const revenue = num(a.revenue);
    const asp = qty > 0 ? revenue / qty : num(m.price_aud) || 0;

    // 采购成本折成 AUD
    const rawCost = num(m.cost);
    const cur = String(m.cost_currency || 'RMB').toUpperCase();
    let unitCostAud = null;
    if (rawCost > 0) {
      if (cur === 'RMB' || cur === 'CNY') {
        unitCostAud = fxAudCny > 0 ? rawCost / fxAudCny : null;
      } else {
        unitCostAud = rawCost; // 已经是 AUD
      }
    }

    // 成本模型 v2：把「随售价等比变」和「按件固定收」两类成本分开算。
    //   佣金类（销售佣金/平台佣金/退货损耗）→ 按售价 %
    //   履约类（头程/卸货/入出库处理/快递）→ AUD/件，跟售价不成比例
    // 为什么必须分开：快递和处理费是按件/按重量收的。床垫 A$419 快递 A$45(10.7%)、
    // 枕头 A$38 快递 A$12(31.6%) —— 一刀切 30% 会低估枕头成本、高估床垫成本，加投决策会做反。
    // fulfil_per_unit 为 0 时退化成旧的纯百分比算法，老数据不会炸。
    const fulfilPct = num(m.fulfil_pct) || globalFulfil;
    const fulfilPerUnit = num(m.fulfil_per_unit) || globalPerUnit;
    const unitFulfil = asp * (fulfilPct / 100) + fulfilPerUnit;

    const hasCost = unitCostAud !== null && unitCostAud > 0 && asp > 0;
    const unitMargin = hasCost ? asp - unitCostAud - unitFulfil : null;
    const marginPct = hasCost && asp > 0 ? (unitMargin / asp) * 100 : null;

    const adsSpend = num(adsBySku[sku] || 0);
    const acos = revenue > 0 && adsHasData ? (adsSpend / revenue) * 100 : null;

    const grossProfit = hasCost ? unitMargin * qty : null;
    const netProfit = hasCost ? grossProfit - adsSpend : null;
    const netPct = hasCost && revenue > 0 ? (netProfit / revenue) * 100 : null;
    // 安全垫：毛利率 − ACOS（百分点）。>0 投流边际赚钱，越大越该加投。
    const safety = hasCost && acos !== null ? marginPct - acos : null;

    return {
      sku,
      cat: m.category || a.category || '-',
      qty,
      revenue: round2(revenue),
      asp: round2(asp),
      unitCostAud: unitCostAud === null ? null : round2(unitCostAud),
      fulfilPct: round2(fulfilPct),
      fulfilPerUnit: round2(fulfilPerUnit),
      unitFulfil: round2(unitFulfil),
      unitMargin: unitMargin === null ? null : round2(unitMargin),
      marginPct: marginPct === null ? null : round2(marginPct),
      grossProfit: grossProfit === null ? null : round2(grossProfit),
      adsSpend: round2(adsSpend),
      acos: acos === null ? null : round2(acos),
      netProfit: netProfit === null ? null : round2(netProfit),
      netPct: netPct === null ? null : round2(netPct),
      safety: safety === null ? null : round2(safety),
      hasCost,
    };
  });

  // 有销量的排前面，其次按毛利额
  rows.sort((x, y) => y.revenue - x.revenue || (y.grossProfit ?? -1e9) - (x.grossProfit ?? -1e9));

  const missingCost = rows.filter((r) => !r.hasCost).length;

  return {
    month,
    fulfilPct: globalFulfil,
    fulfilPctConfirmed: confirmed,
    fxAudCny,
    adsTotal: round2(adsTotal),
    adsHasData,
    adsAllocated: round2(sum(rows.map((r) => r.adsSpend))),
    missingCost,
    skuCount: rows.length,
    rows,
  };
}

/* ============================================================
 * 核心：聚合成看板所需的 JSON
 * ========================================================== */
async function buildDashboard(env) {
  const meta = await getMeta(env);
  const ov = await getOverrides(env);

  const epochDate = meta.week_epoch_date || WEEK_EPOCH_DATE;
  const epochWeek = Number(meta.week_epoch_label || WEEK_EPOCH_LABEL);

  const sales = (await env.DB.prepare('SELECT * FROM sales_orders').all()).results || [];
  const inv = (await env.DB.prepare('SELECT * FROM inventory').all()).results || [];
  const skuMaster = (await env.DB.prepare('SELECT * FROM sku_master').all()).results || [];

  // 统一周次（允许补算缺失的 week_label）
  for (const r of sales) {
    if (!r.week_label && r.order_date) r.week_label = weekOf(r.order_date, epochDate, epochWeek);
  }

  const weeks = sortedWeeks(sales.map((r) => r.week_label).filter(Boolean));

  // --- 1. weeklyData：周销售额 ---
  const weeklyData = {};
  for (const w of weeks) weeklyData[w] = 0;
  for (const r of sales) {
    if (r.week_label) weeklyData[r.week_label] = round0((weeklyData[r.week_label] || 0) + num(r.revenue));
  }
  applyOverrides(weeklyData, ov, 'weekly');

  // --- 2. skuWeeklyData：SKU × 周 销量 ---
  const topN = Number(meta.sku_top_n || 10);
  const skuTotals = {};
  for (const r of sales) skuTotals[r.sku] = (skuTotals[r.sku] || 0) + num(r.qty);
  const topSkus = Object.keys(skuTotals)
    .filter(Boolean)
    .sort((a, b) => skuTotals[b] - skuTotals[a])
    .slice(0, topN);

  // 人工矫正里出现过的 SKU 也要保留（明细尚未导入时的迁移场景）
  const skuOverrideNames = [];
  for (const key of Object.keys(ov)) {
    const m = /^skuWeek\.(.+)\.(W\d{1,2})$/.exec(key);
    if (m) skuOverrideNames.push(m[1]);
  }
  const allSkus = uniq([...topSkus, ...skuOverrideNames]);

  const skuWeeklyData = {};
  for (const sku of allSkus) {
    const arr = new Array(weeks.length).fill(0);
    for (const r of sales) {
      if (r.sku === sku && r.week_label) {
        arr[weeks.indexOf(r.week_label)] += num(r.qty);
      }
    }
    skuWeeklyData[sku] = arr;
  }
  // 人工矫正：key = skuWeek.<SKU>.<WEEK>；周次不在列表时自动扩展
  let weeksMut = weeks.slice();
  for (const [key, val] of Object.entries(ov)) {
    const m = /^skuWeek\.(.+)\.(W\d{1,2})$/.exec(key);
    if (!m) continue;
    let idx = weeksMut.indexOf(m[2]);
    if (idx < 0) { weeksMut = sortedWeeks([...weeksMut, m[2]]); idx = weeksMut.indexOf(m[2]); }
    if (!skuWeeklyData[m[1]]) skuWeeklyData[m[1]] = new Array(weeksMut.length).fill(0);
    while (skuWeeklyData[m[1]].length < weeksMut.length) skuWeeklyData[m[1]].push(0);
    skuWeeklyData[m[1]][idx] = val;
  }
  const finalWeeks = weeksMut;
  for (const k of Object.keys(skuWeeklyData)) {
    while (skuWeeklyData[k].length < finalWeeks.length) skuWeeklyData[k].push(0);
  }

  // 矫正值可能引入新的周次，当前周 / 上一周以最终周列表为准
  const curWeek = finalWeeks[finalWeeks.length - 1] || null;
  const lastWeek = finalWeeks[finalWeeks.length - 2] || null;

  // --- 3. platData：平台本周 vs 上周 ---
  const platThis = {}, platLast = {};
  for (const r of sales) {
    const p = r.platform || '未标注';
    if (r.week_label === curWeek) platThis[p] = (platThis[p] || 0) + num(r.revenue);
    if (r.week_label === lastWeek) platLast[p] = (platLast[p] || 0) + num(r.revenue);
  }
  const platNames = uniq([...Object.keys(platThis), ...Object.keys(platLast)]);
  const totalThis = sum(Object.values(platThis));
  let platData = platNames
    .map((name) => ({
      name,
      thisWeek: round2(platThis[name] || 0),
      lastWeek: round2(platLast[name] || 0),
      share: totalThis > 0 ? Math.round(((platThis[name] || 0) / totalThis) * 100) + '%' : '0%',
    }))
    .sort((a, b) => b.thisWeek - a.thisWeek);
  if (Array.isArray(ov['platData'])) platData = ov['platData'];

  // --- 4. catData：品类（用上一个完整周 = lastWeek）---
  const catMap = {};
  for (const r of sales) {
    const c = r.category || '未分类';
    catMap[c] = catMap[c] || { name: c, orders: new Set(), units: 0, revenue: 0, cumUnits: 0 };
    if (r.week_label === lastWeek) {
      catMap[c].orders.add(r.order_no || r.id);
      catMap[c].units += num(r.qty);
      catMap[c].revenue += num(r.revenue);
    }
    if (finalWeeks.indexOf(r.week_label) <= finalWeeks.indexOf(lastWeek)) {
      catMap[c].cumUnits += num(r.qty);
    }
  }
  let catData = Object.values(catMap).map((c) => ({
    name: c.name,
    orders: c.orders.size,
    units: c.units,
    revenue: round0(c.revenue),
    cumUnits: c.cumUnits,
  }));
  if (Array.isArray(ov['catData'])) catData = ov['catData'];

  // --- 5. 库存 ---
  const masterBySku = indexBy(skuMaster, 'sku');
  const lastWeekQty = {}, last7Qty = {};

  // 补货参数（meta 可覆盖；默认值标「待核验」，见 schema.sql 注释）
  const defaultLeadTime = Number(meta.lead_time_days || 45);
  const bufferDays = Number(meta.buffer_days || 14);
  const windowDays = Number(meta.demand_window_days || 28);

  const cutoff = new Date(`${maxDate(sales)}T00:00:00Z`);
  const d7Start = new Date(cutoff.getTime() - 6 * 86400000);
  // 日均销量窗口：默认 28 天。比「近 7 天」稳得多 ——
  // 一个 SKU 一周只卖 1~2 件，7 天窗口的日均会在 0.14 和 0.43 之间乱跳，
  // 用它算可售天，同一款上周显示 50 天、这周就变 16 天，这就是「数据对不上」的来源之一。
  const winStart = new Date(cutoff.getTime() - (windowDays - 1) * 86400000);
  const winQty = {};
  let firstSaleDate = '';

  for (const r of sales) {
    if (!r.sku) continue;
    if (r.week_label === lastWeek) lastWeekQty[r.sku] = (lastWeekQty[r.sku] || 0) + num(r.qty);
    if (!r.order_date) continue;
    if (!firstSaleDate || r.order_date < firstSaleDate) firstSaleDate = r.order_date;
    const d = new Date(`${r.order_date}T00:00:00Z`);
    if (d >= d7Start && d <= cutoff) last7Qty[r.sku] = (last7Qty[r.sku] || 0) + num(r.qty);
    if (d >= winStart && d <= cutoff) winQty[r.sku] = (winQty[r.sku] || 0) + num(r.qty);
  }

  // 实际覆盖天数：数据不满 windowDays 时按真实天数除，否则日均会被系统性低估
  let coveredDays = windowDays;
  if (firstSaleDate && Number.isFinite(cutoff.getTime())) {
    const fd = new Date(`${firstSaleDate}T00:00:00Z`).getTime();
    const span = Math.floor((cutoff.getTime() - fd) / 86400000) + 1;
    if (span > 0) coveredDays = Math.min(windowDays, span);
  }

  /**
   * 日均销量：优先用 28 天窗口，没有则退回上周 / 近 7 天。
   * 返回 0 表示卖不动或没数据，调用方按 daily<=0 → days=null 处理。
   */
  const dailyOf = (sku) => {
    const w = winQty[sku] ?? 0;
    if (w > 0) return w / coveredDays;
    const wk = lastWeekQty[sku] ?? 0;
    if (wk > 0) return wk / 7;
    return (last7Qty[sku] ?? 0) / 7;
  };

  /**
   * 状态分级：断货 > 紧急 > 偏低 > 尚可 > 充足（与看板配色一致）
   * 阈值改成看「补货提前期」而不是拍一个固定天数：
   *   days < leadTime          → 现在下单都来不及，货到之前必断（紧急）
   *   days < leadTime + buffer → 该下单了（偏低）
   *   再往上 → 尚可 / 充足
   */
  const grade = (onHand, days, leadTime) => {
    if (onHand <= 0) return { text: '断货', cls: 'tag-red', priority: 'P0' };
    if (days === null) return { text: '待核验', cls: 'tag-green', priority: '-' };
    if (days < leadTime) return { text: '紧急', cls: 'tag-red', priority: 'P0' };
    if (days < leadTime + bufferDays) return { text: '偏低', cls: 'tag-amber', priority: 'P1' };
    if (days < (leadTime + bufferDays) * 2) return { text: '尚可', cls: 'tag-green', priority: '-' };
    return { text: '充足', cls: 'tag-green', priority: '-' };
  };

  /**
   * 安全库存：CSV 里手工填了就用手工值，没填（填 0）就自动算。
   *   SS   = 日均 × buffer          纯波动缓冲
   *   目标 = 日均 × (提前期 + buffer) + SS
   *   建议 = max(0, 目标 − 现有 − 在途)
   */
  const replenish = (r, m, daily) => {
    const leadTime = num(m.lead_time_days) || defaultLeadTime;
    const manual = num(r.safety_stock);
    const ss = manual > 0 ? manual : Math.ceil(daily * bufferDays);
    const target = Math.ceil(daily * (leadTime + bufferDays)) + ss;
    return { leadTime, safetyStock: ss, safetyAuto: manual <= 0, target };
  };

  let invData = inv.map((r) => {
    const m = masterBySku[r.sku] || {};
    const onHand = num(r.on_hand);
    const inbound = num(r.inbound);
    const d7 = last7Qty[r.sku] ?? 0;
    const daily = dailyOf(r.sku);
    const days = daily > 0 ? Math.round(onHand / daily) : null;
    const rp = replenish(r, m, daily);
    const g = grade(onHand, days, rp.leadTime);
    return {
      sku: r.sku,
      type: m.category || '-',
      inv: onHand,
      recv: inbound,
      d7: round2(d7),
      d30: round2(daily * 30),
      days,
      status: g.cls,
      statusText: g.text,
      // safetyAuto=true 表示安全库存是系统按「日均×缓冲」算的，不是你手工填的
      safetyStock: rp.safetyStock,
      safetyAuto: rp.safetyAuto,
      leadTime: rp.leadTime,
      suggest: Math.max(0, rp.target - onHand - inbound),
      eta: r.eta || '',
    };
  });

  let invSuggestData = inv.map((r) => {
    const m = masterBySku[r.sku] || {};
    const onHand = num(r.on_hand);
    const inbound = num(r.inbound);
    const weekQty = lastWeekQty[r.sku] ?? null;
    const d7 = last7Qty[r.sku] ?? null;
    const daily = dailyOf(r.sku);
    const days = daily > 0 ? Math.round(onHand / daily) : null;
    const rp = replenish(r, m, daily);
    const g = grade(onHand, days, rp.leadTime);
    return {
      sku: r.sku,
      cat: m.category || '-',
      inv: onHand,
      weekQty,
      d7,
      days,
      status: g.text,
      safetyStock: rp.safetyStock,
      leadTime: rp.leadTime,
      suggest: g.priority === '-' ? 0 : Math.max(0, rp.target - onHand - inbound),
      priority: g.priority,
    };
  }).sort((a, b) => rankP(b.priority) - rankP(a.priority) || (a.days ?? 999) - (b.days ?? 999));

  // 明细表没数据时，允许整体沿用人工矫正值
  if (Array.isArray(ov['invData'])) invData = ov['invData'];
  if (Array.isArray(ov['invSuggestData'])) invSuggestData = ov['invSuggestData'];

  // --- 6. KPI ---
  const totalAuto = round2(sum(Object.values(weeklyData)));
  const kpi = {
    total: ov['kpi.total'] ?? totalAuto,
    thisWeek: ov['kpi.thisWeek'] ?? (curWeek ? weeklyData[curWeek] : 0),
    lastWeek: lastWeek ? weeklyData[lastWeek] : 0,
    netJuly: ov['kpi.netJuly'] ?? null,
    adsJuly: ov['kpi.adsJuly'] ?? null,
  };

  // 数据质量告警
  //   - USD 行缺汇率：营收按 0 计，需要配 meta.fx_usd_aud 或在行内「汇率」列填值
  //   - 非 AUD 非 USD：当前架构不支持，营收按 0 计
  const warnings = [];
  const usdMissingFx = sales.filter(
    (r) => r.currency && String(r.currency).toUpperCase() === 'USD' && !num(r.fx_rate)
  );
  if (usdMissingFx.length) {
    warnings.push(
      `有 ${usdMissingFx.length} 行是 USD 但没填汇率（也没在后台配 fx_usd_aud），` +
      `这些行的营收按 0 计。`
    );
  }
  const unsupported = sales.filter((r) => {
    const c = r.currency && String(r.currency).toUpperCase();
    return c && c !== 'AUD' && c !== 'USD';
  });
  if (unsupported.length) {
    const curs = uniq(unsupported.map((r) => String(r.currency).toUpperCase())).join(' / ');
    warnings.push(
      `有 ${unsupported.length} 行币种是 ${curs}，当前架构只支持 AUD / USD，` +
      `这些行的营收按 0 计。如有需要请告诉我，我加上对应币种的汇率配置。`
    );
  }

  // --- 7. SKU 毛利（按自然月）---
  const adsRows = (await env.DB.prepare('SELECT * FROM ads').all()).results || [];
  const marginData = buildMargin(sales, skuMaster, adsRows, meta, {
    extraSkus: inv.map((r) => r.sku),
  });

  // 毛利相关告警：成本没填 / 费率是估值，都要显形，不能拿估算值当真账
  if (marginData.missingCost > 0) {
    warnings.push(
      `产品定位矩阵：${marginData.missingCost}/${marginData.skuCount} 个 SKU 还没填采购成本，` +
      `这些 SKU 的毛利、毛利率、投流安全垫都算不出来，表格里显示「待填成本」。` +
      `把 multitable/08_SKU成本_待填.csv 的采购价填好再导入（或直接填进飞书表 D 的「采购价」列）就能算。`
    );
  }
  if (!marginData.fulfilPctConfirmed) {
    warnings.push(
      `毛利用的是估算费率：佣金+履约合计 ${marginData.fulfilPct}%（澳洲大件家居行业经验值，` +
      `不是 RoomSense 真实费率）。拿到真实费率后填进 meta.fulfil_pct 并把 fulfil_pct_confirmed 设为 1，` +
      `这条告警才会消失。`
    );
  }
  if (!marginData.adsHasData) {
    warnings.push(
      `${marginData.month} 没有广告数据（ads 表空或没落在这一月），` +
      `所以「投流后净利」暂时等于毛利、ACOS 显示「—」。广告数据导入后自动补上。`
    );
  }

  // 广告行没有周次 → buildMargin 拿周次归月份，归不上就直接跳过，
  // ACOS 和安全垫会静默偏低。必须显形。
  const adsNoWeek = adsRows.filter((r) => !String(r.week_label || '').trim());
  if (adsNoWeek.length) {
    warnings.push(
      `有 ${adsNoWeek.length} 行广告数据没有周次，这些行不参与毛利和 ACOS 计算。` +
      `在广告表填「周次」（如 W35），或填一个「日期」列（该周任意一天即可），系统会自动算周次。`
    );
  }

  // 销售明细手填周次与订单日期推算值打架：以手填为准，但要让你知道
  const weekConflicts = sales.filter((r) => {
    if (!r.order_date || !r.week_label) return false;
    const d = weekOf(String(r.order_date).slice(0, 10), epochDate, epochWeek);
    return d && d !== String(r.week_label);
  });
  if (weekConflicts.length) {
    warnings.push(
      `有 ${weekConflicts.length} 行销售明细手填的「周次」和订单日期推算出来的对不上（以手填值为准）。` +
      `销售明细表不用填周次 —— 系统从订单日期自动算，把那列删掉最省心。`
    );
  }

  return {
    weeklyData,
    skuWeeklyData,
    catData,
    platData,
    invData,
    invSuggestData,
    marginData,
    kpi,
    warnings,
    meta: {
      period: meta.period || '',
      updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      curWeek,
      lastWeek,
      weeks: finalWeeks,
      fxAudCny: Number(meta.fx_aud_cny || 0),
      fxRates: Object.fromEntries(
        Object.entries(meta).filter(([k]) => k.startsWith('fx_'))
      ),
      source: 'd1',
    },
  };
}

/* ============================================================
 * 写入 / 导入
 * ========================================================== */
async function insertSales(env, rows, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
  if (!rows.length) return 0;
  const meta = await getMeta(env);
  const epochDate = meta.week_epoch_date || WEEK_EPOCH_DATE;
  const epochWeek = Number(meta.week_epoch_label || WEEK_EPOCH_LABEL);
  const tz = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : DEFAULT_TZ_OFFSET_MIN;

  const stmt = env.DB.prepare(
    `INSERT INTO sales_orders(order_date, week_label, platform, order_no, sku, category,
                              qty, goods, shipping, currency, fx_rate, revenue, source)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const batch = rows.map((r) => {
    // 兼容中英文列名：Yitta 的结算单是英文（Order Date / Channel / Qty / Sales Currency / Order Rate to AUD）
    const date = normDate(r.order_date || r.date || r['订单日期'] || r['Order Date'] || '', tz);
    // 周次默认从订单日期自动算 —— 所以「周次」不是必填列。
    // 表里填了就以填的为准（临时覆盖用），填错会污染周趋势，
    // 所以写库后由 buildDashboard 拿日期反算一遍，对不上就告警。
    const manualWeek = String(r.week_label || r['周次'] || r.week || r['Week Label'] || '').trim();
    const derivedWeek = date ? weekOf(date, epochDate, epochWeek) : '';
    const week = manualWeek || derivedWeek;
    const amt = resolveAmounts(r, meta, week);
    return stmt.bind(
      date,
      week,
      r.platform || r['平台'] || r['Channel'] || '',
      r.order_no || r['订单号'] || r['Transaction ID'] || '',
      r.sku || r['SKU'] || '',
      r.category || r['品类'] || '',
      num(r.qty ?? r['销量'] ?? r['Qty'] ?? 0),
      amt.goods,
      amt.shipping,
      amt.currency,
      amt.fx,
      amt.revenueAud,
      r.source || 'api'
    );
  });
  await env.DB.batch(batch);
  return batch.length;
}

/**
 * 金额解析：把一行明细折算成 AUD 营收
 *
 * 口径（2026-09-03 与 Yitta 确认 —— 简化版）：
 *   营收(AUD) = (商品销售额 + 邮费收入) × 汇率
 *
 * Yitta 实际只需要支持两种币种：
 *   - AUD：直接入账，fx=1
 *   - USD：用汇率折算成 AUD
 * 其他币种（如 EUR/GBP）当前不支持，营收记 0 并告警
 *
 * 汇率优先级（美元）：
 *   1. 行内「汇率」列（Yitta 的结算单里每行都带 Order Rate to AUD，最准）
 *   2. 后台 meta.fx_usd_aud（兜底，万一某行漏填）
 *
 * 支持三种填法：
 *   1. 填了「商品销售额」和/或「邮费收入」→ 按构成相加再折算
 *   2. 只填「销售额」+ 币种非 AUD            → 整笔按汇率折算
 *   3. 只填「销售额」+ 币种是 AUD 或留空     → fx=1（兼容历史数据）
 *
 * 同时认英文列名（Yitta 结算单格式）：Yitta 直接把结算单原样粘进多维表就行
 *   Channel / Transaction ID / SKU / Qty / Sales Currency
 *   Unit Price ex.GST（**自动 × Qty**）/ Postage ex.GST（**自动 × Qty**）
 *   Order Rate to AUD / Order Date / Order Amount inc.GST
 */
// 导出是为了 tools/test_fx.mjs 能直接单测；Worker 只认 default 导出，多导出无害
export function resolveAmounts(r, meta, weekOverride) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = r[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return undefined;
  };

  const cur = String(pick('currency', '币种', 'Sales Currency') || 'AUD').trim().toUpperCase();

  // 三种"总价"来源（直接给到 AUD / 原币种的总价，无需 × Qty）
  const goodsRaw = pick('goods', '商品销售额', '平台销售额');
  const shipRaw = pick('shipping', '邮费收入', '运费收入', '邮费', '运费');
  const revenueRaw = pick('revenue', '销售额', '营收');
  const fxRaw = pick('fx_rate', '汇率', 'Order Rate to AUD');

  // 两种"单价"来源（Yitta 结算单格式，需 × Qty 才是不含税总价）
  //   Unit Price ex.GST → 商品单价
  //   Postage ex.GST    → 邮费单价
  const unitPriceRaw = pick('Unit Price ex.GST', 'Unit Price', '单价');
  const unitPostRaw = pick('Postage ex.GST', 'Postage', '邮费单价');
  const qty = num(pick('qty', '销量', 'Qty') ?? 1);

  const week = weekOverride || r.week_label || r.week || r['周次'];

  // 汇率口径（简化版）：
  //   AUD → 恒为 1，不管行内填了什么（澳元永不折算）
  //   USD → 行内「汇率」列（结算单带的 Order Rate to AUD）；缺则用 meta.fx_usd_aud 兜底；都没则营收记 0
  //   其他币种 → 暂不支持，营收记 0（避免被误套美元汇率）
  let fx;
  if (cur === 'AUD') {
    fx = 1;
  } else if (cur === 'USD') {
    fx = num(fxRaw ?? 0) || Number(meta.fx_usd_aud || 0) || 0;
  } else {
    fx = 0;
  }

  // 计算：单价列自动 × Qty；总价列直接用；都没填则按整笔销售额（AUD 时 fx=1）
  let goods;
  let shipping;

  if (unitPriceRaw !== undefined || unitPostRaw !== undefined) {
    // Yitta 结算单格式：单价 × 数量
    goods = unitPriceRaw !== undefined ? num(unitPriceRaw) * qty : 0;
    shipping = unitPostRaw !== undefined ? num(unitPostRaw) * qty : 0;
  } else if (goodsRaw !== undefined || shipRaw !== undefined) {
    // 中文模板：填的就是总价
    goods = num(goodsRaw ?? 0);
    shipping = num(shipRaw ?? 0);
  } else {
    // 旧格式：只填销售额
    goods = num(revenueRaw ?? 0);
    shipping = 0;
  }

  return { goods, shipping, currency: cur || 'AUD', fx, revenueAud: (goods + shipping) * fx };
}

async function importCsv(env, body) {
  const type = body.type || 'sales';
  const text = body.csv || '';
  const hasHeader = body.hasHeader !== false;
  const rows = parseCsv(text);
  if (!rows.length) return { ok: false, error: 'CSV 为空' };
  const header = hasHeader ? rows.shift().map((h) => h.trim()) : null;
  const records = rows
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const o = {};
      r.forEach((c, i) => {
        const key = header ? header[i] : String(i);
        o[key] = String(c).trim();
      });
      return o;
    });

  if (type === 'sales') {
    if (body.mode === 'replace_week' && body.week) {
      await env.DB.prepare('DELETE FROM sales_orders WHERE week_label=?').bind(body.week).run();
    } else if (body.mode === 'replace_all') {
      await env.DB.prepare('DELETE FROM sales_orders').run();
    }
    const n = await insertSales(env, records);
    return { ok: true, inserted: n };
  }

  if (type === 'inventory') return await upsertInventory(env, records);

  if (type === 'sku') return await upsertSkuMaster(env, records);

  if (type === 'ads') {
    if (body.mode === 'replace_week' && body.week) {
      await env.DB.prepare('DELETE FROM ads WHERE week_label=?').bind(body.week).run();
    } else if (body.mode === 'replace_all') {
      await env.DB.prepare('DELETE FROM ads').run();
    }
    return await insertAds(env, records);
  }

  return { ok: false, error: '未知 type: ' + type };
}

/* ============================================================
 * 各类表的写入（CSV 导入与多维表同步共用同一套，保证口径一致）
 * ========================================================== */
async function upsertInventory(env, records, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
  const tz = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : DEFAULT_TZ_OFFSET_MIN;
  // 快照日期：CSV 里可填「快照日期 / snapshot_date」列补录历史；没填就用今天。
  const snapDate =
    normDate(records[0]?.snapshot_date || records[0]?.['快照日期'] || '', tz) ||
    new Date().toISOString().slice(0, 10);

  const rows = records
    .filter((r) => r.sku || r['SKU'])
    .map((r) => ({
      sku: r.sku || r['SKU'],
      onHand: num(r.on_hand ?? r['现有库存'] ?? 0),
      inbound: num(r.inbound ?? r['在途'] ?? 0),
      safety: num(r.safety_stock ?? r['安全库存'] ?? 0),
      eta: normDate(r.eta || r['预计到货'] || '', tz),
    }));
  if (!rows.length) return { ok: true, upserted: 0 };

  // 1) 当前状态：覆盖更新，一行一个 SKU
  const stmt = env.DB.prepare(
    `INSERT INTO inventory(sku, on_hand, inbound, safety_stock, eta, updated_at)
     VALUES(?,?,?,?,?, datetime('now'))
     ON CONFLICT(sku) DO UPDATE SET on_hand=excluded.on_hand, inbound=excluded.inbound,
       safety_stock=excluded.safety_stock, eta=excluded.eta, updated_at=datetime('now')`
  );
  await env.DB.batch(
    rows.map((r) => stmt.bind(r.sku, r.onHand, r.inbound, r.safety, r.eta))
  );

  // 2) 历史快照：同一天重复导入会覆盖（唯一索引），不会攒重复行。
  //    老库没建这张表时静默跳过 —— 快照是增强，不该让导入失败。
  try {
    const snap = env.DB.prepare(
      `INSERT INTO inventory_snapshot(snapshot_date, sku, on_hand, inbound, safety_stock, eta)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(sku, snapshot_date) DO UPDATE SET on_hand=excluded.on_hand,
         inbound=excluded.inbound, safety_stock=excluded.safety_stock, eta=excluded.eta`
    );
    await env.DB.batch(
      rows.map((r) => snap.bind(snapDate, r.sku, r.onHand, r.inbound, r.safety, r.eta))
    );
  } catch (e) {
    return { ok: true, upserted: rows.length, snapshotDate: null, snapshotError: String(e.message || e) };
  }

  return { ok: true, upserted: rows.length, snapshotDate: snapDate };
}

async function upsertSkuMaster(env, records) {
  // price_aud / fulfil_pct / lead_time_days 是后加的列，老库可能没有。
  // 逐列探测，缺哪列就退化成不含该列的 SQL —— 保证老库导入不炸。
  const cols = await tableColumns(env, 'sku_master');
  const has = (c) => !cols.length || cols.includes(c);

  const base = ['sku', 'name', 'category', 'spec', 'cost', 'cost_currency', 'safety_days'];
  const extra = [];
  if (has('price_aud')) extra.push('price_aud');
  if (has('fulfil_pct')) extra.push('fulfil_pct');
  if (has('fulfil_per_unit')) extra.push('fulfil_per_unit');
  if (has('lead_time_days')) extra.push('lead_time_days');
  const all = base.concat(extra);

  const sql =
    `INSERT INTO sku_master(${all.join(',')}) VALUES(${all.map(() => '?').join(',')})\n` +
    '     ON CONFLICT(sku) DO UPDATE SET ' +
    all
      .filter((c) => c !== 'sku')
      .map((c) => `${c}=excluded.${c}`)
      .join(', ');

  const stmt = env.DB.prepare(sql);
  const batch = records
    .filter((r) => r.sku || r['SKU'])
    .map((r) => {
      const vals = [
        r.sku || r['SKU'],
        r.name || r['品名'] || '',
        r.category || r['品类'] || '',
        r.spec || r['规格'] || '',
        num(r.cost ?? r['采购价'] ?? 0),
        r.cost_currency || r['币种'] || 'RMB',
        // 安全库存天数：CSV 没填就保持默认（21），不写死覆盖
        r.safety_days ?? r['安全库存天数'] ?? 21,
      ];
      if (has('price_aud')) vals.push(num(r.price_aud ?? r['售价AUD'] ?? 0));
      if (has('fulfil_pct')) vals.push(num(r.fulfil_pct ?? r['履约费率'] ?? 0));
      if (has('fulfil_per_unit')) vals.push(num(r.fulfil_per_unit ?? r['单件履约费'] ?? 0));
      if (has('lead_time_days')) vals.push(num(r.lead_time_days ?? r['补货提前期'] ?? 0));
      return stmt.bind(...vals);
    });
  if (!batch.length) return { ok: true, upserted: 0 };
  await env.DB.batch(batch);
  return { ok: true, upserted: batch.length, columns: all.length };
}

async function insertAds(env, records, metaIn) {
  // 周次可以从日期推：一行广告 = 一个 campaign 一周的汇总，
  // 填该周任意一天都行 —— weekOf 会把同一周 7 天里的任何一天归到同一个 W 号。
  const meta = metaIn || (await getMeta(env));
  const epochDate = meta.week_epoch_date || WEEK_EPOCH_DATE;
  const epochWeek = Number(meta.week_epoch_label || WEEK_EPOCH_LABEL);
  const epochTz = Number(meta.feishu_tz_offset_min ?? DEFAULT_TZ_OFFSET_MIN);

  const stmt = env.DB.prepare(
    'INSERT INTO ads(week_label, platform, campaign, spend, ad_sales, orders) VALUES(?,?,?,?,?,?)'
  );
  let autoWeek = 0;
  let conflict = 0;
  const batch = records.map((r) => {
    const manual = String(r.week_label || r['周次'] || r['Week Label'] || '').trim();
    const date = normDate(r.week_start_date || r['日期'] || r.date || r['Date'] || '', epochTz);
    let week = manual;
    if (!week && date) {
      week = weekOf(date, epochDate, epochWeek);
      if (week) autoWeek += 1;
    } else if (week && date) {
      // 两边都填了：以手填为准，但对不上要显形（跟销售明细一个道理）
      const d = weekOf(date, epochDate, epochWeek);
      if (d && d !== week) conflict += 1;
    }
    return stmt.bind(
      week,
      r.platform || r['平台'] || r['Channel'] || '',
      r.campaign || r['广告活动'] || r['Campaign'] || '',
      num(r.spend ?? r['花费'] ?? r['Spend'] ?? 0),
      num(r.ad_sales ?? r['广告销售额'] ?? r['Ad Sales'] ?? 0),
      num(r.orders ?? r['订单数'] ?? r['Orders'] ?? 0)
    );
  });
  if (!batch.length) return { ok: true, inserted: 0, autoWeek: 0, conflict: 0 };
  await env.DB.batch(batch);
  return { ok: true, inserted: batch.length, autoWeek, conflict };
}

/* ============================================================
 * 多维表同步（飞书 Bitable）
 *
 * 必需 Secrets：
 *   FEISHU_APP_ID       飞书自建应用的 App ID
 *   FEISHU_APP_SECRET   飞书自建应用的 App Secret
 *   FEISHU_TABLE_TOKEN  多维表 App token（多维表 URL 里 /base/ 后面那一段）
 *   FEISHU_TABLE_ID     销售明细表的 table_id（URL 里 ?table= 后面那一段，形如 tblXXXX）
 *
 * 可选 Secrets（配了就同步，不配就跳过，互不影响）：
 *   FEISHU_TABLE_ID_INV 库存表
 *   FEISHU_TABLE_ID_ADS 广告投放表
 *   FEISHU_TABLE_ID_SKU SKU 主数据表
 *
 * 列名（中英文都认，中文优先）：
 *   销售明细：订单日期/平台/订单号/SKU/品类/销量/商品销售额/邮费收入/币种/汇率
 *             （旧格式只填「销售额」也兼容，见 resolveAmounts）
 *             周次【不用填】，从订单日期自动算；填了就以填的为准（覆盖通道）
 *   库存：    快照日期/SKU/品类/现有库存/在途/安全库存/预计到货
 *             快照日期只取【第一行】给整批用，一次导入别混日期
 *   广告：    日期/周次/平台/广告活动/花费/广告销售额/订单数
 *             日期和周次二选一；只有日期时自动算周次（该周任意一天都行）
 *             两个都空 → 该行不参与毛利/ACOS，看板会告警
 *   SKU主数据：SKU/品名/品类/规格/采购价/币种/售价AUD/履约费率/补货提前期/安全库存天数
 *
 * 同步策略：
 *   销售明细  删 source='feishu' 再全量写入（CSV 导入的历史不受影响）
 *   库存/SKU  按 SKU 覆盖更新（多维表没有的 SKU 不会被删）
 *   广告      全量替换（多维表删行 = 数据库删行）
 *   库存快照  每次同步追加一条当天记录，同日重复只覆盖
 * ========================================================== */
async function syncFromFeishu(env) {
  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_TABLE_TOKEN, FEISHU_TABLE_ID } = env;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_TABLE_TOKEN || !FEISHU_TABLE_ID) {
    throw new Error('未配置飞书 Secrets（至少需要 APP_ID / APP_SECRET / TABLE_TOKEN / TABLE_ID）');
  }

  const token = await getFeishuToken(env);
  // 飞书日期字段是毫秒时间戳，截断成日期时必须按多维表所在时区偏移，
  // 否则东八区的 00:00 会被 UTC 截断成前一天（周六 → 周五 → 归错周）。详见 normDate 注释。
  const meta = await getMeta(env);
  const tz = Number(meta.feishu_tz_offset_min ?? DEFAULT_TZ_OFFSET_MIN);

  // 1) 销售明细：全量替换 source='feishu' 的部分（CSV 导入的数据不会被误删）
  const sales = await fetchAllFeishuRecords(env, token, FEISHU_TABLE_ID);
  let salesCount = 0;
  if (sales.length) {
    await env.DB.prepare('DELETE FROM sales_orders WHERE source=?').bind('feishu').run();
    salesCount = await insertSales(env, sales.map((f) => ({ ...f, source: 'feishu' })), tz);
  }

  // 2) 库存：按 SKU 覆盖更新 + 追加当天快照（同日重复同步只覆盖）
  let invCount = 0;
  if (env.FEISHU_TABLE_ID_INV) {
    const rows = await fetchAllFeishuRecords(env, token, env.FEISHU_TABLE_ID_INV);
    if (rows.length) invCount = (await upsertInventory(env, rows, tz)).upserted || 0;
  }

  // 3) 广告投放：全量替换（多维表是唯一来源时最省心）
  let adsCount = 0;
  if (env.FEISHU_TABLE_ID_ADS) {
    const rows = await fetchAllFeishuRecords(env, token, env.FEISHU_TABLE_ID_ADS);
    if (rows.length) {
      await env.DB.prepare('DELETE FROM ads').run();
      adsCount = (await insertAds(env, rows)).inserted || 0;
    }
  }

  // 4) SKU 主数据：按 SKU 覆盖更新
  let skuCount = 0;
  if (env.FEISHU_TABLE_ID_SKU) {
    const rows = await fetchAllFeishuRecords(env, token, env.FEISHU_TABLE_ID_SKU);
    if (rows.length) skuCount = (await upsertSkuMaster(env, rows)).upserted || 0;
  }

  return {
    sales: salesCount,
    inventory: invCount,
    ads: adsCount,
    sku: skuCount,
    total: salesCount + invCount + adsCount + skuCount,
    at: new Date().toISOString(),
  };
}

async function getFeishuToken(env) {
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const j = await tokenRes.json();
  if (j.code !== 0) throw new Error('飞书鉴权失败: ' + j.msg);
  return j.tenant_access_token;
}

/** 分页拉完一张多维表的所有记录，并把飞书的富文本/多选/人员等复杂类型拍平 */
async function fetchAllFeishuRecords(env, token, tableId) {
  const out = [];
  let pageToken = '';
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard++ < 50) {
    const u = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_TABLE_TOKEN}/tables/${tableId}/records?page_size=500`
      + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    const j = await res.json();
    if (j.code !== 0) throw new Error(`飞书读取失败(${tableId}): ` + j.msg);
    for (const item of j.data.items || []) out.push(flattenFeishuFields(item.fields));
    hasMore = !!j.data.has_more;
    pageToken = j.data.page_token || '';
    if (!pageToken) hasMore = false;
  }
  return out;
}

/** 飞书单元格值扁平化：富文本/多选/人员都是数组或对象，统一转成字符串或数字 */
function flattenFeishuFields(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === null || v === undefined) { o[k] = ''; continue; }
    if (Array.isArray(v)) {
      o[k] = v.map((x) => (x && typeof x === 'object')
        ? (x.text ?? x.name ?? x.en_name ?? '')
        : String(x)).join(',');
    } else if (typeof v === 'object') {
      o[k] = v.text ?? v.name ?? v.value ?? JSON.stringify(v);
    } else {
      o[k] = v;
    }
  }
  return o;
}

/* ============================================================
 * 工具
 * ========================================================== */
export { buildDashboard, importCsv, insertSales };
// 下面这些是飞书同步链路的内部函数，导出是为了 tools/test_feishu_schema.mjs
// 能用真实表数据做端到端验证 —— 多维表结构一改就跑测试，不用等到线上才发现读不出来。
export { syncFromFeishu, insertAds, upsertInventory, upsertSkuMaster, flattenFeishuFields };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS, 'Cache-Control': 'no-store' },
  });
}

function num(v) {
  const n = Number(String(v ?? '').replace(/[,$\sA]/gi, ''));
  return Number.isFinite(n) ? n : 0;
}
const round0 = (n) => Math.round(n);
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const uniq = (a) => Array.from(new Set(a));

function indexBy(rows, key) {
  const m = {};
  for (const r of rows) m[r[key]] = r;
  return m;
}

/**
 * 查某张表实际有哪些列。后加的列（price_aud / fulfil_pct / lead_time_days）
 * 在老库里可能还没建，导入前探一下，缺哪列就退化成不含该列的 SQL。
 * 查不到（权限 / 不支持 PRAGMA）时返回空数组，调用方按「全都有」处理。
 */
async function tableColumns(env, table) {
  try {
    const r = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    return (r.results || []).map((x) => x.name);
  } catch (e) {
    return [];
  }
}

function rankP(p) {
  return { P0: 3, P1: 2, P2: 1 }[p] || 0;
}

/**
 * 飞书 datetime 字段经 API 返回的是【毫秒时间戳】，而飞书是按多维表所在时区
 * 把「日期」存成当地 00:00 的。若直接 toISOString() 截断，会按 UTC 取日期 ——
 * 东八区的 8/27 00:00 在 UTC 是 8/26 16:00，一转就变成 8/26，整张表日期提前一天。
 *
 * 这个偏移不是小事：一周从周六开始，周六的订单被算成周五就会归到【上一周】，
 * 周趋势、ACOS、补货窗口全跟着错位。所以必须按时区偏移回来再截断。
 *
 * 默认东八区（飞书多维表默认 Asia/Shanghai）。你的表时区不是 UTC+8 的话，
 * 在 meta 里设 feishu_tz_offset_min：单位分钟，东几区就填 60×几（如印度 UTC+5:30 填 330，
 * 西五区填 -300）。
 */
const DEFAULT_TZ_OFFSET_MIN = 480;

function tsToDate(ms, tzOffsetMin) {
  return new Date(Number(ms) + tzOffsetMin * 60000).toISOString().slice(0, 10);
}

function normDate(v, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  // 毫秒时间戳（飞书 / Notion 的日期字段会返回这种格式）
  if (/^\d{13}$/.test(s)) return tsToDate(Number(s), tzOffsetMin);
  // 秒级时间戳
  if (/^\d{10}$/.test(s)) return tsToDate(Number(s) * 1000, tzOffsetMin);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Excel 序列号（1900 日期系统）
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const ms = (Number(s) - 25569) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const m = /^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return s;
}

/** 用户口径周次：以 epochDate 为 epochWeek 的第一天，每 7 天递增 */
function weekOf(dateStr, epochDate, epochWeek) {
  const d = new Date(`${dateStr}T00:00:00Z`).getTime();
  const e = new Date(`${epochDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(d) || !Number.isFinite(e)) return '';
  const diff = Math.floor((d - e) / 86400000);
  const w = epochWeek + Math.floor(diff / 7);
  return 'W' + w;
}

function sortedWeeks(labels) {
  return uniq(labels).sort((a, b) => {
    const na = Number(String(a).replace(/\D/g, ''));
    const nb = Number(String(b).replace(/\D/g, ''));
    return na - nb;
  });
}

function maxDate(rows) {
  let m = '1970-01-01';
  for (const r of rows) if (r.order_date && r.order_date > m) m = r.order_date;
  return m;
}

function applyOverrides(target, ov, prefix) {
  for (const [key, val] of Object.entries(ov)) {
    if (key.startsWith(prefix + '.')) {
      target[key.slice(prefix.length + 1)] = val;
    }
  }
}

async function getMeta(env) {
  const r = await env.DB.prepare('SELECT key, value FROM meta').all();
  const m = {};
  for (const row of r.results || []) m[row.key] = row.value;
  return m;
}

async function getOverrides(env) {
  const r = await env.DB.prepare('SELECT key, value FROM overrides').all();
  const o = {};
  for (const row of r.results || []) {
    try { o[row.key] = JSON.parse(row.value); } catch { o[row.key] = row.value; }
  }
  return o;
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return; // 未设置则不鉴权（本地开发）
  const provided = request.headers.get('X-Admin-Token') || '';
  if (provided !== env.ADMIN_TOKEN) {
    throw new Error('401 未授权：请在请求头带上正确的 X-Admin-Token');
  }
}

/** 极简 CSV 解析（支持引号包裹与逗号转义） */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  // 剥掉 UTF-8 BOM —— 从多维表 / Excel 导出的 CSV 通常带 BOM，
  // 不剥掉第一个表头会变成「\uFEFF订单日期」，导致所有列匹配不上
  const s = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length && r.some((c) => c !== ''));
}
