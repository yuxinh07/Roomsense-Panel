-- ============================================================
-- RoomSense 运营数据库 (Cloudflare D1 / SQLite)
-- 执行: npx wrangler d1 execute roomsense-db --file=./schema.sql
-- ============================================================

-- 1. 销售明细：所有图表的最底层数据源
CREATE TABLE IF NOT EXISTS sales_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_date  TEXT NOT NULL,            -- 订单日期 YYYY-MM-DD
  week_label  TEXT NOT NULL,            -- 周次 W23 / W24 ... W52
  platform    TEXT,                     -- Bunnings / Amazon Marketplace / Kmart ...
  order_no    TEXT,                     -- 平台订单号（用于去重）
  sku         TEXT,                     -- XFKF-PL-1169R-WH
  category    TEXT,                     -- 床垫 / 枕头
  qty         INTEGER DEFAULT 0,        -- 销量
  revenue     REAL DEFAULT 0,           -- 销售额 (AUD)
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
  ('fx_aud_cny', '4.70'),
  ('week_epoch_date',  '2026-06-07'),  -- 用户口径：这一天是 W23 的第一天
  ('week_epoch_label', '23'),          -- 对应周序号
  ('sku_top_n', '10');                 -- SKU 趋势图展示前 N 个 SKU
