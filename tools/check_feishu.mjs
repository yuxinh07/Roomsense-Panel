#!/usr/bin/env node
/**
 * 飞书多维表连通性自检
 *
 * 不用先部署到 Cloudflare，就能验证凭证和表结构对不对。
 *
 * 用法（二选一）：
 *   1) 环境变量
 *      FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx \
 *      FEISHU_TABLE_TOKEN=Bascnxxx [FEISHU_TABLE_ID=tblxxx] \
 *      node tools/check_feishu.mjs
 *
 *   2) 命令行参数
 *      node tools/check_feishu.mjs --app-id=cli_xxx --app-secret=xxx \
 *        --token=Bascnxxx [--table=tblxxx] [--debug]
 *
 * 只传 token 不传 table 时，会列出多维表里所有数据表及其 table_id，
 * 并对第一张表做字段校验。
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const env = {
  appId: args['app-id'] || process.env.FEISHU_APP_ID || '',
  appSecret: args['app-secret'] || process.env.FEISHU_APP_SECRET || '',
  token: args['token'] || process.env.FEISHU_TABLE_TOKEN || '',
  tableId: args['table'] || process.env.FEISHU_TABLE_ID || '',
  debug: !!args.debug,
};

// 期望的列名（Worker 认的中文列名）
/**
 * 期望的列名（Worker 认的中文列名）
 *
 * 必填缺了会读不出数据，可选缺了只是少个维度。
 * 2026-09-03 按 Yitta 飞书里实际建好的 4 张表校正：
 *   - 销售明细「销售额」早就拆成「商品销售额」+「邮费收入」了
 *   - 库存补「快照日期」（没有它，快照日期会恒等于同步当天）
 *   - 广告补「日期」（和「周次」二选一，两个都缺 → 这行不进 ACOS）
 *   - SKU主数据补「售价AUD / 履约费率 / 单件履约费 / 补货提前期」
 * ⚠️ 列名对了还不够，类型也得对：采购价建成「文本」类型的话 num() 一律变 0，
 *    毛利全废且不报错。类型检查靠 npm run test:feishu（用真实表数据跑同步）。
 */
const EXPECT = {
  销售明细: {
    required: ['订单日期', '平台', 'SKU', '品类', '销量', '商品销售额', '邮费收入', '币种', '汇率'],
    optional: ['订单号'],
  },
  库存: {
    required: ['SKU', '品类', '现有库存', '在途', '安全库存'],
    optional: ['快照日期', '预计到货'],
  },
  广告投放: {
    required: ['平台', '广告活动', '花费', '广告销售额', '订单数'],
    // 日期和周次至少要有一个，否则整行不参与毛利/ACOS
    optional: ['日期', '周次'],
  },
  SKU主数据: {
    required: ['SKU', '品类', '采购价', '币种'],
    optional: [
      '品名', '规格', '售价AUD', '履约费率', '单件履约费', '补货提前期', '安全库存天数',
      // 成本明细 7 项（fulfil_mode='breakdown' 时用）。列名必须与 src/worker.js 的
      // FULFIL_ITEMS 的 label 一字不差 —— 差一个字就静默读不到，值全变 0。
      '头程运费', '卸货费', '入出库处理费', '快递费', '平台佣金', '支付手续费', '退货损耗',
    ],
  },
};

/**
 * 必须是【数字】类型的列（飞书 field type = 2）
 * 这些列建成文本的话，num() 会把空串和非数字静默转成 0，看板照出图、不报错。
 */
const NUMERIC_COLS = {
  销售明细: ['销量', '商品销售额', '邮费收入', '汇率'],
  库存: ['现有库存', '在途', '安全库存'],
  广告投放: ['花费', '广告销售额', '订单数'],
  SKU主数据: [
    '采购价', '售价AUD', '履约费率', '单件履约费', '补货提前期', '安全库存天数',
    '头程运费', '卸货费', '入出库处理费', '快递费', '平台佣金', '支付手续费', '退货损耗',
  ],
};

/** 必须是【日期】类型的列（飞书 field type = 5；文本 type=1 也能解析，只是不稳） */
const DATE_COLS = {
  销售明细: ['订单日期'],
  库存: ['快照日期', '预计到货'],
  广告投放: ['日期'],
  SKU主数据: [],
};

const C = {
  ok: (s) => `\x1b[32m✔\x1b[0m ${s}`,
  no: (s) => `\x1b[31m✘\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

let failures = 0;
function fail(msg, hint) {
  failures++;
  console.log(C.no(msg));
  if (hint) console.log(C.dim('    → ' + hint));
}

async function main() {
  console.log(C.b('\n飞书多维表连通性自检'));
  console.log(C.dim('─'.repeat(60)));

  // ── 0. 检查参数
  const need = [
    ['appId', '--app-id', 'FEISHU_APP_ID'],
    ['appSecret', '--app-secret', 'FEISHU_APP_SECRET'],
    ['token', '--token', 'FEISHU_TABLE_TOKEN'],
  ];
  for (const [k, flag, varName] of need) {
    if (!env[k]) {
      fail(`缺少 ${k}`, `用 ${flag}=... 传入，或设环境变量 ${varName}`);
    }
  }
  if (failures) {
    console.log(C.dim('\n参数不全，先补齐再跑。\n'));
    process.exit(1);
  }

  // ── 1. 鉴权
  console.log('\n① 鉴权');
  let token;
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: env.appId, app_secret: env.appSecret }),
    });
    const j = await res.json();
    if (j.code !== 0) {
      fail(`鉴权失败：${j.msg} (code=${j.code})`, j.code === 10003
        ? 'App ID 或 App Secret 不对，回开放平台「凭证与基础信息」核对'
        : '确认应用已创建且已启用');
      process.exit(1);
    }
    token = j.tenant_access_token;
    console.log(C.ok(`鉴权通过（token 有效期 ${j.expire}s）`));
  } catch (e) {
    fail('网络请求失败：' + e.message, '检查网络，或确认能访问 open.feishu.cn');
    process.exit(1);
  }

  const H = { Authorization: 'Bearer ' + token };
  const BASE = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.token}`;

  async function get(path) {
    const res = await fetch(BASE + path, { headers: H });
    const j = await res.json();
    if (env.debug) console.log(C.dim('   [debug] ' + path + ' → code=' + j.code));
    return j;
  }

  // ── 2. 列出所有数据表
  console.log('\n② 多维表可访问性');
  let tables = [];
  const tj = await get('/tables?page_size=100');
  if (tj.code !== 0) {
    fail(`读不到多维表：${tj.msg} (code=${tj.code})`, tj.code === 91402
      ? '多维表没把这个应用加为协作者：多维表右上角「···」→ 添加文档应用 → 搜应用名 → 给可编辑权限'
      : tj.code === 91403
        ? 'table_token 不对。URL 里 /base/ 后面那一段'
        : '确认应用权限里勾了 bitable:app，并且发布了版本');
    process.exit(1);
  }
  tables = tj.data?.items || [];
  console.log(C.ok(`多维表可访问，共 ${tables.length} 张数据表`));

  if (!tables.length) {
    fail('这个多维表里一张数据表都没有', '先建表：销售明细 / 库存 / 广告投放 / SKU主数据');
    process.exit(1);
  }

  console.log(C.dim('\n   把下面的 table_id 填进 tools/setup_feishu.sh：'));
  for (const t of tables) {
    console.log(C.dim(`     ${(t.name || '(未命名)').padEnd(16)} ${t.table_id}`));
  }

  // ── 3. 目标表字段校验
  const target = env.tableId
    ? tables.find((t) => t.table_id === env.tableId) || { table_id: env.tableId, name: '(指定的)' }
    : tables[0];

  if (env.tableId && !tables.find((t) => t.table_id === env.tableId)) {
    console.log(C.warn(`\n   指定 table_id ${env.tableId} 不在列表里，仍尝试读取…`));
  }

  console.log(`\n③ 目标表：${target.name} (${target.table_id})`);

  const rj = await get(`/tables/${target.table_id}/records?page_size=3`);
  if (rj.code !== 0) {
    fail(`读不到记录：${rj.msg} (code=${rj.code})`, 'table_id 不对，或这张表没给应用权限');
    process.exit(1);
  }

  const items = rj.data?.items || [];
  const hasMore = rj.data?.has_more;
  console.log(C.ok(`能读到记录（本页 ${items.length} 条${hasMore ? '，后面还有' : ''}）`));

  // 字段名要走接口拿，不能靠记录的 fields key 反推 ——
  // 飞书的记录里，空值单元格【根本不出现这个 key】。第一行「安全库存」是空的，
  // 就会被误判成「表里没有这一列」。这个坑害人不浅，别走捷径。
  const fj = await get(`/tables/${target.table_id}/fields?page_size=200`);
  const fieldList = fj.code === 0 ? fj.data?.items || [] : [];
  const fieldType = {};
  for (const f of fieldList) fieldType[f.field_name || f.name] = f.type;

  if (!fieldList.length) {
    console.log(C.warn('\n   读不到字段定义，退回用第一行记录推断列名（可能误报缺列）'));
  }

  if (!fieldList.length && !items.length) {
    console.log(C.warn('表是空的 —— 字段名校验跳过'));
    console.log(C.dim('   贴上数据后再跑一次，会校验列名。'));
  } else {
    const cols = fieldList.length
      ? fieldList.map((f) => f.field_name || f.name)
      : Object.keys(items[0].fields || {});
    console.log(C.dim('\n   实际列名：' + cols.join(' | ')));

    // 猜这张表是哪一类：按「必填列命中数」打分，同分时再算可选列
    let matched = null;
    let bestScore = -1;
    for (const [kind, spec] of Object.entries(EXPECT)) {
      const req = spec.required.filter((c) => cols.includes(c)).length;
      const opt = spec.optional.filter((c) => cols.includes(c)).length;
      const score = req * 10 + opt;
      if (score > bestScore) { bestScore = score; matched = kind; }
    }

    if (!matched || bestScore < 30) {
      console.log(C.warn('   没认出这张表是哪一类（至少要匹配上 3 个必填列名）'));
    } else {
      const spec = EXPECT[matched];
      const missingReq = spec.required.filter((c) => !cols.includes(c));
      const missingOpt = spec.optional.filter((c) => !cols.includes(c));
      console.log(C.dim(`\n   判定为「${matched}」，对照期望列名：`));
      if (!missingReq.length) {
        console.log(C.ok(`   必填列名齐全（${spec.required.length}/${spec.required.length}）`));
      } else {
        fail(`   缺少【必填】列名：${missingReq.join(' / ')}`);
        console.log(C.dim('   必填：' + spec.required.join(' | ')));
        console.log(C.dim('   注意：飞书字段名必须一字不差，包括「SKU」的大小写'));
      }
      if (missingOpt.length) {
        console.log(C.warn(`   缺少【可选】列名：${missingOpt.join(' / ')}`));
        console.log(C.dim('   可选：' + spec.optional.join(' | ')));
      }
      // 「日期 / 周次」二选一这类组合约束
      if (matched === '广告投放' && !cols.includes('日期') && !cols.includes('周次')) {
        fail('   「日期」和「周次」至少要有一个 —— 两个都缺，整行广告不参与毛利和 ACOS');
      }

      // ── 类型检查：比列名更隐蔽的坑
      //    列名错了会「读不到」，一眼能发现；类型错了是「读到了但是废品」：
      //    采购价建成文本，num("") 一律返回 0，16 个 SKU 毛利全是售价，
      //    看板照常出图、不报任何错，等发现时决策已经做错了。
      const TYPE_NAME = { 1: '文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框' };
      const badNum = (NUMERIC_COLS[matched] || [])
        .filter((c) => cols.includes(c) && fieldType[c] !== 2)
        .map((c) => `${c}(${TYPE_NAME[fieldType[c]] || 'type' + fieldType[c]})`);
      if (badNum.length) {
        fail(`   这几列必须是【数字】类型，现在是：${badNum.join('、')}`);
        console.log(C.dim('   飞书里改：点列头 → 编辑字段 → 类型选「数字」。'));
        console.log(C.dim('   不改的话，这些值会被 num() 吃成 0，毛利/补货全错且不报错。'));
      } else if (fieldList.length) {
        const n = (NUMERIC_COLS[matched] || []).filter((c) => cols.includes(c)).length;
        if (n) console.log(C.ok(`   数值列类型正确（${n} 列）`));
      }

      const badDate = (DATE_COLS[matched] || [])
        .filter((c) => cols.includes(c) && fieldType[c] !== 5 && fieldType[c] !== 1)
        .map((c) => `${c}(${TYPE_NAME[fieldType[c]] || 'type' + fieldType[c]})`);
      if (badDate.length) {
        fail(`   这几列必须是【日期】类型，现在是：${badDate.join('、')}`);
        console.log(C.dim('   文本也勉强能认（会走 normDate 解析），日期类型最稳。'));
      }
    }

    // 打一行样例，让你肉眼核对类型（日期是不是时间戳等）
    console.log(C.dim('\n   第一行原始数据：'));
    console.log(C.dim('   ' + JSON.stringify(items[0].fields, null, 2).split('\n').join('\n   ')));
  }

  // ── 结论
  console.log(C.dim('\n' + '─'.repeat(60)));
  if (failures) {
    console.log(C.b(`\n有 ${failures} 处问题，按上面的提示改完再跑一次。\n`));
    process.exit(1);
  }
  console.log(C.b('\n全部通过。可以跑 bash tools/setup_feishu.sh 注入 Secrets 了。\n'));
}

main().catch((e) => {
  console.log(C.no('脚本异常：' + e.message));
  process.exit(1);
});
