/**
 * 本地端到端验证：用真实 API 跑完整管线，检查分级结果是否合理。
 * 用法：FUYAO_KEY=sk-... node worker/test/verify.mjs [代码...]
 */
import { ETFS, BY_CODE } from "../src/etfs.js";
import * as fuyao from "../src/fuyao.js";
import { dailyCloses } from "../src/yahoo.js";
import { buildBaseline, locateLive, TRIGGER_PREMIUM, WINDOW_DAYS, GRADE_LABEL } from "../src/grading.js";

const KEY = process.env.FUYAO_KEY;
if (!KEY) { console.error("需要 FUYAO_KEY 环境变量"); process.exit(1); }

const shDate = ms => {
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
};
const usDate = ms => new Date(ms).toISOString().slice(0, 10);

const codes = process.argv.slice(2);
const targets = codes.length ? codes.map(c => BY_CODE.get(c)).filter(Boolean) : ETFS;

console.log(`\n=== 第一步：拉 ${targets.length} 只快照，筛出当前溢价 > ${TRIGGER_PREMIUM}% 的子集 ===`);
const triggered = [];
for (const e of targets) {
  const [snap, prof] = await Promise.all([fuyao.snapshot(e.ths, KEY), fuyao.profile(e.ths, KEY)]);
  if (!snap?.price || !prof?.nav) { console.log(`  ${e.code} ${e.name}  取数失败`); continue; }
  const prem = (snap.price / prof.nav - 1) * 100;
  const hit = prem > TRIGGER_PREMIUM;
  console.log(`  ${e.code} ${e.name.padEnd(22)} 溢价 ${prem.toFixed(2).padStart(6)}%  ${hit ? "✓ 触发" : "· 未触发"}`);
  if (hit) triggered.push({ e, price: snap.price, nav: prof.nav, prem });
}
console.log(`\n触发计算的标的：${triggered.length} / ${targets.length}`);

const end = Date.now();
const start = end - 200 * 86400 * 1000;   // 拉 200 天，够截出最近 60 个交易日

const idxCache = new Map();
for (const t of triggered.slice(0, codes.length ? 99 : 4)) {
  const { e } = t;
  console.log(`\n${"=".repeat(72)}\n${e.code} ${e.name}   指数 ${e.indexSymbol} (${e.indexName})${e.verified ? "" : "  ⚠️ 映射待核实"}`);

  const [prices, navs] = await Promise.all([
    fuyao.historicalCloses(e.ths, start, end, KEY),
    fuyao.navSeries(e.ths, KEY)
  ]);
  if (!idxCache.has(e.indexSymbol)) idxCache.set(e.indexSymbol, await dailyCloses(e.indexSymbol));
  const usBars = idxCache.get(e.indexSymbol);

  console.log(`  原始样本：价格 ${prices.size} 天 / 净值 ${navs.size} 天 / 指数 ${usBars.length} 根`);

  const base = buildBaseline(prices, navs, usBars);
  if (!base) { console.log("  ✗ 样本不足，跳过"); continue; }

  const s = base.series;
  console.log(`  有效窗口：${s.length} 天  ${shDate(s[0].dateMs)} → ${shDate(s[s.length-1].dateMs)}`);
  base.warnings.forEach(w => console.log(`  ⚠️  ${w}`));

  // 对齐抽查：最后一天的上海交易日 vs 匹配到的美股交易日
  const last = s[s.length - 1];
  console.log(`  对齐抽查：上海 ${shDate(last.dateMs)} → 美股 ${usDate(last.idxDateMs)} 收盘 ${last.idx.toFixed(2)}` +
              `  (应为美股 T-1 或更早)`);

  console.log(`  溢价四分位：Q1 ${base.cuts.premQ1.toFixed(2)}%  中位 ${base.cuts.premMed.toFixed(2)}%  Q3 ${base.cuts.premQ3.toFixed(2)}%`);
  console.log(`  指数四分位：Q1 ${base.cuts.idxQ1.toFixed(0)}  中位 ${base.cuts.idxMed.toFixed(0)}  Q3 ${base.cuts.idxQ3.toFixed(0)}`);
  console.log(`  60日分级占比：A ${base.dist.A}  B ${base.dist.B}  C ${base.dist.C}  D ${base.dist.D}  (合计 ${base.dist.A+base.dist.B+base.dist.C+base.dist.D})`);

  const todayShMidnight = Math.floor((Date.now() + 8*3600*1000) / 86400000) * 86400000 - 8*3600*1000;
  const live = locateLive(base, t.price, t.nav, usBars, todayShMidnight);
  console.log(`  ▶ 盘中估算：价 ${live.price} / 净值 ${live.nav} → 溢价 ${live.prem.toFixed(2)}%`);
  console.log(`    溢价分位 ${live.premPct.toFixed(1)}  指数分位 ${live.idxPct.toFixed(1)} (美股 ${usDate(live.idxDateMs)} 收盘 ${live.idx.toFixed(2)}${live.idxStale ? " ⚠️陈旧" : ""})  →  等级 ${live.grade}`);
  console.log(`    基线覆盖至 ${shDate(live.baselineLastMs)}，净值滞后 ${Math.round((todayShMidnight-live.baselineLastMs)/86400000)} 个日历日`);
  console.log(`    ${GRADE_LABEL[live.grade]}`);

  console.log(`  最近 5 个交易日：`);
  for (const r of s.slice(-5)) {
    console.log(`    ${shDate(r.dateMs)}  收 ${r.close.toFixed(3)}  净值 ${r.nav.toFixed(4)}  溢价 ${r.prem.toFixed(2).padStart(6)}%` +
                `  溢价分位 ${r.premPct.toFixed(0).padStart(3)}  指数分位 ${r.idxPct.toFixed(0).padStart(3)}  ${r.grade}`);
  }
}
