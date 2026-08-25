# 美股 QDII ETF 买点看板

单文件纯前端看板：[`etf-dashboard.html`](etf-dashboard.html)，无构建、无依赖，双击即可打开。
搭配可选的买点分级后端，对当前溢价 > 2% 的标的给出 A/B/C/D 买点等级。

## 内置标的

默认内置 `ETF_LIST.md` 中的全部 **24 只** A 股场内美股 QDII ETF：

| 分类 | 数量 | 代码 |
|---|---|---|
| 纳斯达克100 | 11 | 159941 513100 513300 159501 159632 159659 159513 513110 159696 513390 513870 |
| 标普500 | 5 | 513500 513650 159655 161125 159612 |
| 道琼斯工业 | 1 | 513400 |
| 窄基/行业主题 | 7 | 159509 161128 159502 513290 159529 513350 161127 |

要补标的，编辑 `etf-dashboard.html` 顶部的 `ETFS` 数组即可（一行一只，含 `thscode` 市场后缀）。

## 数据源

同花顺金融数据 API（`https://fuyao.aicubes.cn`），请求头 `X-api-key`，已验证支持跨域（CORS）。

| 表格字段 | 来源接口 |
|---|---|
| 价格 / 涨跌幅 / 最高 / 最低 | `GET /api/fund/market/snapshot` |
| 净值 / 规模 / 基金公司 | `GET /api/fund/profile/detail`（`fund_type=exchange`） |
| 年涨跌幅 | `GET /api/fund/performance/returns` |
| 溢价率 | 本地计算：场内价 ÷ unit_nav − 1 |

**溢价率是估算值**：该 API 不提供盘中 IOPV，QDII 净值按 T‑1/T‑2 披露且不含当日美股涨跌，仅适合同类标的横向比较，不能直接当套利依据。`跟踪指数` 一列取自 `ETF_LIST.md` 的静态标注。

## 功能

- 12 列固定列序；价格、涨跌幅、溢价率、规模、最高价、最低价、年涨跌幅可排序
- 手动「刷新」全量更新，加载中显示进度条 + 骨架屏，完成后展示行情时间与成功/失败统计
- API 密钥：设置面板内验证 → 存入 localStorage → 可显示/隐藏/清除
- 错误分级提示：密钥无效、网络失败、部分标的失败、部分字段缺失
- **买点分级（可选）**：部署配套服务后新增「分级」列，点「详情」进入双维度分位趋势图 + 分级占比 + 60 日逐日明细
- 浅色/深色主题（默认跟随系统）；移动端横向滚动 + 代码列吸附

## 买点分级原理

基于 `qdii-etf-dual-percentile-buypoint` 技能的双维度分位框架：把**底层指数分位**与**场内溢价分位**放进同一个 60 交易日窗口，两个维度是否同时落在下四分位，交叉出四档：

| 档 | 含义 |
|---|---|
| **A** | 指数低 + 溢价低 —— 两维度同时低 |
| **B** | 指数不低 + 溢价低 —— 溢价理想、指数位置一般 |
| **C** | 指数低 + 溢价不低 —— 价格新低多半是指数跌出来的，便宜被溢价吃掉了 |
| **D** | 两维度都不低 |

核心是这两个维度**往往负相关**：底层指数跌得越快，套利/申赎机制越来不及压平溢价，场内资金反而把溢价顶得更高。所以只看 ETF 场内价创新低就追入，很可能买的是被高溢价抵消掉的"假便宜"。

所有阈值都取自当前窗口的真实分布，**窗口滚动后阈值会漂移，不能当永久基准**。

该功能需要后端支撑（浏览器拿不到海外指数数据，Yahoo 不返回 CORS 头），不部署不影响看板其余功能。

### 已知限制

- **三只 LOF 无法分级**：161125 / 161127 / 161128 历史行情稳定返回 `code=3004`，只有快照和净值、建不出溢价基线，表格显示 `n/a`。
- **四只标的的底层指数用代理**（Yahoo 对这些指数无历史日线，已用净值日收益率校验相关性 > 0.98）：

  | 标的 | 原指数 | 代理 | 相关性 |
  |---|---|---|---|
  | 159502 / 161127 | `^SPSIBI` | `XBI` | 0.9987 |
  | 513350 | `^SPSIOP` | `XOP` | 0.9978 |
  | 159509 | `^NDXTMC` | `IYW` | 0.9891 |
  | 159529 | S&P 500 Consumer Select Index | `XLY` 55% + `XLP` 45% | 0.9900 |

  跑 `node server/test/validate-all.mjs` 可复核全部映射。

## 部署

### 前置

- 一台**境外** VPS（境内机房大概率访问不到 Yahoo Finance，指数维度会直接失效）
- Docker + Docker Compose
- Caddy（反向代理和证书，自动申请并续期，不需要额外套 CDN 来解决证书问题）

### 1. 拉代码、配环境变量

```bash
cd server
cp .env.example .env
```

编辑 `.env`：

```
FUYAO_API_KEY=sk-fuyao-你的密钥
ADMIN_TOKEN=用 openssl rand -hex 24 生成一串
```

### 2. 起容器

```bash
docker compose up -d --build
```

容器只绑在 `127.0.0.1:8787`，不直接暴露到公网，唯一入口是 Caddy。数据存在名为 `etf-data` 的 Docker named volume 里（不是 bind mount——bind mount 在 Linux 宿主机上常因权限问题导致 SQLite 无法写入，除非手动 `chown -R 10001:10001`）。

### 3. 接 Caddy

把 [`server/Caddyfile.example`](server/Caddyfile.example) 里的站点块并进你的 Caddyfile，域名换成自己的，然后 `caddy reload`。

如果套了 Cloudflare CDN，务必在页面规则里排除 `/api/refresh` 和 `/health`，否则响应会被缓存后发给别人。

### 4. 验证

```bash
curl -s https://你的域名/health | jq
```

看到 `"hasData": true` 且 `counts.graded` 大于 0 就成了（容器启动会自动算一次，约 20~30 秒）。手动重算：

```bash
curl -X POST -H "Authorization: Bearer 你的ADMIN_TOKEN" https://你的域名/api/refresh
```

### 5. 打开看板

直接访问 `https://你的域名/` —— 服务端把看板本体也一并托管。分级服务地址固定为同源相对路径，不提供手动配置入口——同源部署是唯一支持的形态。若把看板单独部署在别处（比如 Cloudflare Pages），「分级」列会保持为 `—`。

### 运行机制

**调度**：北京时间每个交易日 `09:30 / 10:30 / 11:30 / 13:30 / 14:30 / 15:00` 各算一次，午间休市不跑，法定节假日自动跳过。改时刻表：`docker-compose.yml` 里调 `SCHEDULE_TIMES`。

**接口**：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/` `/etf-dashboard.html` | GET | 看板本体 |
| `/api/buypoint` | GET | 全部标的分级汇总（CDN 缓存 60s） |
| `/api/buypoint/{代码}` | GET | 单只 60 日逐日明细 |
| `/health` | GET | 健康检查 |
| `/api/refresh` | POST | 手动重算，需 `Authorization: Bearer <ADMIN_TOKEN>` |

**Fuyao 接口稳定性**：实测会把限流伪装成业务错误码随机返回（`1004`/`3001`/`3004`，实测抖动率约 32.5%），已按临时性错误做指数退避重试（重试后失败率降到 0%），因此不会把健康 ETF 永久标死。极少数漏网时「分级」列显示 `···`（待补，下一轮自动重试），只有 API Key 缺失/无效/被吊销才会显示真正的错误图标 `!`。

**备份**：

```bash
docker run --rm -v etf-data:/data -v "$(pwd)":/backup alpine \
  cp /data/buypoint.db /backup/buypoint.db.bak
```

### 本地开发（不需要 Docker）

```bash
cd server
FUYAO_KEY=sk-fuyao-xxx node test/verify.mjs 159941   # 单只标的的完整管线
FUYAO_KEY=sk-fuyao-xxx node test/pipeline.mjs        # 完整管线（SQLite 用内存库）
FUYAO_KEY=sk-fuyao-xxx node test/validate-all.mjs    # 复核全部 24 只的底层指数映射
FUYAO_API_KEY=sk-fuyao-xxx ADMIN_TOKEN=dev npm run dev   # 起服务，访问 http://localhost:8787
```

## 免责声明

本项目仅做公开数据展示与"当前相对位置"分级，不预测涨跌方向，不构成任何投资建议。样本量、时间窗口、汇率与 QDII 额度等制度性因素均未纳入模型。
