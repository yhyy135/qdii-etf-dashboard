/**
 * 标的清单 + 底层指数映射。
 *
 * indexSymbol 为实际取数用的 Yahoo Finance ticker。
 *
 * verified=false  该映射尚未按指数中英文名核对确认，前端详情页会显著标注"指数映射待核实"。
 *                 指数选错会直接让维度一失真 —— 正是本框架要纠正的那类失真，必须让用户看见。
 *
 * noMarketHistory 实测 LOF（161125/161127/161128）调 /api/fund/market/historical 返回
 *                 code=3004 "This fund does not support market data" —— 只有快照和净值，没有历史
 *                 场内价，因此建不出 60 日收盘溢价基线。标记出来避免每次调度白白浪费 subrequest，
 *                 前端按"该品种不支持"单独呈现（既不是未触发，也不是计算失败）。
 *
 * indexBlend      指数由多个 ticker 加权合成（见 yahoo.js 的 blendSeries）。
 *                 用于底层指数在 Yahoo 上既无历史、也没有单一 ETF 完整复刻的情形。
 *                 权重由"基金净值日收益率 vs 候选组合日收益率"的相关性回归确定，不是拍脑袋定的。
 *
 * proxy           实测 Yahoo 对 ^NDXTMC / ^SPSIBI / ^SPSIOP 这三个指数只返回当日 1 根、没有任何
 *                 历史日线（range=3mo/6mo/1y、period1/period2 全试过，结论一致），无法构建 60 日
 *                 基线。改用能完整复刻同一指数的标的代理，并在此显式记录代理关系。
 *                 分位排名对单调变换不敏感（用 ETF 价格代替指数点位不改变分位），因此代理的量纲差异
 *                 无影响，只有跟踪误差是二阶影响 —— 这比 skill E2 §3 那个"净值代理"方案好得多，
 *                 净值代理会叠加汇率与披露时点误差，实测能把两维度相关系数从 -0.15 放大到 -0.50。
 */
export const ETFS = [
  // ---- 纳斯达克100（11只）----
  { code: "159941", ths: "159941.SZ", name: "纳指ETF广发",        indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "513100", ths: "513100.SH", name: "纳指ETF国泰",        indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "513300", ths: "513300.SH", name: "纳斯达克ETF华夏",    indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "159501", ths: "159501.SZ", name: "纳指ETF嘉实",        indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "159632", ths: "159632.SZ", name: "纳斯达克ETF华安",    indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "159659", ths: "159659.SZ", name: "纳斯达克100ETF招商", indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "159513", ths: "159513.SZ", name: "纳斯达克100ETF大成", indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "513110", ths: "513110.SH", name: "纳指ETF华泰柏瑞",    indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "159696", ths: "159696.SZ", name: "纳指ETF易方达",      indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "513390", ths: "513390.SH", name: "纳指100ETF博时",     indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  { code: "513870", ths: "513870.SH", name: "纳指ETF富国",        indexSymbol: "^NDX",    indexName: "纳斯达克100",              verified: true },
  // ---- 标普500（5只）----
  { code: "513500", ths: "513500.SH", name: "标普500ETF博时",     indexSymbol: "^GSPC",   indexName: "标普500",                  verified: true },
  { code: "513650", ths: "513650.SH", name: "标普500ETF南方",     indexSymbol: "^GSPC",   indexName: "标普500",                  verified: true },
  { code: "159655", ths: "159655.SZ", name: "标普500ETF华夏",     indexSymbol: "^GSPC",   indexName: "标普500",                  verified: true },
  { code: "161125", ths: "161125.SZ", name: "标普500LOF易方达",   indexSymbol: "^GSPC",   indexName: "标普500",                  verified: true, noMarketHistory: true },
  { code: "159612", ths: "159612.SZ", name: "标普500ETF国泰",     indexSymbol: "^GSPC",   indexName: "标普500",                  verified: true },
  // ---- 道琼斯（1只）----
  { code: "513400", ths: "513400.SH", name: "道琼斯ETF鹏华",      indexSymbol: "^DJI",    indexName: "道琼斯工业平均",           verified: true },
  // ---- 窄基 / 行业主题（7只）----
  { code: "159509", ths: "159509.SZ", name: "纳指科技ETF景顺",    indexSymbol: "IYW",     indexName: "纳斯达克科技市值加权",     verified: true,
    proxy: { of: "^NDXTMC", ofName: "纳斯达克100科技市值加权指数",
             why: "Yahoo 无该指数历史日线。原先用成分相同但等权的 ^NDXT，实测与净值相关性只有 0.9523；改用同为市值加权的 iShares 美国科技 ETF (IYW) 后升至 0.9891（IYW 90%+QQQ 10% 的组合仅再提升 0.001，不值得加复杂度）" } },
  { code: "161128", ths: "161128.SZ", name: "标普信息科技LOF",    indexSymbol: "^SP500-45", indexName: "标普500信息科技",        verified: true, noMarketHistory: true },
  { code: "159502", ths: "159502.SZ", name: "标普生物科技ETF嘉实", indexSymbol: "XBI",     indexName: "标普生物科技精选行业",     verified: true,
    proxy: { of: "^SPSIBI", ofName: "标普生物科技精选行业指数", why: "Yahoo 无该指数历史日线，改用完整复刻该指数的 SPDR ETF (XBI) 价格" } },
  { code: "513290", ths: "513290.SH", name: "纳指生物科技ETF汇添富", indexSymbol: "^NBI", indexName: "纳斯达克生物科技",         verified: true },
  // 159529 跟踪 S&P 500 Consumer Select Index（业绩基准写作 "…Returns - CNY - Benchmark TR Gross"，
  // 那是折人民币的全收益口径；这里要的是美元价格序列，折人民币会把汇率混进指数维度）。
  // Yahoo 没有该指数序列，也没有单一 ETF 完整复刻 —— 它横跨必需与非必需两个消费板块。
  // 用基金净值日收益率对候选做回归定出等效组合：XLY 55% + XLP 45%，相关性 0.9900
  // （XLY 单独只有 0.9235，XLP 单独 0.5576；对照 513100 对 ^NDX 是 0.9982）。
  // 早先误配成 ^SP500-25，实测指数分位差了 60 个分位点（37.5 vs 98.3）。
  { code: "159529", ths: "159529.SZ", name: "标普消费ETF景顺",
    indexSymbol: "XLY+XLP", indexName: "标普500消费精选（等效组合）", verified: true,
    indexBlend: [{ symbol: "XLY", weight: 0.55 }, { symbol: "XLP", weight: 0.45 }],
    proxy: { of: "S&P 500 Consumer Select Index", ofName: "标普500消费精选指数",
             why: "Yahoo 无该指数序列，用净值日收益率回归定出的等效组合 XLY 55% + XLP 45%，实测相关性 0.9900" } },
  { code: "513350", ths: "513350.SH", name: "标普油气ETF富国",    indexSymbol: "XOP",     indexName: "标普油气勘探生产精选行业", verified: true,
    proxy: { of: "^SPSIOP", ofName: "标普油气勘探及生产精选行业指数", why: "Yahoo 无该指数历史日线，改用完整复刻该指数的 SPDR ETF (XOP) 价格" } },
  { code: "161127", ths: "161127.SZ", name: "标普生物科技LOF",    indexSymbol: "XBI",     indexName: "标普生物科技精选行业",     verified: true, noMarketHistory: true,
    proxy: { of: "^SPSIBI", ofName: "标普生物科技精选行业指数", why: "Yahoo 无该指数历史日线，改用完整复刻该指数的 SPDR ETF (XBI) 价格" } }
];

export const BY_CODE = new Map(ETFS.map(e => [e.code, e]));
