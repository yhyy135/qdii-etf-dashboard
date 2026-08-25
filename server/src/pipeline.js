/**
 * 买点分级计算管线。
 *
 * 与 Cloudflare Worker 版本相比去掉了 subrequest 预算机制 —— 自建服务端没有单次调用的请求数上限，
 * 一次就能把全部标的算完，不再需要跨调度滚动补齐。
 *
 * 但有两件事**不能**跟着删：
 *   1. 并发限制器：Fuyao 自己的 QPS 约束不随部署平台消失。
 *   2. 按日缓存 + 上一版基线兜底：实测 Fuyao 有 32.5% 的请求会返回伪装成业务错误的假错误码
 *      （见 fuyao.js 的 RETRIABLE 注释），重试层能吸收绝大部分，但兜底仍是必要的。
 */
import { ETFS } from "./etfs.js";
import * as fuyao from "./fuyao.js";
import { indexSeriesFor } from "./yahoo.js";
import {
  buildBaseline, locateLive,
  TRIGGER_PREMIUM, WINDOW_DAYS, LOW_CUT, GRADE_LABEL
} from "./grading.js";

const BASELINE_TTL = 7 * 86400;     // 基线保留 7 天，够跨周末沿用
const DAY_TTL = 36 * 3600;
const CONCURRENCY = 6;

const shanghaiMidnightMs = (now = Date.now()) =>
  Math.floor((now + 8 * 3600 * 1000) / 86400000) * 86400000 - 8 * 3600 * 1000;

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); }
  }));
  return out;
}

export async function runPipeline({ kv, apiKey, force = false, log = () => {} }) {
  if (!apiKey) throw new Error("缺少 FUYAO_API_KEY");

  const now = Date.now();
  const today = fuyao.shanghaiDateStr(now);
  const todayMidnight = shanghaiMidnightMs(now);
  const startedAt = now;
  let requests = 0;

  // ── 交易日判断 ───────────────────────────────────────────────────────
  let isTradingDay = true, calendarSource = "cache";
  try {
    let cal = await kv.get("calendar", "json");
    if (!cal || cal.fetchedDate !== today) {
      requests++;
      cal = { fetchedDate: today, days: [...await fuyao.tradingDays(apiKey)] };
      await kv.put("calendar", cal, { expirationTtl: DAY_TTL });
      calendarSource = "api";
    }
    isTradingDay = cal.days.includes(today);
  } catch (e) {
    calendarSource = `error: ${e.message}`;   // 日历取不到不阻断主流程
    log("warn", `交易日历获取失败：${e.message}`);
  }
  if (!isTradingDay && !force) {
    log("info", `${today} 非交易日，跳过`);
    return { skipped: true, reason: "非交易日", date: today, calendarSource };
  }

  // ── 第一步：快照 + 基金资料，筛出溢价 > 阈值的子集 ────────────────────
  //
  // 净值、规模、基金公司、年涨跌幅这几项一天只变一次（净值本身就是按估值日发布的，
  // 规模/公司名/区间收益更新更慢），没必要每次调度都重拉，按"代码+日期"缓存到 KV，
  // 当天只在第一次遇到该标的时刷新，其余场次直接复用。这份缓存同时也是
  // GET /api/fund-info 的数据源，供前端页面加载时读一次、不必每次点刷新都打 Fuyao。
  const infoEnvelope = (await kv.get("fundinfo", "json")) || { updatedAt: null, items: {} };
  const infoStore = infoEnvelope.items;
  let infoDirty = false;

  const live = await mapLimit(ETFS, CONCURRENCY, async (e) => {
    try {
      requests++;
      const snap = await fuyao.snapshot(e.ths, apiKey);

      const cached = infoStore[e.code];
      let nav = cached?.nav ?? null;
      if (!cached || cached.date !== today) {
        try {
          requests += 2;
          const [prof, ret] = await Promise.all([
            fuyao.profile(e.ths, apiKey),
            fuyao.returns(e.ths, apiKey).catch(() => null)   // 年涨跌幅拿不到不影响主流程，静默降级
          ]);
          if (prof?.nav > 0) {
            nav = prof.nav;
            infoStore[e.code] = {
              nav: prof.nav, scale: prof.scale, name: prof.name, mgmt: prof.mgmt,
              ytd: ret?.ytd ?? null, y1: ret?.y1 ?? null, date: today
            };
            infoDirty = true;
          }
        } catch (err) {
          // 净值拉不到就先用昨天的：净值日间变动远小于 2% 这个阈值的判别力，用于筛选是安全的
          if (nav == null) throw err;
          log("warn", `${e.code} 基金资料刷新失败，沿用 ${cached.date}：${err.message}`);
        }
      }

      if (!snap?.price) return { e, error: "快照缺失", retry: true };
      if (!(nav > 0)) return { e, error: "净值缺失", retry: true };
      return { e, price: snap.price, nav, navStale: infoStore[e.code]?.date !== today ? cached?.date : null,
               prem: (snap.price / nav - 1) * 100 };
    } catch (err) {
      // 2001/2003 是鉴权失败（Key 缺失/无效/无权限）——不会随时间自愈，值得显眼报错。
      // 其余一律按可重试处理：多数是 fuyao.js 里 7 次重试都没扛住的尾部抖动（按实测概率，
      // 91 个请求的一轮里约 3% 会漏网至少一个），下一次调度（不到一小时后）几乎总能恢复。
      // 混为一谈会导致"分级"列显示吓人的错误图标，而实际上什么都没坏，纯粹是运气不好。
      const authFailure = err.code === 2001 || err.code === 2003;
      return { e, error: err.message, retry: !authFailure };
    }
  });
  if (infoDirty) await kv.put("fundinfo", { updatedAt: now, items: infoStore }, { expirationTtl: 30 * 86400 });

  const triggered = live.filter(r => !r.error && r.prem > TRIGGER_PREMIUM && !r.e.noMarketHistory);
  log("info", `${today} 快照完成，${triggered.length}/${ETFS.length} 只溢价 > ${TRIGGER_PREMIUM}%`);

  // ── 第二步：建 60 日基线（当天已算过就复用）──────────────────────────
  const idxCache = new Map();
  const baselines = new Map();
  const built = [], reused = [], failed = [];

  // 指数日线按 symbol 去重，一天一次（组合指数用 indexSymbol 作为合成后的缓存键）
  const specs = new Map();
  for (const t of triggered) if (!specs.has(t.e.indexSymbol)) specs.set(t.e.indexSymbol, t.e);
  for (const [sym, meta] of specs) {
    const ck = `index:${sym}:${today}`;
    let bars = await kv.get(ck, "json");
    if (!bars) {
      try {
        requests += meta.indexBlend ? meta.indexBlend.length : 1;
        bars = await indexSeriesFor(meta);
        await kv.put(ck, bars, { expirationTtl: DAY_TTL });
      } catch (e) {
        log("warn", `指数 ${sym} 取数失败：${e.message}`);
        bars = await kv.get(`index:${sym}:last`, "json");   // 退回上一次成功的
      }
    }
    if (bars) { idxCache.set(sym, bars); await kv.put(`index:${sym}:last`, bars, { expirationTtl: BASELINE_TTL }); }
  }

  await mapLimit(triggered, 3, async (t) => {
    const e = t.e;
    const todayKey = `baseline:${e.code}:${today}`;
    const cached = await kv.get(todayKey, "json");
    if (cached) { baselines.set(e.code, cached); reused.push(e.code); return; }

    const bars = idxCache.get(e.indexSymbol);
    if (!bars) { failed.push(e.code); return; }

    try {
      requests += 2;
      const [prices, navs] = await Promise.all([
        fuyao.historicalCloses(e.ths, now - 200 * 86400 * 1000, now, apiKey),
        fuyao.navSeries(e.ths, apiKey)
      ]);
      const b = buildBaseline(prices, navs, bars);
      if (!b) { failed.push(e.code); return; }

      const base = {
        date: today, series: b.series, premSorted: b.premSorted, idxSorted: b.idxSorted,
        cuts: b.cuts, dist: b.dist, warnings: b.warnings, usBars: bars.slice(-8)
      };
      await kv.put(todayKey, base, { expirationTtl: BASELINE_TTL });
      await kv.put(`baseline:${e.code}:last`, base, { expirationTtl: BASELINE_TTL });
      baselines.set(e.code, base);
      built.push(e.code);
    } catch (err) {
      // 注意：这里**不再**把 3004 当作"该标的永久不支持"记下来。
      // 实测 Fuyao 会随机对健康 ETF 返回 3004，一次观测就永久标死是危险的；
      // 真正不支持的三只 LOF 已在 etfs.js 里静态标记，不依赖运行时推断。
      log("warn", `${e.code} 基线构建失败：${err.message}`);
      failed.push(e.code);
      const old = await kv.get(`baseline:${e.code}:last`, "json");
      if (old) baselines.set(e.code, old);
    }
  });

  // ── 第三步：把当前价格定位到基线上 ────────────────────────────────────
  const items = [];
  for (const r of live) {
    const e = r.e;
    const row = {
      code: e.code, name: e.name, ths: e.ths,
      indexSymbol: e.indexSymbol, indexName: e.indexName,
      indexVerified: e.verified !== false, proxy: e.proxy || null
    };

    if (r.error) {
      // retry:true（绝大多数情况）= 抖动/网络问题，下一次调度会自动重试，UI 显示为"待补"而非"报错"
      items.push({
        ...row,
        status: r.retry ? "pending" : "error",
        message: r.retry ? `暂时获取不到行情/净值（${r.error}），下一次调度会自动重试` : r.error
      });
      continue;
    }

    row.price = r.price; row.nav = r.nav; row.prem = r.prem;
    if (r.navStale) row.navStale = r.navStale;

    if (r.prem <= TRIGGER_PREMIUM) {
      items.push({ ...row, status: "not_triggered", threshold: TRIGGER_PREMIUM });
      continue;
    }
    if (e.noMarketHistory) {
      items.push({ ...row, status: "unsupported",
        message: "该 LOF 无历史场内行情（Fuyao code=3004），建不出收盘溢价基线" });
      continue;
    }

    const base = baselines.get(e.code);
    const loc = base && locateLive(base, r.price, r.nav, base.usBars, todayMidnight);
    if (!loc) { items.push({ ...row, status: "pending", message: "基线暂不可用，下一次调度会重试" }); continue; }

    items.push({
      ...row, status: "ok",
      grade: loc.grade, gradeLabel: GRADE_LABEL[loc.grade],
      premPct: loc.premPct, idxPct: loc.idxPct,
      idx: loc.idx, idxDateMs: loc.idxDateMs, idxStale: loc.idxStale,
      baselineDate: base.date, baselineStale: base.date !== today,
      baselineLastMs: loc.baselineLastMs,
      window: base.series.length, dist: base.dist, cuts: base.cuts, warnings: base.warnings
    });

    await kv.put(`detail:${e.code}`, {
      ...row, status: "ok", updatedAt: now, live: loc,
      baselineDate: base.date, baselineStale: base.date !== today,
      window: base.series.length, cuts: base.cuts, dist: base.dist,
      warnings: base.warnings, lowCut: LOW_CUT, series: base.series
    }, { expirationTtl: BASELINE_TTL });
  }

  const payload = {
    updatedAt: now, date: today, isTradingDay,
    window: WINDOW_DAYS, lowCut: LOW_CUT, threshold: TRIGGER_PREMIUM,
    counts: {
      total: ETFS.length,
      triggered: triggered.length,
      graded: items.filter(i => i.status === "ok").length,
      pending: items.filter(i => i.status === "pending").length,
      unsupported: items.filter(i => i.status === "unsupported").length,
      error: items.filter(i => i.status === "error").length
    },
    baselines: { built, reused, failed },
    requests,
    elapsedMs: Date.now() - startedAt,
    items
  };
  await kv.put("latest", payload);
  if (kv.sweep) kv.sweep();

  log("info", `完成：已分级 ${payload.counts.graded}，请求 ${requests} 次，耗时 ${payload.elapsedMs}ms`);
  return payload;
}
