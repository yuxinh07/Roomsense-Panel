// RoomSense 看板渲染逻辑（由 tools/build_frontend.py 生成）
// renderDashboard(DATA) 内部使用的数据全部来自参数 DATA：
//   weeklyData / invData / skuWeeklyData / catData / platData / invSuggestData
function renderDashboard(DATA) {
  const {
    weeklyData, invData, skuWeeklyData, catData, platData, invSuggestData
  } = DATA;

// ===== Chart Global Config =====
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
Chart.defaults.color = '#6b7280';
Chart.defaults.font.size = 12;

// ===== 1. Weekly Sales Trend =====
new Chart(document.getElementById('weeklySalesChart'), {
  type: 'bar',
  data: {
    labels: Object.keys(weeklyData),
    datasets: [{
      label: '周销售额 (AUD)',
      data: Object.values(weeklyData),
      backgroundColor: (ctx) => {
        const idx = ctx.dataIndex;
        return idx === Object.keys(weeklyData).length - 1 ? '#dc2626' : '#4f46e5';
      },
      borderRadius: 6,
      barPercentage: 0.7,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => 'A$' + c.raw.toLocaleString() } }
    },
    scales: {
      y: { beginAtZero: true, ticks: { callback: (v) => 'A$' + v } },
      x: { grid: { display: false } }
    }
  }
});

// ===== 2. Channel Distribution =====
new Chart(document.getElementById('channelChart'), {
  type: 'doughnut',
  data: {
    labels: ['Bunnings', 'Dropshipzone', 'Kmart', 'Amazon Marketplace', 'Kogan', 'Temu - AU'],
    datasets: [{
      data: [1515.65, 1257.22, 515.74, 503.79, 264.53, 41.78],
      backgroundColor: ['#dc2626', '#4f46e5', '#7c3aed', '#d97706', '#2563eb', '#059669'],
      borderWidth: 2,
      borderColor: '#fff'
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
      tooltip: { callbacks: { label: (c) => c.label + ': A$' + c.raw.toLocaleString() } }
    }
  }
});

// ===== 3. SKU Top 10 =====
new Chart(document.getElementById('skuChart'), {
  type: 'bar',
  data: {
    labels: ['PL-1169R', 'PL-1167F', 'MA-1772-Q', 'PL-1168R', 'MA-1772-D', 'MA-1666-Q', 'MA-1667-D', 'MA-1772-S', 'MA-1772-KS', 'MA-1667-K'],
    datasets: [{
      label: '累计销量',
      data: [53, 29, 22, 22, 20, 14, 12, 10, 9, 7],
      backgroundColor: '#7c3aed',
      borderRadius: 4,
      barPercentage: 0.6,
    }]
  },
  options: {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { beginAtZero: true, grid: { color: '#f3f4f6' } },
      y: { grid: { display: false } }
    }
  }
});

// ===== 4. Cost Comparison =====
new Chart(document.getElementById('costChart'), {
  type: 'bar',
  data: {
    labels: ['销售佣金', '平台佣金', '入仓运费', '仓租', '出库操作', '快递费', '广告费', '退款'],
    datasets: [
      {
        label: '6月',
        data: [199, 350, 228, 577, 69, 898, 0, 39],
        backgroundColor: '#a5b4fc',
        borderRadius: 4,
      },
      {
        label: '7月',
        data: [692, 1597, 880, 1355, 258, 2430, 1054, 53],
        backgroundColor: '#4f46e5',
        borderRadius: 4,
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 12 } },
      tooltip: { callbacks: { label: (c) => c.dataset.label + ': A$' + c.raw.toLocaleString() } }
    },
    scales: {
      y: { beginAtZero: true, ticks: { callback: (v) => 'A$' + v } },
      x: { grid: { display: false } }
    }
  }
});

// ===== 5. Ad Performance =====
new Chart(document.getElementById('adChart'), {
  type: 'bubble',
  data: {
    datasets: [
      {
        label: 'Amazon (自动)',
        data: [
          { x: 2060, y: 15.69, r: 8, campaign: 'XFKF-MA-1666-34 (Auto)' },
          { x: 5280, y: 21.65, r: 8, campaign: 'XFKF-MA-1667-30 (Auto)' },
          { x: 3297, y: 13.77, r: 12, campaign: 'XFKF-MA-1772-26 (Auto)' },
          { x: 5763, y: 10.60, r: 12, campaign: 'XFKF-PL-WH (Auto-Paused)' },
        ],
        backgroundColor: 'rgba(79, 70, 229, 0.6)',
        borderColor: '#4f46e5'
      },
      {
        label: 'Amazon (手动)',
        data: [
          { x: 8757, y: 3.61, r: 18, campaign: 'XFKF-MA-1772 (Manual)' },
          { x: 9297, y: 9.60, r: 12, campaign: 'XFKF-MA-1667 (Manual)' },
          { x: 4165, y: 1.98, r: 10, campaign: 'XFKF-1666-34 (Manual-Paused)' },
        ],
        backgroundColor: 'rgba(220, 38, 38, 0.6)',
        borderColor: '#dc2626'
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 12 } },
      tooltip: {
        callbacks: {
          label: (c) => c.raw.campaign + ' | ROAS: ' + c.raw.y + ' | Spend: A$' + (c.raw.r * 5)
        }
      }
    },
    scales: {
      x: { title: { display: true, text: '曝光量' }, grid: { color: '#f3f4f6' } },
      y: { title: { display: true, text: 'ROAS' }, beginAtZero: true, grid: { color: '#f3f4f6' } }
    }
  }
});

// ===== 6. Inventory Waterfall =====
new Chart(document.getElementById('inventoryChart'), {
  type: 'bar',
  data: {
    labels: ['1666-D', '1666-Q', '1666-S', '1666-KS', '1667-D', '1667-K', '1667-KS', '1667-Q', '1772-D', '1772-KS', '1772-Q', '1772-S', 'PL-1167F', 'PL-1168R', 'PL-1169R'],
    datasets: [{
      label: '可售天数',
      data: [50, 33, null, null, null, null, null, 110, 14, 157, 314, null, null, 93, 0],
      backgroundColor: (ctx) => {
        const v = ctx.raw;
        if (v === 0 || v == null) return '#dc2626';
        if (v < 30) return '#d97706';
        if (v < 60) return '#2563eb';
        return '#059669';
      },
      borderRadius: 4,
      barPercentage: 0.7,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => '可售天数: ' + (c.raw || 0) + '天' } }
    },
    scales: {
      y: { beginAtZero: true, title: { display: true, text: '可售天数' }, ticks: { callback: (v) => v + 'd' } },
      x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 }
      }
    }
  }
});

// ===== Inventory Table =====

const invBody = document.getElementById('inventoryBody');
invData.forEach(r => {
  invBody.innerHTML += `
    <tr>
      <td><strong>${r.sku}</strong></td>
      <td>${r.type}</td>
      <td>${r.inv}</td>
      <td>${r.recv}</td>
      <td>${r.d7 || '-'}</td>
      <td>${r.d30 || '-'}</td>
      <td>${r.days != null ? r.days + '天' : '-'}</td>
      <td><span class="tag ${r.status}">${r.statusText}</span></td>
      <td>${r.suggest > 0 ? '<strong>' + r.suggest + '件</strong>' : '-'}</td>
    </tr>
  `;
});

// ===== 产品定位矩阵（库存/在途/可售天 从 invData 动态取）=====
const productMatrix = [
  {
    sku: 'XFKF-MA-1772-26-D', cat: '床垫',
    q13: '18', q4: '10', mom: '2.81 ↑', weeks: '9/13',
    acos: '7.3% / 27.7%', est: 'A$5,974',
    tag: '主力加投', tagBg: '#dbeafe', tagFg: '#1e40af',
    note: '库存告急，先补货再加投；手动广告 ACOS 27.7% 需压预算'
  },
  {
    sku: 'XFKF-MA-1666-34-Q', cat: '床垫',
    q13: '14', q4: '6', mom: '1.69 ↑', weeks: '9/13',
    acos: '6.4% / 50.5%(已停)', est: 'A$4,647',
    tag: '主力加投', tagBg: '#dbeafe', tagFg: '#1e40af',
    note: '自动广告 ACOS 6.4% 全场最优，加大投流；手动保持暂停'
  },
  {
    sku: 'XFKF-MA-1667-30-K', cat: '床垫',
    q13: '6', q4: '4', mom: '4.50 ↑↑', weeks: '4/13',
    acos: '4.6% / 10.4%', est: 'A$1,991',
    tag: '主力加投', tagBg: '#dbeafe', tagFg: '#1e40af',
    note: '动量最强（4.5x），加大投流测试；动销周偏少需先养 Listing'
  },
  {
    sku: 'XFKF-PL-1167F-WH', cat: '枕头',
    q13: '28', q4: '11', mom: '1.46 ↑', weeks: '8/13',
    acos: '9.4% (已停)', est: 'A$1,204',
    tag: '潜力培育', tagBg: '#dcfce7', tagFg: '#166534',
    note: '枕头线唯一在跑的款，补货到位后重启广告，主推加购'
  },
  {
    sku: 'XFKF-MA-1772-26-Q', cat: '床垫',
    q13: '20', q4: '5', mom: '0.75 ↓', weeks: '8/13',
    acos: '7.3% / 27.7%', est: 'A$6,638',
    tag: '减投去化', tagBg: '#fef3c7', tagFg: '#92400e',
    note: '销售额第一但动量下滑，可售 314 天严重过剩，黑五去库存'
  },
  {
    sku: 'XFKF-MA-1667-30-D', cat: '床垫',
    q13: '11', q4: '2', mom: '0.50 ↓', weeks: '8/13',
    acos: '4.6% / 10.4%', est: 'A$3,651',
    tag: '维持观察', tagBg: '#f3f4f6', tagFg: '#374151',
    note: '动量下滑但 ACOS 优秀，维持预算，黑五观察转化'
  },
  {
    sku: 'XFKF-MA-1772-26-KS', cat: '床垫',
    q13: '8', q4: '2', mom: '0.75 ↓', weeks: '6/13',
    acos: '7.3% / 27.7%', est: 'A$2,655',
    tag: '减投去化', tagBg: '#fef3c7', tagFg: '#92400e',
    note: '可售 157 天，减少手动广告预算，黑五捆绑去化'
  },
  {
    sku: 'XFKF-MA-1772-26-S', cat: '床垫',
    q13: '7', q4: '2', mom: '0.90 →', weeks: '4/13',
    acos: '7.3% / 27.7%', est: 'A$2,323',
    tag: '减投去化', tagBg: '#fef3c7', tagFg: '#92400e',
    note: '动销仅 4/13 周，暂停手动广告，仅保留自动'
  },
  {
    sku: 'XFKF-PL-1168R-WH', cat: '枕头',
    q13: '21', q4: '4', mom: '0.53 ↓', weeks: '7/13',
    acos: '9.4% (已停)', est: 'A$903',
    tag: '减投去化', tagBg: '#fef3c7', tagFg: '#92400e',
    note: '可售 93 天、动销放缓，暂不重开广告，黑五清一波'
  },
  {
    sku: 'XFKF-PL-1169R-WH', cat: '枕头',
    q13: '43', q4: '0', mom: '0.00 断货', weeks: '7/13',
    acos: '9.4% (已停)', est: 'A$1,849',
    tag: '断货重启', tagBg: '#ede9fe', tagFg: '#5b21b6',
    note: '销量冠军断货 5 周，到货后立刻重开广告冲黑五，建议补 150 件'
  },
  {
    sku: 'XFKF-MA-1666-34-S', cat: '床垫',
    q13: '&lt;6', q4: '-', mom: '—', weeks: '未进TOP10',
    acos: '6.4% / 50.5%(已停)', est: '—',
    tag: '清仓/停补', tagBg: '#fee2e2', tagFg: '#991b1b',
    note: '13周销量未进 TOP10，暂停追加补货，黑五捆绑/Outlet 出清'
  },
  {
    sku: 'XFKF-MA-1666-34-KS', cat: '床垫',
    q13: '&lt;6', q4: '-', mom: '—', weeks: '未进TOP10',
    acos: '6.4% / 50.5%(已停)', est: '—',
    tag: '清仓/停补', tagBg: '#fee2e2', tagFg: '#991b1b',
    note: '同上，先核验 Listing 是否正常上架与曝光'
  },
  {
    sku: 'XFKF-MA-1666-34-D', cat: '床垫',
    q13: '&lt;6', q4: '-', mom: '—', weeks: '未进TOP10',
    acos: '6.4% / 50.5%(已停)', est: '—',
    tag: '清仓/停补', tagBg: '#fee2e2', tagFg: '#991b1b',
    note: '同上'
  },
  {
    sku: 'XFKF-MA-1667-30-S', cat: '床垫',
    q13: '&lt;6', q4: '-', mom: '—', weeks: '未进TOP10',
    acos: '4.6% / 10.4%', est: '—',
    tag: '清仓/停补', tagBg: '#fee2e2', tagFg: '#991b1b',
    note: '同上；系列 ACOS 健康，可留一件做黑五凑单品'
  },
  {
    sku: 'XFKF-MA-1667-30-KS', cat: '床垫',
    q13: '&lt;6', q4: '-', mom: '—', weeks: '未进TOP10',
    acos: '4.6% / 10.4%', est: '—',
    tag: '清仓/停补', tagBg: '#fee2e2', tagFg: '#991b1b',
    note: '同上'
  },
  {
    sku: 'XFKF-MA-1667-30-Q', cat: '床垫',
    q13: '&lt;6', q4: '-', mom: '—', weeks: '未进TOP10',
    acos: '4.6% / 10.4%', est: '—',
    tag: '清仓/停补', tagBg: '#fee2e2', tagFg: '#991b1b',
    note: '压货最重：库存 32 + 在途 39 = 71 件，立即暂停补货并出清'
  },
];

function renderProductMatrix(invList) {
  const body = document.getElementById('productMatrixBody');
  if (!body) return;
  const bySku = {};
  (invList || []).forEach(function (r) { bySku[r.sku] = r; });
  body.innerHTML = productMatrix.map(function (p) {
    const inv = bySku[p.sku];
    const invCell  = inv ? inv.inv  : '—';
    const recvCell = inv ? inv.recv : '—';
    // days 为 null/undefined 表示销量过低测不出日均，标待核验
    const daysCell = (inv && inv.days != null) ? inv.days : '待核验';
    return ''
      + '<tr>'
      + '<td><strong>' + p.sku + '</strong></td>'
      + '<td>' + p.cat + '</td>'
      + '<td>' + p.q13 + '</td>'
      + '<td>' + p.q4 + '</td>'
      + '<td>' + p.mom + '</td>'
      + '<td>' + p.weeks + '</td>'
      + '<td>' + invCell + '</td>'
      + '<td>' + recvCell + '</td>'
      + '<td>' + daysCell + '</td>'
      + '<td style="font-size:12px">' + p.acos + '</td>'
      + '<td>' + p.est + '</td>'
      + '<td><span class="tag" style="background:' + p.tagBg + ';color:' + p.tagFg + ';font-weight:700">' + p.tag + '</span></td>'
      + '<td style="font-size:12px;color:#4b5563">' + p.note + '</td>'
      + '</tr>';
  }).join('');
}
renderProductMatrix(invData);

// ===== Cost Breakdown Table =====
const costData = [
  { item: '销售佣金 (Sales Commission)', jun: 199, jul: 692 },
  { item: '平台佣金 (Platform Commission)', jun: 350, jul: 1597 },
  { item: '入仓运费 (Inbound Shipping)', jun: 228, jul: 880 },
  { item: '仓库卸货 (Warehouse Unloading)', jun: 16, jul: 61 },
  { item: '仓库入库操作 (Inbound Processing)', jun: 20, jul: 66 },
  { item: '仓租 (Warehouse Storage)', jun: 577, jul: 1355 },
  { item: '仓库出库操作 (Outbound Processing)', jun: 69, jul: 258 },
  { item: '快递费 (Courier Postage)', jun: 898, jul: 2430 },
  { item: '广告费 (AD Fee)', jun: 0, jul: 1054 },
  { item: '退款退货 (Refund & Return)', jun: 39, jul: 53 },
];
const costBody = document.getElementById('costBody');
const totalJul = 13843;
costData.forEach(r => {
  const change = r.jun > 0 ? ((r.jul - r.jun) / r.jun * 100).toFixed(1) + '%' : '新增';
  const pct = (r.jul / totalJul * 100).toFixed(1) + '%';
  costBody.innerHTML += `
    <tr>
      <td>${r.item}</td>
      <td>A$${r.jun.toLocaleString()}</td>
      <td>A$${r.jul.toLocaleString()}</td>
      <td>${r.jul > r.jun ? '<span style="color:#dc2626">↑ ' + change + '</span>' : '<span style="color:#059669">↓ ' + change + '</span>'}</td>
      <td>${pct}</td>
    </tr>
  `;
});
costBody.innerHTML += `
  <tr style="font-weight:700; background:#f9fafb;">
    <td>合计费用</td>
    <td>A$2,395</td>
    <td>A$8,431</td>
    <td><span style="color:#dc2626">↑ 252.2%</span></td>
    <td>60.9%</td>
  </tr>
`;

// ===== 7. SKU Weekly Sales Curve =====
// Per-SKU weekly sales volume (units) - verified from 8.21.xlsx + 8.28.xlsx raw order data
const skuWeeklyLabels = ['W23','W24','W25','W26','W27','W28','W29','W30','W31','W32','W33','W34','W35'];
const skuColors = ['#dc2626','#d97706','#2563eb','#7c3aed','#059669','#4f46e5','#a5b4fc','#6b7280','#f59e0b','#94a3b8'];
new Chart(document.getElementById('skuWeeklyChart'), {
  type: 'line',
  data: {
    labels: skuWeeklyLabels,
    datasets: Object.entries(skuWeeklyData).map(([name, data], i) => ({
      label: name,
      data: data,
      borderColor: skuColors[i],
      backgroundColor: skuColors[i] + '15',
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 3,
      pointHoverRadius: 5,
      fill: false,
    }))
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11 }, usePointStyle: true } },
      tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + c.raw + '件' } }
    },
    scales: {
      y: { beginAtZero: true, title: { display: true, text: '周销量 (件)' }, grid: { color: '#f3f4f6' } },
      x: { grid: { display: false } }
    }
  }
});

// ===== 8a. Category Chart: Mattress vs Pillow =====
new Chart(document.getElementById('categoryChart'), {
  type: 'bar',
  data: {
    labels: ['订单数', '销量(件)', '销售额(AUD)'],
    datasets: [
      {
        label: '床垫类（W34）',
        data: [10, 11, 3651],
        backgroundColor: '#4f46e5',
        borderRadius: 4,
      },
      {
        label: '枕头类（W34）',
        data: [1, 2, 86],
        backgroundColor: '#d97706',
        borderRadius: 4,
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 12 } },
      tooltip: {
        callbacks: {
          label: (c) => {
            const label = c.dataset.label;
            const val = c.raw;
            if (c.dataIndex === 2) return label + ': A$' + val.toLocaleString();
            return label + ': ' + val;
          }
        }
      }
    },
    scales: {
      y: { beginAtZero: true, grid: { color: '#f3f4f6' } },
      x: { grid: { display: false } }
    }
  }
});

// ===== 8b. Category Trend: Cumulative units =====
new Chart(document.getElementById('categoryTrendChart'), {
  type: 'line',
  data: {
    labels: ['W23','W24','W25','W26','W27','W28','W29','W30','W31','W32','W33','W34'],
    datasets: [
      {
        label: '床垫累计(件)',
        data: [0, 2, 7, 12, 18, 30, 40, 49, 65, 75, 93, 104],
        borderColor: '#4f46e5',
        backgroundColor: '#4f46e515',
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 3,
        fill: true,
      },
      {
        label: '枕头累计(件)',
        data: [1, 6, 13, 19, 37, 56, 66, 71, 77, 80, 90, 92],
        borderColor: '#d97706',
        backgroundColor: '#d9770615',
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 3,
        fill: true,
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 12, usePointStyle: true } },
      tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + c.raw + '件' } }
    },
    scales: {
      y: { beginAtZero: true, title: { display: true, text: '累计销量(件)' }, grid: { color: '#f3f4f6' } },
      x: { grid: { display: false } }
    }
  }
});

// ===== 8c. Category Table =====
const catBody = document.getElementById('categoryTableBody');
catData.forEach(r => {
  const pct = (r.revenue / 3737 * 100).toFixed(1) + '%';
  const avgPrice = 'A$' + (r.revenue / r.units).toFixed(0);
  catBody.innerHTML += `
    <tr>
      <td><strong>${r.cat}</strong></td>
      <td>${r.orders}</td>
      <td>${r.units}</td>
      <td>A$${r.revenue.toLocaleString()}</td>
      <td>${pct}</td>
      <td>${avgPrice}</td>
      <td>${r.cumUnits}</td>
    </tr>
  `;
});

// ===== 8d. Platform WoW Chart =====
new Chart(document.getElementById('platformWoWChart'), {
  type: 'bar',
  data: {
    labels: ['Bunnings', 'Dropshipzone', 'Kmart', 'Amazon Marketplace', 'Kogan', 'Temu - AU', 'Big W', 'Ebay', 'Everyday Rewards', 'Myer', 'Temu - US', 'Woolworths'],
    datasets: [
      {
        label: 'W35',
        data: [1515.65, 1257.22, 515.74, 503.79, 264.53, 41.78, 0, 0, 0, 0, 0, 0],
        backgroundColor: '#dc2626',
        borderRadius: 4,
      },
      {
        label: 'W34',
        data: [0, 1138.63, 26.98, 1563.02, 0, 0, 834.03, 0, 0, 0, 120, 154.5],
        backgroundColor: '#a5b4fc',
        borderRadius: 4,
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 12 } },
      tooltip: { callbacks: { label: (c) => c.dataset.label + ': A$' + c.raw.toLocaleString() } }
    },
    scales: {
      y: { beginAtZero: true, ticks: { callback: (v) => 'A$' + v }, grid: { color: '#f3f4f6' } },
      x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } }
    }
  }
});

// ===== 8e. Platform Pie Chart =====
new Chart(document.getElementById('platformPieChart'), {
  type: 'pie',
  data: {
    labels: ['Bunnings', 'Dropshipzone', 'Kmart', 'Amazon Marketplace', 'Kogan', 'Temu - AU'],
    datasets: [{
      data: [1515.65, 1257.22, 515.74, 503.79, 264.53, 41.78],
      backgroundColor: ['#dc2626', '#4f46e5', '#7c3aed', '#d97706', '#2563eb', '#059669'],
      borderWidth: 2,
      borderColor: '#fff'
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 }, padding: 6 } },
      tooltip: { callbacks: { label: (c) => c.label + ': A$' + c.raw.toLocaleString() + ' (' + (c.raw/4098.71*100).toFixed(1) + '%)' } }
    }
  }
});

// ===== 8f. Platform WoW Table =====
const platBody = document.getElementById('platformTableBody');
platData.forEach(r => {
  const diff = r.thisWeek - r.lastWeek;
  const pct = r.lastWeek > 0 ? ((diff / r.lastWeek) * 100).toFixed(1) + '%' : '新增';
  const color = diff > 0 ? '#dc2626' : (diff < 0 ? '#059669' : '#6b7280');
  const arrow = diff > 0 ? '↑' : (diff < 0 ? '↓' : '-');
  platBody.innerHTML += `
    <tr>
      <td><strong>${r.name}</strong></td>
      <td>A$${r.thisWeek.toLocaleString()}</td>
      <td>${r.lastWeek > 0 ? 'A$' + r.lastWeek.toLocaleString() : '-'}</td>
      <td style="color:${color}">${arrow} ${r.lastWeek > 0 ? 'A$' + Math.abs(diff).toLocaleString() : '新增'}</td>
      <td style="color:${color}">${pct}</td>
      <td>${r.orders}</td>
    </tr>
  `;
});

// ===== 8g. Inventory Suggestion Table =====
const invSuggestBody = document.getElementById('invSuggestBody');
invSuggestData.forEach(r => {
  let statusClass = 'tag-green';
  let pColor = '#6b7280';
  if (r.status === '断货' || r.status === '紧急') { statusClass = 'tag-red'; pColor = '#dc2626'; }
  else if (r.status === '偏低') { statusClass = 'tag-amber'; pColor = '#d97706'; }
  if (r.priority === 'P0') pColor = '#dc2626';
  else if (r.priority === 'P1') pColor = '#d97706';
  else if (r.priority === 'P2') pColor = '#2563eb';
  invSuggestBody.innerHTML += `
    <tr>
      <td><strong>${r.sku}</strong></td>
      <td>${r.cat}</td>
      <td>${r.inv}</td>
      <td>${r.weekQty == null ? '待核验' : r.weekQty}</td>
      <td>${r.d7 == null ? '-' : r.d7}</td>
      <td>${r.days == null ? '-' : (r.days > 0 ? r.days + '天' : '0')}</td>
      <td><span class="tag ${statusClass}">${r.status}</span></td>
      <td>${r.suggest > 0 ? '<strong>' + r.suggest + '件</strong>' : '-'}</td>
      <td style="color:${pColor}; font-weight:700;">${r.priority}</td>
    </tr>
  `;
});

// ===== 9. Gantt Chart: AU/NZ Promo Planning =====
(function() {
  const gantt = document.getElementById('ganttChart');
  // Timeline: Aug 2026 → Dec 2027 (17 months)
  const months = ['8月','9月','10月','11月','12月','1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const yearLabels = ['2026','','','','','2027','','','','','','','2027','','','',''];
  const totalMonths = months.length; // 17

  // Each promo: [name, dateLabel, startMonth(starting from 0=Aug2026), phaseMonths{plan, stock, ad, event}]
  const promos = [
    {
      name: 'Black Friday / Cyber Monday',
      dateLabel: '11月第4周五',
      plan: [0, 1],      // Aug(0) → Sep(1)
      stock: [1, 2],     // Sep(1) → Oct(2)
      ad: [2, 3],        // Oct(2) → Nov(3)
      event: [3, 3],     // Nov(3)
      isCurrent: true,
    },
    {
      name: 'Boxing Day Sale',
      dateLabel: '12月26日',
      plan: [0, 1],      // Aug → Sep
      stock: [1, 2],     // Sep → Oct
      ad: [2, 3],        // Oct → Nov
      event: [4, 4],     // Dec(4)
    },
    {
      name: 'Click Frenzy',
      dateLabel: '11月中旬',
      plan: [0, 0],      // Jul(12) → Aug(13) — but we start from Aug=0, so plan was Jul, show from start
      stock: [0, 1],     // Aug(0) → Sep(1)
      ad: [2, 3],        // Oct → Nov
      event: [3, 3],     // Nov(3)
    },
    {
      name: 'Australia Day Sale',
      dateLabel: '1月26日',
      plan: [1, 2],      // Sep → Oct
      stock: [2, 3],     // Oct → Nov
      ad: [4, 5],        // Dec → Jan
      event: [5, 5],     // Jan(5)
    },
    {
      name: 'EOFY Sale (财年末)',
      dateLabel: '6月底',
      plan: [6, 7],      // Feb → Mar
      stock: [7, 8],     // Mar → Apr
      ad: [9, 10],       // May → Jun
      event: [10, 10],   // Jun(10)
    },
    {
      name: 'Amazon Prime Day',
      dateLabel: '7月中旬',
      plan: [6, 7],      // Feb → Mar (offset: 4 months before Jul)
      stock: [8, 9],     // Apr → May
      ad: [10, 11],      // Jun → Jul
      event: [11, 11],   // Jul(11)
    },
    {
      name: '圣诞促销',
      dateLabel: '12月全月',
      plan: [0, 1],      // Aug → Sep (same as Boxing Day, overlaps)
      stock: [1, 2],     // Sep → Oct
      ad: [2, 3],        // Oct → Nov
      event: [4, 4],     // Dec(4)
    },
  ];

  // Build header
  let html = '';
  // Year header row
  html += '<div class="gantt-header" style="margin-left:160px;">';
  for (let i = 0; i < totalMonths; i++) {
    html += `<div class="gantt-header-cell" style="flex:1; min-width:60px;">${yearLabels[i] || ''}</div>`;
  }
  html += '</div>';
  // Month header row
  html += '<div class="gantt-header" style="margin-left:160px;">';
  for (let i = 0; i < totalMonths; i++) {
    html += `<div class="gantt-header-cell" style="flex:1; min-width:60px;">${months[i]}</div>`;
  }
  html += '</div>';

  // Today indicator position: Aug 2026 = month 0, current date = Aug 28 → roughly end of month 0
  const todayMonth = 0; // August 2026

  // Rows
  promos.forEach(promo => {
    html += '<div class="gantt-row">';
    html += `<div class="gantt-label">${promo.name}<br><span class="promo-date">${promo.dateLabel}</span></div>`;
    html += '<div class="gantt-track">';

    // Month grid
    html += '<div class="gantt-month-grid">';
    for (let i = 0; i < totalMonths; i++) {
      html += '<div class="gantt-month-cell"></div>';
    }
    html += '</div>';

    const cellPct = 100 / totalMonths;

    // Plan phase
    if (promo.plan) {
      const start = promo.plan[0];
      const end = promo.plan[1];
      const left = start * cellPct;
      const width = (end - start + 1) * cellPct;
      html += `<div class="gantt-bar plan" style="left:${left}%; width:${width}%;">企划</div>`;
    }
    // Stock phase
    if (promo.stock) {
      const start = promo.stock[0];
      const end = promo.stock[1];
      const left = start * cellPct;
      const width = (end - start + 1) * cellPct;
      html += `<div class="gantt-bar stock" style="left:${left}%; width:${width}%;">备货</div>`;
    }
    // Ad phase
    if (promo.ad) {
      const start = promo.ad[0];
      const end = promo.ad[1];
      const left = start * cellPct;
      const width = (end - start + 1) * cellPct;
      html += `<div class="gantt-bar ad" style="left:${left}%; width:${width}%;">广告预热</div>`;
    }
    // Event phase
    if (promo.event) {
      const start = promo.event[0];
      const end = promo.event[1];
      const left = start * cellPct;
      const width = (end - start + 1) * cellPct;
      const cls = promo.isCurrent ? 'gantt-bar today' : 'gantt-bar event';
      const label = promo.isCurrent ? '★ 大促执行' : '大促';
      html += `<div class="${cls}" style="left:${left}%; width:${width}%;">${label}</div>`;
    }

    html += '</div>';
    html += '</div>';
  });

  gantt.innerHTML = html;
})();

function toggleCollapse(id) {
  const sec = document.getElementById(id);
  if (!sec) return;
  const open = sec.classList.toggle('open');
  const body = sec.querySelector('.collapsible-body');
  if (body) body.hidden = !open;
  const btn = sec.querySelector('.collapse-toggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && window.Chart) {
    requestAnimationFrame(() => {
      sec.querySelectorAll('canvas').forEach(c => {
        const inst = Chart.getChart(c);
        if (inst) inst.resize();
      });
    });
  }
}

}  // end renderDashboard


// ===== 启动：优先 API，失败回退离线兜底数据 =====
const API_ENDPOINT = window.ROOMSENSE_API || '/api/dashboard';

function applyKpi(D) {
  const kpi = D.kpi;
  if (!kpi) return;
  const set = (id, val, prefix) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) {
      el.textContent = (prefix || 'A$') + Number(val).toLocaleString('en-AU', {
        minimumFractionDigits: Number(val) % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2
      });
    }
  };
  set('kpi-total', kpi.total);
  set('kpi-week', kpi.thisWeek);
  set('kpi-net', kpi.netJuly);
  set('kpi-ads', kpi.adsJuly);
    if (D.meta) {
    const up = document.getElementById('meta-updated');
    if (up && D.meta.updatedAt) up.textContent = '更新时间：' + D.meta.updatedAt;
    const pr = document.getElementById('meta-period');
    if (pr && D.meta.period) pr.textContent = '数据周期：' + D.meta.period;
  }
  renderWarnings(D.warnings);
}

/**
 * 数据质量告警。目前主要是「非 AUD 但没配到汇率」——
 * 这类问题不报错、页面也不崩，只会让营收悄悄少一块，所以必须显形。
 */
function renderWarnings(warnings) {
  const box = document.getElementById('data-warnings');
  if (!box) return;
  const list = (warnings || []).filter(Boolean);
  if (!list.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML =
    '<b>⚠ 数据质量提醒（' + list.length + ' 条）</b><ul>' +
    list.map(function () { return '<li></li>'; }).join('') +
    '</ul>';
  // 用 textContent 逐条写入，避免告警文本被当成 HTML 解析
  box.querySelectorAll('li').forEach(function (li, i) { li.textContent = list[i]; });
}

function setStatus(text, ok) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'sync-status ' + (ok ? 'ok' : 'warn');
}

async function boot() {
  let data = null;
  try {
    const res = await fetch(API_ENDPOINT, { headers: { 'Accept': 'application/json' } });
    if (res.ok) {
      data = await res.json();
      if (data && data.weeklyData) {
        setStatus('● 数据源：在线数据库（实时）', true);
      } else {
        data = null;
      }
    }
  } catch (e) {
    data = null;
  }
  if (!data) {
    data = window.ROOMSENSE_FALLBACK;
    setStatus('● 数据源：本地兜底快照（未连接到数据库）', false);
  }
  renderDashboard(data);
  applyKpi(data);
  // 8月毛利 × 投流决策（public/margin.js，独立文件，不随本文件重新生成）
  if (window.RoomSenseMargin) window.RoomSenseMargin.render(data);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

