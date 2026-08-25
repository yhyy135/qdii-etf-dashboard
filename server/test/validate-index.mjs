/**
 * 底层指数映射的实证校验。
 *
 * 思路：基金净值跟踪的就是底层指数（折人民币、扣费后），日收益率应当高度相关。
 * 相关性最高的那个候选，就是真正的底层指数 —— 用测量代替猜测。
 *
 * 对齐口径要特别注意（踩过坑）：QDII 净值标注的日期 D 对应的是**美股同日 D** 的收盘，
 * 不是 D-1。美股 D 场收在北京时间 D+1 凌晨，但基金公司仍按估值日 D 标注净值。
 * 实证：513100 净值 08-18 跌 1.64%，美股 ^NDX 08-18 那根跌 1.68%（08-17 那根只跌 0.17%）。
 * 若按 D-1 配对，相关性会掉到 -0.05，看起来像"完全不相关"。
 *
 * 注意这与 grading.js 里 alignIndexClose 的用途不同：那里回答的是"上海 D 日开盘时，
 * 市场已知的最近一次美股收盘是哪根"（答案是 D-1），用于指数维度；这里回答的是
 * "净值 D 反映的是哪根"（答案是 D），用于识别指数身份。两者都对，不要混用。
 *
 * 用法：FUYAO_KEY=sk-... node test/validate-index.mjs <基金代码> <候选ticker...>
 */
import * as fuyao from "../src/fuyao.js";
import { dailyCloses } from "../src/yahoo.js";

import { BY_CODE } from "../src/etfs.js";

const K = process.env.FUYAO_KEY;
const [code, ...cands] = process.argv.slice(2);
const meta = BY_CODE.get(code);
if (!K || !code) { console.error("用法: FUYAO_KEY=... node test/validate-index.mjs <代码> [候选...]"); process.exit(1); }

const shDate = ms => {
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
};

const pearson = (a, b) => {
  const n = a.length, ma = a.reduce((x,y)=>x+y,0)/n, mb = b.reduce((x,y)=>x+y,0)/n;
  let num=0, da=0, db=0;
  for (let i=0;i<n;i++){ const x=a[i]-ma, y=b[i]-mb; num+=x*y; da+=x*x; db+=y*y; }
  return num / Math.sqrt(da*db);
};
const rets = arr => arr.slice(1).map((v,i) => v/arr[i]-1);

console.log(`\n标的 ${code} ${meta?.name || ""}   当前配置: ${meta?.indexSymbol}${meta?.verified===false ? "  ⚠️未核实" : ""}\n`);

// 基金净值序列（人民币计价）
const navMap = await fuyao.navSeries(meta.ths, K);
const navRows = [...navMap.entries()].sort((a,b)=>a[0]-b[0]).slice(-70);
console.log(`净值样本 ${navRows.length} 天\n`);

// 美元兑人民币，用于把美元指数折成人民币口径，与净值可比
const fx = await dailyCloses("CNY=X", "6mo");

const results = [];
for (const sym of cands) {
  try {
    const bars = await dailyCloses(sym, "6mo");
    // 按"同一日历日"配对：净值日 D ↔ 美股日 D
    const byDate = new Map(bars.map(b => [new Date(b.tsMs).toISOString().slice(0, 10), b.close]));
    const fxByDate = new Map(fx.map(b => [new Date(b.tsMs).toISOString().slice(0, 10), b.close]));
    const navSeq = [], idxUsd = [], idxCny = [];
    for (const [dateMs, nav] of navRows) {
      const key = shDate(dateMs);
      const c = byDate.get(key), f = fxByDate.get(key);
      if (c == null || f == null) continue;
      navSeq.push(nav); idxUsd.push(c); idxCny.push(c * f);
    }
    if (navSeq.length < 20) { console.log(`${sym.padEnd(12)} 对齐样本不足`); continue; }
    const rNav = rets(navSeq);
    const rCny = pearson(rNav, rets(idxCny));
    const rUsd = pearson(rNav, rets(idxUsd));
    results.push({ sym, rCny, rUsd, n: navSeq.length });
  } catch (e) { console.log(`${sym.padEnd(12)} 取数失败: ${e.message}`); }
}

results.sort((a,b) => b.rCny - a.rCny);
console.log("候选指数        样本   与净值日收益相关性");
console.log("                       折人民币    原始美元");
for (const r of results) {
  const mark = r.rCny > 0.97 ? "  ★ 高度吻合" : r.rCny > 0.9 ? "  ○ 接近" : r.rCny > 0.7 ? "  · 相关但不是它" : "  ✗ 不相关";
  console.log(`${r.sym.padEnd(14)} ${String(r.n).padStart(4)}   ${r.rCny.toFixed(4).padStart(8)}   ${r.rUsd.toFixed(4).padStart(8)}${mark}`);
}
