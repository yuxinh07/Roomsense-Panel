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
const EXPECT = {
  销售明细: ['订单日期', '平台', '订单号', 'SKU', '品类', '销量', '销售额'],
  库存: ['SKU', '品类', '现有库存', '在途', '安全库存', '预计到货'],
  广告投放: ['周次', '平台', '广告活动', '花费', '广告销售额', '订单数'],
  SKU主数据: ['SKU', '品名', '品类', '规格', '采购价', '币种', '安全库存天数'],
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

  if (!items.length) {
    console.log(C.warn('表是空的 —— 字段名校验跳过'));
    console.log(C.dim('   贴上数据后再跑一次，会校验列名。'));
  } else {
    // 从 fields 的 key 推断列名
    const cols = Object.keys(items[0].fields || {});
    console.log(C.dim('\n   实际列名：' + cols.join(' | ')));

    // 猜这张表是哪一类
    let matched = null;
    let bestHit = 0;
    for (const [kind, expect] of Object.entries(EXPECT)) {
      const hit = expect.filter((c) => cols.includes(c)).length;
      if (hit > bestHit) { bestHit = hit; matched = kind; }
    }

    if (!matched || bestHit < 3) {
      console.log(C.warn('   没认出这张表是哪一类（至少要匹配上 3 个列名）'));
    } else {
      const expect = EXPECT[matched];
      const missing = expect.filter((c) => !cols.includes(c));
      console.log(C.dim(`\n   判定为「${matched}」，对照期望列名：`));
      if (!missing.length) {
        console.log(C.ok(`   列名完全匹配（${expect.length}/${expect.length}）`));
      } else {
        fail(`   缺少列名：${missing.join(' / ')}`);
        console.log(C.dim('   期望：' + expect.join(' | ')));
        console.log(C.dim('   注意：飞书字段名必须一字不差，包括「SKU」的大小写'));
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
