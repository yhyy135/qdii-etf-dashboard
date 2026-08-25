# 买点分级服务 · 部署指南（Docker + Caddy + Cloudflare）

看板本身仍是零依赖单文件，直接打开就能用。**买点分级是可选增强**：不部署这个服务，
表格里的「分级」列显示 `—`，其余功能完全不受影响。

## 为什么必须有后端（与存储选型无关）

三个理由，都不是因为要读 SQLite：

1. **Yahoo Finance 不返回 CORS 头** —— 浏览器拿不到底层指数点位，指数维度在前端根本算不出来：
   ```bash
   curl -sD- -o/dev/null "https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?range=5d&interval=1d" \
     -H "Origin: https://example.com" | grep -i access-control
   # 无输出 —— 一个 CORS 头都没有
   ```
2. **API Key 要藏在服务端**，不能让每个访客自带 Fuyao 账号。
3. **基线一天只该算一次**，不能每个访客都去重算 60 天历史。

SQLite 只是这个后端内部的存储选型。数据总量约 200KB、纯 key-value 访问，散装 JSON 文件也够；
选 SQLite 是因为用 Node 24 内置的 `node:sqlite` **零 npm 依赖**，免费换来写入原子性、
单文件挂卷备份，以及以后要存更长历史时不用换架构。

---

## 部署

### 0. 前置

- 一台**境外** VPS（美国/日本/新加坡/香港均可）。境内机房大概率访问不到 Yahoo Finance，
  指数维度会直接失效。
- Docker + Docker Compose
- Caddy（用于反向代理和证书）

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

镜像里没有 `node_modules`（全部零依赖），构建就是一次文件拷贝，几秒完成。

容器**只绑在 `127.0.0.1:8787`**，不直接暴露到公网 —— 唯一入口是 Caddy。

### 3. 接 Caddy

把 [`server/Caddyfile.example`](server/Caddyfile.example) 里的站点块并进你的 Caddyfile，
域名换成自己的，然后 `caddy reload`。该文件里还写了套 Cloudflare CDN 时证书的三种做法和取舍。

### 4. 验证

```bash
curl -s https://你的域名/health | jq
```

看到 `"hasData": true` 且 `counts.graded` 大于 0 就成了。容器启动时会自动算一次，
约 20~30 秒完成（含重试）。

要手动重算：

```bash
curl -X POST -H "Authorization: Bearer 你的ADMIN_TOKEN" https://你的域名/api/refresh
```

### 5. 打开看板

直接访问 `https://你的域名/` —— 服务端把看板本体也一并托管了。

**同源部署不需要在设置里填任何地址**，「分级」列自动生效，也不存在 CORS 和混合内容问题。
只有把看板单独放在别处（比如 Cloudflare Pages）时，才需要在「⚙️ API设置」里填后端地址。

---

## 关于你的 CDN 方案，有一点要先说清楚

> "套用 Cloudflare 的 CDN 直接访问，也就不用经常维护 SSL 证书了"

**Caddy 本来就会自动申请并自动续期证书** —— 这个目标只用 Caddy 就已经达成，套 CDN 不是必要条件。

而且套上橙云代理后，**源站仍然需要一张证书**。唯一能省掉源站证书的是把 CF 的 SSL/TLS 模式设成
Flexible，那等于"浏览器→CF"加密、"CF→源站"明文裸奔，不要这么做。

套 CDN 真正带来的好处是别的：隐藏源站 IP、挡 CC、边缘缓存（`/api/buypoint` 已经带了
`s-maxage=60`，回源量能降一个量级）。这些理由本身就够了，不必挂在"省证书"上。

具体三种证书做法（含 15 年有效期的 Cloudflare Origin 证书）见 `Caddyfile.example` 里的注释。

⚠️ **如果你在 CF 上开了 "Cache Everything" 之类的页面规则，务必排除 `/api/refresh` 和 `/health`**，
否则响应会被缓存后发给别人。

---

## 运行机制

### 调度

北京时间每个交易日 `09:30 / 10:30 / 11:30 / 13:30 / 14:30 / 15:00` 各算一次，午间休市不跑，
法定节假日由服务端调 Fuyao 交易日历接口自行判断跳过。

调度按东八区偏移在代码里算，**与容器时区无关**，镜像不需要装 tzdata。
改时刻表：在 `docker-compose.yml` 里调 `SCHEDULE_TIMES`。

启动时若无数据、或数据已过 6 小时，会立即先算一次，不用干等到下一个调度点。

### 请求量

| 场景 | 上游请求数 | 耗时 |
|---|---|---|
| 冷启动（当日首次） | ~93 | ~25s |
| 当日后续几次 | ~27 | ~10s |

净值、60 日历史行情、指数日线都按 Asia/Shanghai 日期缓存，当天复用；只有场内快照每次重拉。

### 接口

| 路径 | 方法 | 用途 |
|---|---|---|
| `/` `/etf-dashboard.html` | GET | 看板本体 |
| `/api/buypoint` | GET | 全部标的分级汇总（约 18KB，CDN 缓存 60s） |
| `/api/buypoint/{代码}` | GET | 单只 60 日逐日明细（约 11KB） |
| `/health` | GET | 健康检查，`no-store` |
| `/api/refresh` | **POST** | 手动重算，需 `Authorization: Bearer <ADMIN_TOKEN>` |

`/api/refresh` 用 POST + Authorization 头而不是 GET + query token：口令写在 URL 里会进
Cloudflare 的访问日志和分析面板，而且 GET 响应可能被 CDN 缓存后发给别人。

### 数据

SQLite 库存在名为 `etf-data` 的 Docker named volume 里（不是 bind mount），容器重建不丢基线。

**为什么不用 `./data:/data` 这种 bind mount：** Dockerfile 里 `chown app:app /data` 只作用于
镜像层，换成 bind mount 后运行期这层所有权会被宿主机目录的所有权完全覆盖。在 Linux VPS 上，
若宿主机目录此前不存在，`docker compose up` 会以 root 创建它，容器内非 root 用户（app, uid 10001）
就只能读不能写，SQLite 建表时会报 `attempt to write a readonly database`。named volume 由 Docker
自己管理，首次创建时会继承镜像里已经 chown 好的所有权，与宿主机权限无关。

备份：

```bash
docker run --rm -v etf-data:/data -v "$(pwd)":/backup alpine \
  cp /data/buypoint.db /backup/buypoint.db.bak
```

如果确实需要直接在宿主机上访问这个文件（比如用宿主机 cron 做外部备份），可以改回 bind mount，
但必须先 `mkdir -p ./data && sudo chown -R 10001:10001 ./data`，`docker-compose.yml` 里也写了
对应注释。

---

## 🛠 故障排查：容器启动报 "attempt to write a readonly database"

```
Error: attempt to write a readonly database
  code: 'ERR_SQLITE_ERROR', errcode: 8
```

**原因：** 用了旧版本的 `docker-compose.yml`（bind mount `./data:/data`），且宿主机上的
`./data` 目录所有者不是容器内的 uid 10001（常见于目录被 Docker 以 root 自动创建，或此前
用不同配置起过容器）。

**修复：**

1. 确认 `server/docker-compose.yml` 里 `volumes:` 用的是 `etf-data:/data`（named volume），
   不是 `./data:/data`。这是默认写法，若你的仓库还是旧版本，`git pull` 更新即可。
2. 若之前已经跑起来过、留下了权限错误的 `./data` 目录：

   ```bash
   docker compose down
   rm -rf ./data          # 只是缓存的基线数据，可以放心删，重启会自动重算
   docker compose up -d --build
   ```

3. 若你确实想继续用 bind mount（比如需要宿主机 cron 直接访问库文件），必须先修目录所有权：

   ```bash
   mkdir -p ./data && sudo chown -R 10001:10001 ./data
   ```

---

## ⚠️ Fuyao 接口的稳定性问题（部署前务必知道）

实测 Fuyao 会**把限流伪装成业务错误码随机返回**。并发 6 连打 40 个请求，**32.5% 返回假错误**：

| 实际返回 | 真实情况 |
|---|---|
| `513300.SH` → `3004 This fund does not support market data` | 它是正常 ETF，前后都取得到 |
| `159941.SZ` → `3001 Fund not found` | 同上 |
| `513650.SH` → `1004 fund_type conflicts with thscode` | `fund_type=exchange` 对 ETF 完全正确 |

串行、间隔 1.2 秒也照样出现，所以不是并发问题；同一个代码隔几百毫秒重试就正常。

应对：`1004 / 3001 / 3004` 一律按临时性错误处理，指数退避重试至多 7 次。实测重试后失败率
**32.5% → 0%**，代价是失败请求会慢几秒。真正永久性的错误（比如 LOF 确实没有历史行情）
会在重试耗尽后稳定复现，照样能暴露出来。

**这也是为什么不能凭一次观测就把标的标记为"不支持"** —— 早先的实现把 `3004` 缓存 30 天，
在这种抖动率下会把大部分健康 ETF 永久标死。现在只依赖 `etfs.js` 里的静态标记。

---

## 已知限制

**三只 LOF 无法分级。** 161125 / 161127 / 161128 调历史行情稳定返回 `code=3004`（可复现，
与上面的假错误不同）—— 只有快照和净值、没有历史场内价，建不出收盘溢价基线。
表格显示 `n/a`，与"未触发阈值"的 `—` 区分开。

**四只标的的底层指数用了代理，但都经过实证校验。** Yahoo 对下列指数只返回当日一根、没有任何历史日线
（`range=3mo/6mo/1y`、`period1/period2` 都试过），只能找等效标的代理：

| 标的 | 原指数 | 代理 | 与净值相关性 |
|---|---|---|---|
| 159502 / 161127 | `^SPSIBI` 标普生物科技精选行业 | `XBI` | 0.9987 |
| 513350 | `^SPSIOP` 标普油气勘探生产精选行业 | `XOP` | 0.9978 |
| 159509 | `^NDXTMC` 纳斯达克100科技市值加权 | `IYW` | 0.9891 |
| 159529 | S&P 500 Consumer Select Index | `XLY` 55% + `XLP` 45% | 0.9900 |

代理不是猜的。校验方法：基金净值跟踪的就是底层指数，把候选指数折成人民币后，其日收益率
应当与净值日收益率高度相关。跑 `node test/validate-all.mjs` 可以复核全部 24 只，
真正同源的映射会落在 0.99 以上（对照基准：513100 对 `^NDX` 是 0.9982）。

这个方法当场揪出两个错配：

- **159529** 原先配 `^SP500-25`（标普500非必需消费）。它跟踪的 S&P 500 Consumer Select Index
  横跨必需与非必需两个板块，用净值回归定出等效组合是 XLY 55% + XLP 45%（r=0.9900，
  XLY 单独只有 0.9235）。错配的影响极大：**指数分位 37.5 vs 98.3，差了 60 个分位点**。
- **159509** 原先配 `^NDXT`（成分相同但等权），r 只有 0.9523；换成同为市值加权的 `IYW` 后升到 0.9891。

分位排名对单调变换不敏感，所以用 ETF 价格代替指数点位不影响分位本身，只有跟踪误差是二阶影响。
这比"用基金净值当指数代理"好得多 —— 后者会叠加汇率与净值披露时点误差，实测能把两维度
相关系数从 −0.15 放大到 −0.50。详情页对用了代理的标的会显示提示条。

**⚠️ 校验时的日期对齐陷阱。** QDII 净值标注的日期 D 对应的是**美股同日 D** 的收盘，不是 D-1
（美股 D 场收在北京时间 D+1 凌晨，但基金公司仍按估值日 D 标注）。实证：513100 净值 08-18
跌 1.64%，`^NDX` 08-18 那根跌 1.68%，而 08-17 那根只跌 0.17%。按 D-1 配对会让相关性掉到
−0.05，看起来像"完全不相关"，足以让人误判映射全错。

注意这与 `grading.js` 里 `alignIndexClose` 的用途不同：那里回答"上海 D 日开盘时市场已知的
最近一次美股收盘是哪根"（答案是 D-1），用于指数维度定位；校验脚本回答"净值 D 反映的是哪根"
（答案是 D），用于识别指数身份。两者都对，不要混用。

**溢价口径有一处已知的次要不一致。** 基线用 `close(D)/nav(D)`（skill 的写法），而盘中实时点
只能用最新已公布的净值（滞后 2–5 天）。实测两种口径下的溢价分位相差 1.7–4.2 个分位点，
远小于 25 分位的判定线，不会翻档，故保留 skill 验证过的口径。

**盘中估算不是收盘确认值。** 分位边界只用收盘价 + 收盘净值算、一天一次；只有"当前这一个点"
用实时价对照。用日内瞬时溢价代替收盘溢价会造成假信号，所以两者必须分开看。

**QDII 净值滞后 2–4 个交易日**，因此基线最后一天通常不是今天。指数维度**没有**沿用基线末点
（那会让指数分位陈旧 4 天，实测足以让等级从 C 翻成 D），而是取"今天开盘前最近一次完整的
美股收盘"重新定位。

**所有阈值都会随窗口滚动而漂移**，不能跨窗口、跨标的沿用，更不能当作永久基准。

---

## 本地开发

不需要 Docker 就能跑通全部逻辑：

```bash
cd server
FUYAO_KEY=sk-fuyao-xxx node test/verify.mjs 159941   # 单只标的的完整管线 + 中间量
FUYAO_KEY=sk-fuyao-xxx node test/pipeline.mjs        # 完整管线（SQLite 用内存库）
FUYAO_KEY=sk-fuyao-xxx node test/validate-all.mjs    # 复核全部 24 只的底层指数映射
FUYAO_KEY=sk-fuyao-xxx node test/validate-index.mjs 159529 XLY XLP ^GSPC   # 单只标的比对候选指数
FUYAO_API_KEY=sk-fuyao-xxx ADMIN_TOKEN=dev npm run dev   # 起服务，访问 http://localhost:8787
```

---

## 免责声明

本功能只对"当前相对位置"做分级，不预测涨跌方向，不构成任何投资建议。
样本量、时间窗口、汇率与 QDII 额度等制度性因素均未纳入模型。
