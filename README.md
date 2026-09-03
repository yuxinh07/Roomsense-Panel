# RoomSense 运营看板 · 数据自动化方案

目标：**数据录到表里 → 看板自动读取**，不用再手动改 HTML。

---

## 一、为什么现在的 HTML 做不到

`dashboard.html` 是纯静态文件，数据写在 JS 常量里（`const weeklyData = {...}`）。
浏览器打开本地文件时无法访问任何在线表格，所以**必须**改造成：

```
录入端（表格 / 多维表 / CSV）
        ↓ 写入
Cloudflare D1 数据库
        ↓ Worker 聚合
GET /api/dashboard  →  JSON
        ↓ fetch
看板页面（Cloudflare 上托管）
        ↓ 渲染
Chart.js 图表 + 表格
```

本项目已经把这条链路全部搭好了。

---

## 二、目录说明

| 文件 | 作用 |
|---|---|
| `public/index.html` | 看板页面骨架（不含数据） |
| `public/app.js` | 渲染逻辑 `renderDashboard(DATA)` + 启动逻辑 |
| `public/data.fallback.js` | **离线兜底数据**（没连数据库时用，内容与现在的看板一致） |
| `public/admin.html` | **数据录入 / 人工矫正后台**（你要的"手动修改入口"） |
| `src/worker.js` | API：聚合、导入、矫正、多维表同步 |
| `schema.sql` | D1 表结构 |
| `seed.sql` | 把现有看板数据原样灌进 D1（部署后立刻可用） |
| `wrangler.toml` | Cloudflare 配置 |
| `tools/` | 本地生成与测试脚本 |

> `public/` 下的三个前端文件是用 `tools/build_frontend.py` 从现有 `dashboard.html` 自动拆出来的，
> 以后看板样式/图表改了，重新跑一次脚本即可同步（`python3 tools/build_frontend.py`）。

---

## 三、部署步骤（约 10 分钟）

### 1. 准备环境

```bash
cd roomsense-cloud
npm install            # 安装 wrangler
npx wrangler login     # 浏览器里授权 Cloudflare 账号
```

### 2. 建数据库

```bash
npm run db:create
```

把终端输出里的 `database_id` 粘贴到 `wrangler.toml` 的 `database_id = "..."` 处。

### 3. 建表 + 灌入现有数据

```bash
npm run db:init        # 执行 schema.sql
npm run db:seed        # 执行 seed.sql —— 把现有看板数据写进去
```

### 4. 设置管理令牌（写操作的口令）

```bash
npx wrangler secret put ADMIN_TOKEN
# 输入一串你自己的密码，例如 Rs@2026admin
```

> 密钥保存在 Cloudflare，**不会**出现在任何代码或网页里。前端页面永远拿不到它。

### 5. 一键部署

```bash
npm run deploy
```

部署完成后会给你一个地址，例如
`https://roomsense-dashboard.<你的子域>.workers.dev`

- `https://.../ ` → 看板
- `https://.../admin.html` → 数据录入后台

### 6. 本地预览 / 调试

```bash
npm run dev            # http://localhost:8787
```

---

## 四、以后怎么更新数据（三种方式，任选）

### 方式 A：后台粘贴 CSV（最快）

打开 `/admin.html` → 填 API 地址和 ADMIN_TOKEN → 粘贴 CSV → 导入。

平台后台导出的订单整理成这 10 列：

```csv
订单日期,平台,订单号,SKU,品类,销量,商品销售额,邮费收入,币种,汇率
2026-08-24,Bunnings,BN-1001,XFKF-MA-1772-26-Q,床垫,1,419.00,40.00,AUD,
2026-08-25,Amazon Marketplace,AM-2003,XFKF-PL-1167F-WH,枕头,2,38.00,5.00,USD,
```

**周次不用填**：系统按你的口径自动算（2026-06-07 = W23 第一天，每 7 天 +1）。
推荐用「替换本周」模式，重导不重复。

### 金额口径：多币种 + 邮费收入

```
营收(AUD) = (商品销售额 + 邮费收入) × 汇率
```

- `商品销售额` / `邮费收入` 填**原币种**金额，`币种` 写 `AUD` 或 `USD`
- `汇率` 列**可以整列留空**，留空时按优先级找后台 meta：
  行内汇率 > `fx_{币种}_aud.{W##}`（按周）> `fx_{币种}_aud`（全局）
- **AUD 永远不折算**；非 AUD 找不到汇率时营收记 **0**，并在看板顶部给出告警条，
  **不会静默按 1 折算**（宁可让你看见数字掉了，也不给你一个看起来正常其实是错的营收）

旧格式仍然兼容：只给 `销售额`、币种留空或写 AUD → 原值直接当 AUD。

配全局美元汇率：

```sql
INSERT OR REPLACE INTO meta(key, value) VALUES('fx_usd_aud', '1.50');
```

### 方式 B：接多维表（飞书）

让表格和看板彻底打通，表格里改一行，看板 30 分钟内自动跟上。
**完整步骤见 [`multitable/多维表搭建与维护指南.md`](multitable/多维表搭建与维护指南.md)**，这里只放要点。

支持同步 4 张表（1 张必需 + 3 张可选，配哪个同步哪个）：

| 数据表 | Secret | 同步策略 |
|---|---|---|
| 销售明细（必需） | `FEISHU_TABLE_ID` | 只替换 `source='feishu'` 的行，CSV 导入的历史不误删 |
| 库存（可选） | `FEISHU_TABLE_ID_INV` | 按 SKU 覆盖更新 |
| 广告投放（可选） | `FEISHU_TABLE_ID_ADS` | 全量替换 |
| SKU 主数据（可选） | `FEISHU_TABLE_ID_SKU` | 按 SKU 覆盖更新 |

```bash
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put FEISHU_TABLE_TOKEN   # 多维表 URL 里 /base/ 后面那串
npx wrangler secret put FEISHU_TABLE_ID      # 销售明细表 ?table= 后面那串
npx wrangler secret put FEISHU_TABLE_ID_INV  # 可选
npx wrangler secret put FEISHU_TABLE_ID_ADS  # 可选
npx wrangler secret put FEISHU_TABLE_ID_SKU  # 可选
```

三个必踩的坑：
1. 飞书应用必须**发布版本**，否则权限不生效
2. 多维表必须**把该应用加为协作者**
3. 列名要完全一致（中文）：
   `订单日期/平台/订单号/SKU/品类/销量/商品销售额/邮费收入/币种/汇率`

`wrangler.toml` 里已配好 cron `*/30 * * * *`，每 30 分钟自动同步；
也可以在后台点「立即同步」手动触发。

初始化用的 CSV 已经导出到 `multitable/`（`03_库存.csv`、`04_SKU主数据.csv` 可直接导入，
`06_销售明细_每周填写.csv`、`07_广告投放.csv` 是空表模板）。

> Notion / 金山多维表格同理，换掉 `src/worker.js` 里的 `syncFromFeishu` 即可（接口几乎一样）。

### 方式 C：单项人工矫正（处理"这周数据不准"）

后台 `/admin.html` → ③ 人工矫正。矫正值优先级**高于**自动聚合，适合：

- 平台后台和 ERP 口径不一致，要用你确认过的总额
- 某个 SKU 的销量被算错了，直接改

常用键名：

| 键名 | 含义 |
|---|---|
| `weekly.W35` | W35 销售额 |
| `skuWeek.XFKF-PL-1169R-WH.W35` | 某 SKU 某周销量 |
| `kpi.total` | 累计总销售额 |
| `kpi.thisWeek` | 本周销售额 |
| `kpi.netJuly` / `kpi.adsJuly` | 7 月净结算 / 广告投入 |

---

## 五、从"矫正值"平滑过渡到"全自动"

`seed.sql` 里现有数据全部以**矫正值**形式落库（因为当初只有聚合值、没有订单明细）。
等你导入了真实明细，就把对应的矫正值删掉，自动聚合立刻接管：

```bash
npx wrangler d1 execute roomsense-db --command="DELETE FROM overrides WHERE key LIKE 'weekly.%'"
npx wrangler d1 execute roomsense-db --command="DELETE FROM overrides WHERE key LIKE 'skuWeek.%'"
npx wrangler d1 execute roomsense-db --command="DELETE FROM overrides WHERE key IN ('platData','catData')"
npx wrangler d1 execute roomsense-db --command="DELETE FROM overrides WHERE key IN ('invData','invSuggestData')"
```

可以一张图一张图地切，不必一次切完。

---

## 六、关于密钥安全

- ✅ 所有密钥（ADMIN_TOKEN、飞书凭证）用 `wrangler secret put` 存，只有 Worker 进程能读
- ✅ 浏览器拿到的只是 `/api/dashboard` 返回的聚合 JSON
- ❌ 不要在任何 `.html` / `.js` 文件里写密钥 —— 那些文件是公开下载的
- 你如果要把 Cloudflare API Token 给我，请只给**部署用的 Token**（Account → Workers/Pages 编辑权限 + D1 编辑权限），不要用全局管理员 Token

---

## 七、常见问题

**Q：双击 index.html 打开还能用吗？**
能。检测不到 API 时自动用 `data.fallback.js` 里的快照渲染，页面右上角会显示「本地兜底快照」。

**Q：改了数据看板没变？**
看板每次打开都重新请求，且 API 设了 `no-store`。确认下浏览器没缓存旧页面（Cmd/Ctrl+Shift+R 强刷）。

**Q：周次算错了？**
改 `meta` 表的口径基准：
```bash
npx wrangler d1 execute roomsense-db --command="UPDATE meta SET value='2026-06-07' WHERE key='week_epoch_date'"
```

**Q：能加登录保护吗？**
可以，最简单是 Cloudflare Access（Zero Trust 里加一条 Policy，只允许你的邮箱访问），不用改代码。

---

## 八、本地自检

```bash
npm test        # 回归：建表 + 灌数据 + 聚合 + 导入，验证输出与现有看板一致
npm run test:fx # 多币种专项：USD/EUR 折算、邮费相加、按周汇率、缺汇率告警、BOM 回导
```

两个都用内存 SQLite 模拟 D1，**不需要部署、不碰线上数据**。

改了 `resolveAmounts`（金额折算）或 `schema.sql` 的金额列之后，
**必须两个都跑一遍** —— 多币种算错不会报错，只会让营收悄悄偏掉。

---

## 九、代码托管（GitHub）

### Python 脚本要不要传？

`tools/*.py` 是**一次性生成工具**：`build_frontend.py` 把 dashboard.html 拆成前端三件套、
`build_seed.py` 生成 seed.sql、`reorder_and_inject.py` 调整板块顺序。
它们**不参与部署** —— `wrangler deploy` 只上传 `public/` 和 `src/worker.js`。
删掉这 4 个 py，已经上线的看板照样跑。

但**建议整个项目一起传 GitHub**：改坏了能回退、换电脑能恢复、别人接手看得懂来龙去脉。

### 安全红线（已配好）

`.gitignore` 已排除：

| 路径 | 为什么 |
|---|---|
| `node_modules/` | 几万个小文件 |
| `.wrangler/` | 本地部署缓存 |
| `.dev.vars` / `.dev.vars.*` | **本地密钥文件** |
| `tools/.env.feishu` | **飞书真实凭证** |

`tools/setup_feishu.sh` **不含任何密钥**（改成从环境变量读），可以安全提交。
真实值放 `tools/.env.feishu`（复制 `.env.feishu.example` 而来），已在 gitignore 里。

> ⚠️ **`seed.sql` 里有真实经营数据**（各周销售额、库存、采购价）。
> 推 GitHub 请务必建 **私有仓库**。

### 首次推送

本地仓库已经初始化并提交好了，你在 GitHub 建一个**空的私有仓库**，然后：

```bash
cd roomsense-cloud
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

### 关于自动部署

**这套架构不能用 Cloudflare Pages 的 GitHub 自动部署** —— Pages 是静态站点托管，
跑不了 Worker + D1 这套。GitHub 在这里的价值是**版本管理和备份**，
上线仍然靠本地 `npx wrangler deploy`。

（真想要 push 即部署，可以配 GitHub Actions 跑 `wrangler deploy`，
需要额外加 `CLOUDFLARE_API_TOKEN` 到仓库 Secrets，有需要再说。）
