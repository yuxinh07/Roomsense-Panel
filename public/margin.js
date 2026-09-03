/**
 * 8月毛利 × 投流决策
 * ------------------------------------------------------------
 * 这是「产品定位矩阵」的毛利版。原来的矩阵只看 ACOS + 销量动量，
 * 问题是 ACOS 是 campaign 级的（同一个广告组里 5 个 SKU 共用一个 ACOS），
 * 而且 ACOS 低不等于赚钱 —— 毛利率 15% 的产品 ACOS 10% 只剩 5%，
 * 不如毛利率 40% 的产品 ACOS 20%（剩 20%）。
 *
 * 真正的判据是「安全垫」：
 *     安全垫 = 毛利率 − ACOS
 *   安全垫 > 0 → 投流在边际上赚钱，越大越该加投。
 *
 * 独立成一个文件，不并进 app.js —— build_frontend.py 会重新生成 app.js，
 * 并进去的改动会被冲掉。
 */
(function () {
  'use strict';

  var fmt = function (n, digits) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-AU', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits === undefined ? 0 : digits,
    });
  };
  var money = function (n) {
    if (n === null || n === undefined) return '—';
    return 'A$' + fmt(n, Number(n) % 1 === 0 ? 0 : 2);
  };
  var pct = function (n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toFixed(1) + '%';
  };

  /**
   * 决策：安全垫为主，库存状态为辅。
   * 安全垫算不出来的（缺成本 / 缺 ACOS）一律落到「待补数据」，
   * 不猜、不用估算值冒充真实账。
   */
  function decide(r) {
    if (!r.hasCost) {
      return { text: '待填成本', bg: '#f3f4f6', fg: '#6b7280', note: '采购价没填，毛利算不出来' };
    }
    if (r.qty === 0) {
      return { text: '本月无销量', bg: '#f3f4f6', fg: '#6b7280', note: '8 月没卖动，先不谈投流' };
    }
    if (r.safety === null) {
      return {
        text: '缺广告数据', bg: '#f3f4f6', fg: '#6b7280',
        note: '毛利率 ' + pct(r.marginPct) + ' 已算出，但没有 ACOS，安全垫算不出来',
      };
    }
    if (r.safety < 0) {
      return {
        text: '投流亏损·减投', bg: '#fee2e2', fg: '#991b1b',
        note: '毛利率 ' + pct(r.marginPct) + ' < ACOS ' + pct(r.acos) + '，每投一笔亏一笔',
      };
    }
    if (r.safety < 5) {
      return {
        text: '薄利·维持', bg: '#fef3c7', fg: '#92400e',
        note: '安全垫仅 ' + r.safety.toFixed(1) + ' 个百分点，加投很容易转亏',
      };
    }
    if (r.safety < 15) {
      return {
        text: '稳赚·可加投', bg: '#dcfce7', fg: '#166534',
        note: '安全垫 ' + r.safety.toFixed(1) + ' 个百分点，适度提高预算',
      };
    }
    return {
      text: '厚利·主力加投', bg: '#dbeafe', fg: '#1e40af',
      note: '安全垫 ' + r.safety.toFixed(1) + ' 个百分点，黑五优先砸预算',
    };
  }

  function render(DATA) {
    var box = document.getElementById('margin-panel');
    if (!box) return;

    var m = DATA && DATA.marginData;
    if (!m || !Array.isArray(m.rows) || !m.rows.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    var monthLabel = String(m.month || '').replace('-', ' 年 ') + ' 月';

    // 口径说明 + 待核验标记
    var caveats = [];
    if (!m.fulfilPctConfirmed) {
      caveats.push('佣金+履约费率用的是估算值 ' + m.fulfilPct + '%（澳洲大件家居经验值，不是 RoomSense 真实费率）');
    }
    if (m.fxAudCny) caveats.push('人民币成本按 1 AUD = ' + m.fxAudCny + ' RMB 折算');
    if (!m.adsHasData) caveats.push('本月没有广告数据，ACOS 与安全垫暂时算不出来');
    if (m.missingCost > 0) caveats.push(m.missingCost + '/' + m.skuCount + ' 个 SKU 还没填采购成本');

    var html = ''
      + '<div class="panel-head"><h3>' + monthLabel + '毛利 × 投流决策</h3>'
      + '<span class="panel-sub">判据：安全垫 = 毛利率 − ACOS，> 0 表示投流在边际上赚钱</span></div>';

    if (caveats.length) {
      html += '<div class="margin-caveat"><b>口径提醒</b><ul>'
        + caveats.map(function (c) { return '<li></li>'; }).join('')
        + '</ul></div>';
    }

    html += '<div class="table-wrap"><table class="margin-table"><thead><tr>'
      + ['SKU', '品类', '销量', '营收', 'ASP', '单件成本', '毛利率', '广告费', 'ACOS', '安全垫', '投流后净利', '决策', '依据']
        .map(function (h) { return '<th>' + h + '</th>'; }).join('')
      + '</tr></thead><tbody>';

    m.rows.forEach(function (r) {
      var d = decide(r);
      var safetyCell = (r.safety === null || r.safety === undefined)
        ? '—'
        : '<b style="color:' + (r.safety < 0 ? '#b91c1c' : r.safety < 5 ? '#92400e' : '#166534') + '">'
          + (r.safety > 0 ? '+' : '') + r.safety.toFixed(1) + '</b>';
      html += '<tr>'
        + '<td><strong>' + r.sku + '</strong></td>'
        + '<td>' + (r.cat || '-') + '</td>'
        + '<td>' + fmt(r.qty) + '</td>'
        + '<td>' + money(r.revenue) + '</td>'
        + '<td>' + money(r.asp) + '</td>'
        + '<td>' + (r.hasCost ? money(r.unitCostAud) : '<span class="muted">待填</span>') + '</td>'
        + '<td>' + (r.hasCost ? pct(r.marginPct) : '—') + '</td>'
        + '<td>' + (m.adsHasData ? money(r.adsSpend) : '—') + '</td>'
        + '<td>' + pct(r.acos) + '</td>'
        + '<td>' + safetyCell + '</td>'
        + '<td>' + (r.hasCost ? money(r.netProfit) : '—') + '</td>'
        + '<td><span class="tag" style="background:' + d.bg + ';color:' + d.fg + ';font-weight:700">'
          + d.text + '</span></td>'
        + '<td class="note">' + d.note + '</td>'
        + '</tr>';
    });

    html += '</tbody></table></div>';
    box.innerHTML = html;

    // textContent 写入口径提醒，避免被当成 HTML 解析
    var lis = box.querySelectorAll('.margin-caveat li');
    var all = box.querySelectorAll('.margin-caveat li');
    for (var i = 0; i < all.length; i++) all[i].textContent = caveats[i];
  }

  window.RoomSenseMargin = { render: render };
})();
