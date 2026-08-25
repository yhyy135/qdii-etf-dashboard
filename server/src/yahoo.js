/**
 * Yahoo Finance 公开行情接口。
 *
 * 这是 yfinance 底层调用的同一个 JSON 接口。实测该接口**不返回 Access-Control-Allow-Origin**，
 * 浏览器直连会被跨域拦截 —— 这正是指数维度必须放在 Worker 里做的原因，不是可选优化。
 */

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

/**
 * 取日线序列
 * @returns [{ tsMs: 当日开盘 epoch ms, close }]，按时间升序，已剔除空值
 */
export async function dailyCloses(symbol, range = "6mo") {
  const url = `${BASE}${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; etf-buypoint-worker/1.0)" }
      });
      if (!resp.ok) { last = new Error(`Yahoo HTTP ${resp.status}`); await new Promise(r => setTimeout(r, 500 * (i + 1))); continue; }
      const j = await resp.json();
      if (j?.chart?.error) throw new Error(`Yahoo ${j.chart.error.code}: ${j.chart.error.description}`);
      const res = j?.chart?.result?.[0];
      if (!res) throw new Error("Yahoo 返回空结果");
      const ts = res.timestamp || [];
      const closes = res.indicators?.quote?.[0]?.close || [];
      const out = [];
      for (let k = 0; k < ts.length; k++) {
        if (closes[k] == null) continue;          // 停牌/缺口
        out.push({ tsMs: ts[k] * 1000, close: closes[k] });
      }
      out.sort((a, b) => a.tsMs - b.tsMs);
      if (!out.length) throw new Error("Yahoo 返回的日线全为空");
      return out;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}

/**
 * 组合指数：按权重合成一条等效序列。
 *
 * 有些 QDII 跟踪的指数在 Yahoo 上既没有历史、也没有单一 ETF 完整复刻（例如"标普500消费精选指数"
 * 横跨必需与非必需两个板块）。做法是用基金净值日收益率对候选做回归，找出最贴合的权重组合。
 * 分位排名只看单调性，所以合成序列的绝对量纲无意义，不必归一化。
 */
export async function blendSeries(parts) {
  const all = await Promise.all(parts.map(p => dailyCloses(p.symbol)));
  const maps = all.map(bars => new Map(bars.map(b => [new Date(b.tsMs).toISOString().slice(0, 10), b])));
  const out = [];
  for (const [date, bar] of maps[0]) {
    const picks = maps.map(m => m.get(date));
    if (picks.some(p => !p)) continue;              // 任一成分缺当日数据就整天跳过
    out.push({ tsMs: bar.tsMs, close: picks.reduce((sum, p, i) => sum + p.close * parts[i].weight, 0) });
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  if (!out.length) throw new Error("组合指数各成分没有重叠的交易日");
  return out;
}

/** 按标的配置取指数序列：单一 ticker 或加权组合 */
export function indexSeriesFor(meta) {
  return meta.indexBlend ? blendSeries(meta.indexBlend) : dailyCloses(meta.indexSymbol);
}
