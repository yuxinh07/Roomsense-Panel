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
  safety_days INTEGER DEFAULT 21,       -- 安全库存天数
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

-- 6. 元信息（数据周期、更新时间、汇率等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO meta(key, value) VALUES
  ('period',    '2026年6月7日 — 8月28日 (W23-W35)'),
  ('updatedAt', '2026-08-28 17:00'),
  ('fx_aud_cny', '4.70'),              -- 1 AUD = ? RMB（采购成本折算用）
  ('fx_usd_aud', '0'),                 -- 1 USD = ? AUD
                                       -- ⚠ 0 = 未配置。非 AUD 且缺汇率的行会被标为
                                       --    「汇率缺失」，营收按 0 计，不会静默按 1 折算。
                                       --    请填结算单上的实际汇率，或按周维护（见 fx_usd_aud.W##）
  ('week_epoch_date',  '2026-06-07'),  -- 用户口径：这一天是 W23 的第一天
  ('week_epoch_label', '23'),          -- 对应周序号
  ('sku_top_n', '10');                 -- SKU 趋势图展示前 N 个 SKU

-- 汇率 key 的命名规则：fx_{原币种小写}_aud，即「1 单位原币种 = ? AUD」
--   美元 → fx_usd_aud        欧元 → fx_eur_aud        英镑 → fx_gbp_aud
--   AUD 不需要配，恒为 1（也不会去查表，避免误套其它币种的汇率）
-- 出现新币种时，加一行对应 key 即可，不需要改代码。
--
-- 可选：按周维护，优先级高于全局值
--   INSERT OR IGNORE INTO meta(key, value) VALUES ('fx_usd_aud.W35', '1.53');
-- 优先级：行内「汇率」列 > fx_{币种}_aud.{W##} > fx_{币种}_aud

-- ───────────────────────────────────────────────────────
-- 升级已有库用（新库跳过，建表时已含这些列）：
--   ALTER TABLE sales_orders ADD COLUMN goods    REAL DEFAULT 0;
--   ALTER TABLE sales_orders ADD COLUMN shipping REAL DEFAULT 0;
--   ALTER TABLE sales_orders ADD COLUMN currency TEXT DEFAULT 'AUD';
--   ALTER TABLE sales_orders ADD COLUMN fx_rate  REAL DEFAULT 1;
-- ───────────────────────────────────────────────────────
