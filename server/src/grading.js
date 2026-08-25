/**
 * 双维度分位买点分级 —— 纯函数核心（无 IO，可在 Node 下直接跑测试）。
 *
 * 方法论来源：.claude/skills/qdii-etf-dual-percentile-buypoint/SKILL.md
 * 关键约束（照搬 skill，勿擅自放宽）：
 *   1. 分位边界只用「收盘价 + 收盘净值」算，一天算一次；日内瞬时溢价代替收盘溢价会造成假信号。
 *   2. 所有阈值来自当前窗口的真实分布（下四分位），不用凭直觉设的固定数字 ——
 *      固定数字往往在真实样本里一次都没出现过，会让标准永远触发不了或形同虚设。
 *   3. 窗口滚动后阈值必须重算，不能跨窗口/跨标的沿用。
 */

export const WINDOW_DAYS = 60;   // 固定最近 60 个交易日（按交易日计，不看自然月）
export const LOW_CUT = 25;       // "低位" = 落在窗口下四分位内
export const TRIGGER_PREMIUM = 2; // 只对当前溢价 > 2% 的标的计算

/** 升序数组里 < v 的元素个数 */
function lowerBound(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
/** 升序数组里 <= v 的元素个数 */
function upperBound(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * v 在样本中的百分位（0–100）。用 midrank 处理并列值，
 * 避免同一个溢价率出现多次时分位被系统性高估或低估。
 */
export function percentileRank(sortedAsc, v) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const less = lowerBound(sortedAsc, v);
  const lessEq = upperBound(sortedAsc, v);
  return ((less + lessEq) / 2) / n * 100;
}

/** 分位数，线性插值（与 numpy 默认 type-7 一致） */
export function quantile(sortedAsc, q) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * 四档买点等级 —— skill E 步骤5 的 2×2 结构。
 * 两个维度各自判断"是否落在窗口下四分位"，交叉出四档：
 *   A 优质    指数低 + 溢价低 —— 两维度同时低，框架里质量最高的样本
 *   B 可接受  指数不低 + 溢价低 —— 溢价维度理想、指数维度一般
 *   C 回撤型  指数低 + 溢价不低 —— 价格新低多半是指数跌出来的，被高溢价吃掉了便宜
 *   D 谨慎    两维度都不低
 */
export function gradeOf(idxPct, premPct, cut = LOW_CUT) {
  if (idxPct == null || premPct == null) return null;
  const idxLow = idxPct <= cut, premLow = premPct <= cut;
  if (idxLow && premLow) return "A";
  if (!idxLow && premLow) return "B";
  if (idxLow && !premLow) return "C";
  return "D";
}

export const GRADE_LABEL = {
  A: "优质：指数与溢价同时处于窗口低位",
  B: "可接受：溢价处于低位，指数位置一般",
  C: "回撤型：指数已回撤但溢价不低，便宜被溢价吃掉",
  D: "谨慎：两个维度都不在低位"
};

/**
 * 把上交所交易日与美股收盘对齐。
 *
 * 不能按日期字符串相等去 join：上海 T 日开盘前，最近一次完整收盘的美股交易日通常是「美股 T-1」，
 * 遇美股假期还要继续往前回溯。做法是双方都换算成 UTC 时间戳，对每个上海交易日的开盘时刻
 * 做 backward 最近邻匹配。（skill E2 §2 记录的对齐陷阱）
 *
 * @param shDateMs  上海交易日零点（Asia/Shanghai）的 epoch ms
 * @param usBars    [{ tsMs: 美股当日开盘 epoch ms, close }]，按 tsMs 升序
 */
const SH_OPEN_OFFSET = 9.5 * 3600 * 1000;  // 上海 09:30
const US_SESSION_LEN = 6.5 * 3600 * 1000;  // 美股开盘到收盘 6.5 小时

export function alignIndexClose(shDateMs, usBars) {
  const shOpenUtc = shDateMs + SH_OPEN_OFFSET;
  let lo = 0, hi = usBars.length, ans = -1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (usBars[m].tsMs + US_SESSION_LEN < shOpenUtc) { ans = m; lo = m + 1; }
    else hi = m;
  }
  return ans >= 0 ? usBars[ans] : null;
}

/**
 * 构建一只 ETF 的 60 日基线。
 *
 * @param priceByDate Map<dateMs, close>   ETF 收盘价
 * @param navByDate   Map<dateMs, unitNav> 收盘单位净值
 * @param usBars      美股指数日线，升序
 * @returns { series, cuts, dist, warnings } 或 null（样本不足）
 */
export function buildBaseline(priceByDate, navByDate, usBars) {
  const warnings = [];

  // 只保留价格与净值都有的交易日 —— 缺一个就算不出收盘溢价
  const rows = [];
  for (const [dateMs, close] of priceByDate) {
    const nav = navByDate.get(dateMs);
    if (nav == null || !(nav > 0) || close == null) continue;
    const bar = alignIndexClose(dateMs, usBars);
    if (!bar) continue;
    rows.push({
      dateMs,
      close,
      nav,
      prem: (close / nav - 1) * 100,
      idx: bar.close,
      idxDateMs: bar.tsMs
    });
  }

  rows.sort((a, b) => a.dateMs - b.dateMs);
  const series = rows.slice(-WINDOW_DAYS);

  if (series.length < 10) return null;   // skill E 步骤4 判停条件：样本不足 10 个交易日
  if (series.length < WINDOW_DAYS) {
    warnings.push(`窗口内仅 ${series.length} 个有效交易日（目标 ${WINDOW_DAYS} 个），分位结论稳定性下降`);
  }

  const premSorted = series.map(r => r.prem).sort((a, b) => a - b);
  const idxSorted = series.map(r => r.idx).sort((a, b) => a - b);

  for (const r of series) {
    r.premPct = percentileRank(premSorted, r.prem);
    r.idxPct = percentileRank(idxSorted, r.idx);
    r.grade = gradeOf(r.idxPct, r.premPct);
  }

  const dist = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of series) dist[r.grade]++;

  return {
    series,
    premSorted,
    idxSorted,
    cuts: {
      premQ1: quantile(premSorted, 0.25),
      premMed: quantile(premSorted, 0.5),
      premQ3: quantile(premSorted, 0.75),
      idxQ1: quantile(idxSorted, 0.25),
      idxMed: quantile(idxSorted, 0.5),
      idxQ3: quantile(idxSorted, 0.75)
    },
    dist,
    warnings
  };
}

/**
 * 把当前盘中价格套到收盘基线上，得到「如果现在收盘，大概落在哪一档」的估算。
 *
 * 两个维度的取值口径不同，都不是随便选的：
 *
 * - 溢价维度：用实时价 ÷ 最新公布净值的估算溢价，在**收盘溢价分布**里定位。分布本身只用收盘数据
 *   算（skill 明确警告过日内瞬时溢价会造假信号），只有"当前这一个点"用实时值。
 *
 * - 指数维度：用「今天开盘前最近一次完整的美股收盘」，而不是沿用基线最后一天的指数分位。
 *   方案原文假设"基线最新点就是美股 T-1"，但那只在净值不滞后时成立 —— QDII 净值披露滞后 2–4 个
 *   交易日，基线最后一天往往是 4 天前，直接沿用会让指数维度整体陈旧。实测：基线末点 08-21 对应
 *   美股 08-20，而当天（08-25）实际最新美股收盘是 08-24，差了 4 天。
 *
 * @param todayShMidnightMs 今天在 Asia/Shanghai 的零点 epoch ms
 */
export function locateLive(baseline, livePrice, liveNav, usBars, todayShMidnightMs) {
  if (!baseline || livePrice == null || !(liveNav > 0)) return null;

  const prem = (livePrice / liveNav - 1) * 100;
  const premPct = percentileRank(baseline.premSorted, prem);

  const last = baseline.series[baseline.series.length - 1];
  let idxBar = null;
  if (usBars && usBars.length && todayShMidnightMs) idxBar = alignIndexClose(todayShMidnightMs, usBars);
  // 取不到更新的指数就退回基线末点，并标记出来，让 UI 能说明分位为何偏旧
  const stale = !idxBar || idxBar.tsMs <= last.idxDateMs;
  if (stale) idxBar = { tsMs: last.idxDateMs, close: last.idx };

  const idxPct = percentileRank(baseline.idxSorted, idxBar.close);

  return {
    price: livePrice,
    nav: liveNav,
    prem,
    premPct,
    idxPct,
    idx: idxBar.close,
    idxDateMs: idxBar.tsMs,
    idxStale: stale,                    // true = 未取到比基线更新的美股收盘
    baselineLastMs: last.dateMs,        // 基线覆盖到哪天（净值滞后的体现）
    grade: gradeOf(idxPct, premPct),
    estimated: true                     // 盘中估算，非收盘确认值
  };
}
