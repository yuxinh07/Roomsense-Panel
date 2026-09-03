-- ============================================================
-- RoomSense 运营数据库 (Cloudflare D1 / SQLite)
-- 执行: npx wrangler d1 execute roomsense-db --file=./schema.sql
-- ============================================================

-- 1. 销售明细：所有图表的最底层数据源
--
-- 金额口径（2026-09-03 修订）：
--   营收(AUD) = (商品销售额 + 邮费收入) × 汇率
--   goods / shipping 存【原币种】金额，currency 是原币种，
--   fx_rate 是「原币种 → AUD」的汇率，revenue 是折算后的 AUD 营收（派生值）。
--   只给销售额、没给币种时按 AUD 处理，fx_rate=1 —— 与旧数据完全兼容。
CREATE TABLE IF NOT EXISTS sales_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_date  TEXT NOT NULL,            -- 订单日期 YYYY-MM-DD
  week_label  TEXT NOT NULL,            -- 周次 W23 / W24 ... W52
  platform    TEXT,                     -- Bunnings / Amazon Marketplace / Kmart ...
  order_no    TEXT,                     -- 平台订单号（用于去重）
  sku         TEXT,                     -- XFKF-PL-1169R-WH
  category    TEXT,                     -- 床垫 / 枕头
  qty         INTEGER DEFAULT 0,        -- 销量
  goods       REAL DEFAULT 0,           -- 商品销售额（原币种）
  shipping    REAL DEFAULT 0,           -- 邮费收入（原币种）
  currency    TEXT DEFAULT 'AUD',       -- 原币种：AUD / USD
  fx_rate     REAL DEFAULT 1,           -- 原币种 → AUD 的汇率
  revenue     REAL DEFAULT 0,           -- 营收 AUD = (goods + shipping) * fx_rate
  source      TEXT DEFAULT 'manual',    -- manual / csv / feishu / notion
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_week    ON sales_orders(week_label);
CREATE INDEX IF NOT EXISTS idx_sales_sku     ON sales_orders(sku);
CREATE INDEX IF NOT EXISTS idx_sales_orderno ON sales_orders(order_no);

-- 2. SKU 主数据
CREATE TABLE IF NOT EXISTS sku_master (
  sku         TEXT PRIMARY KEY,
  name        TEXT,
  category    TEXT,                     -- 床垫 / 枕头
  spec        TEXT,                     -- Queen / Double ...
  cost        REAL DEFAULT 0,           -- 采购单价 (AUD 或 RMB，见 cost_currency)
  cost_currency TEXT DEFAULT 'RMB',
  price_aud   REAL DEFAULT 0,           -- 单件售价 ex.GST (AUD)。0 = 从销售明细反推 ASP
                                        -- 没填也不慌：有销售明细时系统用 营收/销量 自动算 ASP
  fulfil_pct  REAL DEFAULT 0,           -- 【旧口径】该 SKU 的【按售价%】成本合计。0 = 用 meta.fulfil_pct
  fulfil_per_unit REAL DEFAULT 0,       -- 【旧口径】该 SKU 的【按件】履约成本合计 AUD/件。0 = 用 meta.fulfil_per_unit
                                        -- 这两个是「合计值」，明细模式（fulfil_mode='breakdown'）下不再生效，
                                        -- 改由下面 7 项加起来得到。保留是为了老数据不炸。
  lead_time_days INTEGER DEFAULT 0,     -- 补货提前期（下单→入仓）天数。0 = 用 meta.lead_time_days
                                        -- 海运中国→澳洲通常 40~50 天，空运 7~12 天，按 SKU 实际填

  -- ↓ 成本明细（Yitta 2026-09-03 要求：能一项一项填，系统自动算合计）
  --   取数优先级：本行的值 > meta 同名默认值 > 0
  --
  --   ⚠ 这 7 列刻意不写 DEFAULT 0，默认就是 NULL。
  --     NULL = 没填（回落到 meta 的全局默认值）；0 = 填了，且这项真的不花钱。
  --     写成 DEFAULT 0 的话两者没法区分，SKU 的空值会把 meta 的默认值盖成 0 ——
  --     测试 test_fulfil.mjs 第 2 节就是抓这个 bug 的：枕头没填快递费，
  --     却因为默认 0 而用不上全局的床垫费率，成本直接少算。
  --
  --   ⚠ 明细模式下，没填且 meta 也没配的项按 0 计入 —— 会让毛利被高估，
  --     所以会在 warnings 里点名列出缺哪些，绝不静默。
  ship_first_leg REAL,                  -- 【按件】头程运费 AUD/件（中国→澳洲，海运或空运摊到每件）
  ship_unload    REAL,                  -- 【按件】卸货费 AUD/件（到港卸柜、搬入仓）
  handling_inout REAL,                  -- 【按件】入出库处理费 AUD/件（拣货、打包、贴标）
  ship_last_mile REAL,                  -- 【按件】快递费 AUD/件
                                        -- ⚠ 大件（床垫）和小件（枕头）这项差最多，务必分开填
  pct_platform   REAL,                  -- 【按售价%】平台佣金（Bunnings / Amazon / Kmart / Temu / Ebay / Dropshipzone 各自不同）
  pct_payment    REAL,                  -- 【按售价%】支付手续费（PayPal / 信用卡 / Afterpay 等）
  pct_return     REAL,                  -- 【按售价%】退货损耗（退货率 × 单件损失，摊成百分比）
  safety_days INTEGER DEFAULT 21,       -- 安全库存天数（分级阈值，0 = 用 lead_time+buffer）
  active      INTEGER DEFAULT 1
);

-- 3. 库存
CREATE TABLE IF NOT EXISTS inventory (
  sku          TEXT PRIMARY KEY,
  on_hand      INTEGER DEFAULT 0,       -- 现有库存
  inbound      INTEGER DEFAULT 0,       -- 在途
  safety_stock INTEGER DEFAULT 0,       -- 安全库存
  eta          TEXT,                    -- 预计到货 YYYY-MM-DD
  updated_at   TEXT DEFAULT (datetime('now'))
);

-- 4. 广告投放
CREATE TABLE IF NOT EXISTS ads (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  week_label TEXT,
  platform  TEXT,
  campaign  TEXT,
  spend     REAL DEFAULT 0,             -- 广告花费
  ad_sales  REAL DEFAULT 0,             -- 广告带来销售额
  orders    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ads_week ON ads(week_label);

-- 5. 人工矫正值（关键）：覆盖任何自动聚合结果
--    key 规则见 README；例如 weekly.W35 / kpi.total / skuWeek.PL-1169R.W35
CREATE TABLE IF NOT EXISTS overrides (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,             -- JSON 值
  note       TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 5.5 库存快照（历史）：每次导入 03_库存.csv 时自动追加一条
--     为什么单独一张表：inventory 是「当前状态」，一行一个 SKU，前端读它最快；
--     历史留在这张表里，算周转率 / 缺货频次 / 补货及时率全靠它。
--     没这张表就只能看到「现在剩多少」，看不出「什么时候开始偏的」。
CREATE TABLE IF NOT EXISTS inventory_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,          -- 快照日期 YYYY-MM-DD
  sku           TEXT NOT NULL,
  on_hand       INTEGER DEFAULT 0,
  inbound       INTEGER DEFAULT 0,
  safety_stock  INTEGER DEFAULT 0,
  eta           TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inv_snap_sku ON inventory_snapshot(sku, snapshot_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_snap_uniq ON inventory_snapshot(sku, snapshot_date);
-- 同一天重复导入会覆盖（ON CONFLICT），不会产生重复行

-- 6. 元信息（数据周期、更新时间、汇率等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO meta(key, value) VALUES
  ('period',    '2026年6月7日 — 8月28日 (W23-W35)'),
  ('updatedAt', '2026-08-28 17:00'),
  ('fx_aud_cny', '4.70'),              -- 1 AUD = ? RMB（采购成本折算用）
  ('fx_usd_aud', '0'),                 -- 1 USD = ? AUD（兜底汇率）
                                       -- 通常不用配 —— 每行结算单的「汇率」列（Order Rate to AUD）
                                       -- 是行内汇率，更准
                                       -- 万一某行漏填了行内汇率，才会用这个兜底
                                       -- 0 = 未配置；USD 缺汇率的行营收按 0 计，不会静默按 1 折算
  ('week_epoch_date',  '2026-05-30'),  -- W23 的第一天 = 2026-05-30（周六）
                                       -- 口径来源：overrides('weekly.W35') 备注「8/22-8/28 用户确认总额」
                                       -- 反推 W23 = 8/22 - (35-23)*7 = 2026-05-30
                                       -- 一周 = 周六 00:00 ~ 周五 23:59
  ('week_epoch_label', '23'),          -- 对应周序号
  ('sku_top_n', '10'),                -- SKU 趋势图展示前 N 个 SKU
  ('feishu_tz_offset_min', '480'),    -- 飞书多维表所在时区的 UTC 偏移（分钟）。480 = UTC+8 = Asia/Shanghai
                                      -- 飞书的日期字段经 API 返回毫秒时间戳，截断成日期必须按这个偏移，
                                      -- 否则东八区的 00:00 会被 UTC 截成前一天 —— 周六的订单变成周五、归到上一周。
                                      -- 你的多维表时区不是 UTC+8 时改这里（如印度 UTC+5:30 填 330）

  -- ↓ 毛利计算参数。全部是「待核验」的估值，拿到真实数字请覆盖
  ('fulfil_pct', '30'),               -- 【按售价%】的成本：销售佣金 + 平台佣金 + 退货损耗
                                      -- 30% 是澳洲大件家居的行业经验值，不是 RoomSense 真实费率
                                      -- 前端会持续告警，直到这里被真实数字覆盖
  ('fulfil_per_unit', '0'),           -- 【按件】的履约成本 AUD/件：头程运费 + 卸货 + 入出库处理 + 快递
                                      -- 0 = 只用 fulfil_pct（旧行为）
                                      -- ⚠ 不要把广告费填进来 —— 广告费走「安全垫 = 毛利率 − ACOS」单独算，
                                      --    塞这里会被扣两次（一次算毛利、一次算 ACOS），所有产品都会显示投流亏损
  ('fulfil_pct_confirmed', '0'),      -- 1 = 已核实过这个费率（告警消失）
  ('margin_month', '2026-08'),        -- 定位矩阵看哪个月的毛利（YYYY-MM）

  -- ↓ 成本明细模式（Yitta 2026-09-03 要求：一项一项填，系统算合计）
  --   'pct'       = 用上面的 fulfil_pct / fulfil_per_unit 合计值（当前默认，老行为）
  --   'breakdown' = 用下面 7 项明细求和。填了哪些算哪些，没填的按 0 且会在告警里点名
  ('fulfil_mode', 'pct'),
  ('fulfil_breakdown_confirmed', '0'),  -- 1 = 已逐项核对过明细（缺项告警消失）
                                        -- 明细模式下为 0 的项按 0 计入，毛利被高估 ——
                                        -- 所以确认前一直告警，确认后才静音
  -- 下面 7 项是【全局默认值】，SKU 表里填了就用 SKU 的，没填就回落这里。
  -- 全留空 = 全部按 0，会告警。所以要么在 SKU 表逐项填，要么在这里填一个通用值。
  ('ship_first_leg', ''),             -- 【按件】头程运费 AUD/件
  ('ship_unload', ''),                -- 【按件】卸货费 AUD/件
  ('handling_inout', ''),             -- 【按件】入出库处理费 AUD/件
  ('ship_last_mile', ''),             -- 【按件】快递/尾程配送 AUD/件（大件小件差别最大的一项）
  ('pct_platform', ''),               -- 【按售价%】平台佣金
  ('pct_payment', ''),                -- 【按售价%】支付手续费
  ('pct_return', ''),                 -- 【按售价%】退货损耗

  -- ↓ 补货参数。同样是「待核验」的估值
  ('lead_time_days', '45'),           -- 默认补货提前期（天）。海运中国→澳洲的经验值，待 Yitta 核实
  ('buffer_days', '14'),              -- 缓冲天数，cover 销量波动
  ('demand_window_days', '28');       -- 算日均销量看最近多少天（28 天比 7 天稳，波动小）

-- 汇率口径（2026-09-03 简化版）：
--   AUD → fx=1（不折算）
--   USD → 行内「汇率」列 > meta.fx_usd_aud 兜底
--   其他币种 → 暂不支持，营收记 0 并告警（出现请告诉我加上）

-- ───────────────────────────────────────────────────────
-- 升级已有库用（新库跳过，建表时已含这些列）：
--   ALTER TABLE sales_orders ADD COLUMN goods    REAL DEFAULT 0;
--   ALTER TABLE sales_orders ADD COLUMN shipping REAL DEFAULT 0;
--   ALTER TABLE sales_orders ADD COLUMN currency TEXT DEFAULT 'AUD';
--   ALTER TABLE sales_orders ADD COLUMN fx_rate  REAL DEFAULT 1;
--   ALTER TABLE sku_master    ADD COLUMN price_aud  REAL DEFAULT 0;
--   ALTER TABLE sku_master    ADD COLUMN fulfil_pct REAL DEFAULT 0;
--   ALTER TABLE sku_master    ADD COLUMN fulfil_per_unit REAL DEFAULT 0;
-- ───────────────────────────────────────────────────────
