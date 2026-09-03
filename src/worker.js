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
 * 核心：聚合成看板所需的 JSON
 * ========================================================== */
async function buildDashboard(env) {
  const meta = await getMeta(env);
  const ov = await getOverrides(env);

  const epochDate = meta.week_epoch_date || '2026-06-07';
  const epochWeek = Number(meta.week_epoch_label || 23);

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
  const cutoff = new Date(`${maxDate(sales)}T00:00:00Z`);
  const d7Start = new Date(cutoff.getTime() - 6 * 86400000);
  for (const r of sales) {
    if (!r.sku) continue;
    if (r.week_label === lastWeek) lastWeekQty[r.sku] = (lastWeekQty[r.sku] || 0) + num(r.qty);
    if (r.order_date) {
      const d = new Date(`${r.order_date}T00:00:00Z`);
      if (d >= d7Start && d <= cutoff) last7Qty[r.sku] = (last7Qty[r.sku] || 0) + num(r.qty);
    }
  }

  // 状态分级：断货 > 紧急 > 偏低 > 尚可 > 充足（与看板配色一致）
  const grade = (onHand, days, safetyDays) => {
    if (onHand <= 0) return { text: '断货', cls: 'tag-red', priority: 'P0' };
    if (days === null) return { text: '待核验', cls: 'tag-green', priority: '-' };
    if (days < safetyDays * 0.5) return { text: '紧急', cls: 'tag-red', priority: 'P0' };
    if (days < safetyDays) return { text: '偏低', cls: 'tag-amber', priority: 'P1' };
    if (days < safetyDays * 2) return { text: '尚可', cls: 'tag-green', priority: '-' };
    return { text: '充足', cls: 'tag-green', priority: '-' };
  };

  let invData = inv.map((r) => {
    const m = masterBySku[r.sku] || {};
    const onHand = num(r.on_hand);
    const inbound = num(r.inbound);
    const d7 = last7Qty[r.sku] ?? 0;
    const weekQty = lastWeekQty[r.sku] ?? 0;
    const daily = (d7 || weekQty) / 7;
    const days = daily > 0 ? Math.round(onHand / daily) : null;
    const safetyDays = num(m.safety_days) || 21;
    const g = grade(onHand, days, safetyDays);
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
      suggest: Math.max(0, Math.ceil(daily * (safetyDays + 30) - onHand - inbound)),
      eta: r.eta || '',
    };
  });

  let invSuggestData = inv.map((r) => {
    const m = masterBySku[r.sku] || {};
    const onHand = num(r.on_hand);
    const inbound = num(r.inbound);
    const weekQty = lastWeekQty[r.sku] ?? null;
    const d7 = last7Qty[r.sku] ?? null;
    const daily = d7 ? d7 / 7 : weekQty ? weekQty / 7 : 0;
    const days = daily > 0 ? Math.round(onHand / daily) : null;
    const safetyDays = num(m.safety_days) || 21;
    const g = grade(onHand, days, safetyDays);
    return {
      sku: r.sku,
      cat: m.category || '-',
      inv: onHand,
      weekQty,
      d7,
      days,
      status: g.text,
      suggest: g.priority === '-' ? 0 : Math.max(0, Math.ceil(daily * (safetyDays + 30) - onHand - inbound)),
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

  return {
    weeklyData,
    skuWeeklyData,
    catData,
    platData,
    invData,
    invSuggestData,
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
async function insertSales(env, rows) {
  if (!rows.length) return 0;
  const meta = await getMeta(env);
  const epochDate = meta.week_epoch_date || '2026-06-07';
  const epochWeek = Number(meta.week_epoch_label || 23);

  const stmt = env.DB.prepare(
    `INSERT INTO sales_orders(order_date, week_label, platform, order_no, sku, category,
                              qty, goods, shipping, currency, fx_rate, revenue, source)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const batch = rows.map((r) => {
    // 兼容中英文列名：Yitta 的结算单是英文（Order Date / Channel / Qty / Sales Currency / Order Rate to AUD）
    const date = normDate(r.order_date || r.date || r['订单日期'] || r['Order Date'] || '');
    const week = r.week_label || r.week || r['Week Label'] || (date ? weekOf(date, epochDate, epochWeek) : '');
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
async function upsertInventory(env, records) {
  const stmt = env.DB.prepare(
    `INSERT INTO inventory(sku, on_hand, inbound, safety_stock, eta, updated_at)
     VALUES(?,?,?,?,?, datetime('now'))
     ON CONFLICT(sku) DO UPDATE SET on_hand=excluded.on_hand, inbound=excluded.inbound,
       safety_stock=excluded.safety_stock, eta=excluded.eta, updated_at=datetime('now')`
  );
  const batch = records
    .filter((r) => r.sku || r['SKU'])
    .map((r) =>
      stmt.bind(
        r.sku || r['SKU'],
        num(r.on_hand ?? r['现有库存'] ?? 0),
        num(r.inbound ?? r['在途'] ?? 0),
        num(r.safety_stock ?? r['安全库存'] ?? 0),
        normDate(r.eta || r['预计到货'] || '')
      )
    );
  if (!batch.length) return { ok: true, upserted: 0 };
  await env.DB.batch(batch);
  return { ok: true, upserted: batch.length };
}

async function upsertSkuMaster(env, records) {
  const stmt = env.DB.prepare(
    `INSERT INTO sku_master(sku, name, category, spec, cost, cost_currency, safety_days)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(sku) DO UPDATE SET name=excluded.name, category=excluded.category,
       spec=excluded.spec, cost=excluded.cost, cost_currency=excluded.cost_currency,
       safety_days=excluded.safety_days`
  );
  const batch = records
    .filter((r) => r.sku || r['SKU'])
    .map((r) =>
      stmt.bind(
        r.sku || r['SKU'],
        r.name || r['品名'] || '',
        r.category || r['品类'] || '',
        r.spec || r['规格'] || '',
        num(r.cost ?? r['采购价'] ?? 0),
        r.cost_currency || r['币种'] || 'RMB',
        num(r.safety_days ?? r['安全库存天数'] ?? 21)
      )
    );
  if (!batch.length) return { ok: true, upserted: 0 };
  await env.DB.batch(batch);
  return { ok: true, upserted: batch.length };
}

async function insertAds(env, records) {
  const stmt = env.DB.prepare(
    'INSERT INTO ads(week_label, platform, campaign, spend, ad_sales, orders) VALUES(?,?,?,?,?,?)'
  );
  const batch = records.map((r) =>
    stmt.bind(
      r.week_label || r['周次'] || '',
      r.platform || r['平台'] || '',
      r.campaign || r['广告活动'] || '',
      num(r.spend ?? r['花费'] ?? 0),
      num(r.ad_sales ?? r['广告销售额'] ?? 0),
      num(r.orders ?? r['订单数'] ?? 0)
    )
  );
  if (!batch.length) return { ok: true, inserted: 0 };
  await env.DB.batch(batch);
  return { ok: true, inserted: batch.length };
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
 *   销售明细：订单日期/平台/订单号/SKU/品类/销量/销售额
 *   库存：    SKU/品类/现有库存/在途/安全库存/预计到货
 *   广告：    周次/平台/广告活动/花费/广告销售额/订单数
 *   SKU主数据：SKU/品名/品类/规格/采购价/币种/安全库存天数
 * ========================================================== */
async function syncFromFeishu(env) {
  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_TABLE_TOKEN, FEISHU_TABLE_ID } = env;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_TABLE_TOKEN || !FEISHU_TABLE_ID) {
    throw new Error('未配置飞书 Secrets（至少需要 APP_ID / APP_SECRET / TABLE_TOKEN / TABLE_ID）');
  }

  const token = await getFeishuToken(env);

  // 1) 销售明细：全量替换 source='feishu' 的部分（CSV 导入的数据不会被误删）
  const sales = await fetchAllFeishuRecords(env, token, FEISHU_TABLE_ID);
  let salesCount = 0;
  if (sales.length) {
    await env.DB.prepare('DELETE FROM sales_orders WHERE source=?').bind('feishu').run();
    salesCount = await insertSales(env, sales.map((f) => ({ ...f, source: 'feishu' })));
  }

  // 2) 库存：按 SKU 覆盖更新
  let invCount = 0;
  if (env.FEISHU_TABLE_ID_INV) {
    const rows = await fetchAllFeishuRecords(env, token, env.FEISHU_TABLE_ID_INV);
    if (rows.length) invCount = (await upsertInventory(env, rows)).upserted || 0;
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

function rankP(p) {
  return { P0: 3, P1: 2, P2: 1 }[p] || 0;
}

function normDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  // 毫秒时间戳（飞书 / Notion 的日期字段会返回这种格式）
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  // 秒级时间戳
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString().slice(0, 10);
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
