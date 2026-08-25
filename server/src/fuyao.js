/** 同花顺金融数据 API 客户端（Worker 侧，用服务端 Secret 里的 Key） */

const BASE = "https://fuyao.aicubes.cn";
const SH_TZ_OFFSET = 8 * 3600 * 1000;

export class FuyaoError extends Error {
  constructor(code, message) { super(`Fuyao code=${code}: ${message}`); this.code = code; }
}

/**
 * 可重试的业务码。
 *
 * 4001/5002/5003 是文档写明的临时性错误，重试天经地义。
 * 1004/3001/3004 按文档是"参数错误 / 标的不存在 / 类型不支持"这类永久性错误，本不该重试 ——
 * 但实测 Fuyao 会把它们当作**限流的伪装**随机返回：并发 6 打 40 个请求，32.5% 返回假错误码
 * （其中 3004 十一次、3001 两次），而同一个 thscode 隔几百毫秒重试就正常。
 * 观察到的假错误举例：
 *   513300.SH → "This fund does not support market data"（它是正常 ETF，前后都取得到）
 *   159941.SZ → "Fund not found"
 *   513650.SH → "fund_type conflicts with thscode"（fund_type=exchange 对 ETF 完全正确）
 * 因此这三个码一律按临时性处理。真正永久性的错误（比如 LOF 确实没有历史行情）会在重试耗尽后
 * 稳定复现，照样能暴露出来，只是多花几次请求 —— 这个代价远小于把健康标的误判成"不支持"。
 */
const RETRIABLE = new Set([4001, 5002, 5003, 1004, 3001, 3004]);
// 按实测 32.5% 的单次失败率，5 次尝试后仍失败的概率是 0.325^5 ≈ 0.36%，
// 单轮 ~91 个请求下期望仍有 0.3 个漏网（实测确实每轮漏 1 个）。
// 提到 7 次，残留概率降到 0.325^7 ≈ 0.04%，整轮出现失败的概率约 3%。
// 重试只在失败时才付出代价，成功路径不受影响。
const MAX_ATTEMPTS = 7;

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** 指数退避 + 抖动，避免多个请求重试时撞在同一时刻 */
const backoff = i => Math.min(2500, 300 * 2 ** i) + Math.random() * 250;

async function get(path, params, key) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

  let lastErr;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i) await sleep(backoff(i - 1));

    let resp;
    try {
      resp = await fetch(url, { headers: { "X-api-key": key }, signal: AbortSignal.timeout(20000) });
    } catch (e) { lastErr = e; continue; }

    if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status}`); continue; }

    let j;
    try { j = await resp.json(); } catch (e) { lastErr = new Error("响应不是合法 JSON"); continue; }

    if (j.code === 0) return j.data;

    lastErr = new FuyaoError(j.code, j.message);
    lastErr.attempts = i + 1;
    if (RETRIABLE.has(j.code)) continue;
    throw lastErr;                       // 2001/2003 这类鉴权错误立刻失败，重试没有意义
  }
  throw lastErr;
}
const items = d => (d && Array.isArray(d.item)) ? d.item : [];

/** 场内快照：最新价 */
export async function snapshot(ths, key) {
  const it = items(await get("/api/fund/market/snapshot", { thscode: ths }, key))[0];
  return it ? { price: it.last_price, prevPrice: it.prev_price, changePct: it.price_change_ratio_pct } : null;
}

/** 基金资料：最新单位净值、规模 */
export async function profile(ths, key) {
  const it = items(await get("/api/fund/profile/detail", { fund_type: "exchange", thscode: ths }, key))[0];
  return it ? { nav: it.unit_nav, scale: it.fund_scale, name: it.fund_name } : null;
}

/**
 * 历史日线收盘价 -> Map<dateMs, close>
 * date_ms 是「该交易日在 Asia/Shanghai 的零点」，直接当 key 用即可（不要按 UTC 重新取日期，
 * 那会把所有交易日整体提前一天 —— skill E2 §1 记录过的时区陷阱）。
 */
export async function historicalCloses(ths, startMs, endMs, key) {
  const d = await get("/api/fund/market/historical",
    { thscode: ths, interval: "1d", start: startMs, end: endMs }, key);
  const m = new Map();
  for (const it of items(d)) if (it.close_price != null) m.set(it.date_ms, it.close_price);
  return m;
}

/**
 * 单位净值序列 -> Map<dateMs, unitNav>
 * 这个接口不接受任意 start/end，只接受命名区间；hyear(半年) 足以覆盖 60 个交易日窗口并留余量。
 */
export async function navSeries(ths, key, range = "hyear") {
  const d = await get("/api/fund/performance/nav",
    { fund_type: "exchange", thscode: ths, range, nav_type: "unit" }, key);
  const m = new Map();
  for (const it of items(d)) if (it.unit_nav != null) m.set(it.nav_date, it.unit_nav);
  return m;
}

/** A股交易日历 -> Set<"yyyyMMdd"> */
export async function tradingDays(key) {
  const d = await get("/api/a-share/calendar/trading-days", {}, key);
  return new Set(items(d).map(it => it.date));
}

/** 当前时刻的 Asia/Shanghai 日期，格式 yyyyMMdd */
export function shanghaiDateStr(nowMs = Date.now()) {
  const d = new Date(nowMs + SH_TZ_OFFSET);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
