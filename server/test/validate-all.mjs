/**
 * 全量校验所有标的的底层指数映射。
 * 判据：基金净值日收益率 与 配置指数（折人民币）日收益率的相关性。
 * 参考量级：真正同源的映射应在 0.99 以上（513100 对 ^NDX 实测 0.9982）。
 */
import { ETFS } from "../src/etfs.js";
import * as fuyao from "../src/fuyao.js";
import { dailyCloses, indexSeriesFor } from "../src/yahoo.js";

const K = process.env.FUYAO_KEY;
const shDate = ms => { const d = new Date(ms + 8*3600*1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`; };
const pearson = (a,b) => { const n=a.length, ma=a.reduce((x,y)=>x+y,0)/n, mb=b.reduce((x,y)=>x+y,0)/n;
  let s=0,da=0,db=0; for(let i=0;i<n;i++){const x=a[i]-ma,y=b[i]-mb;s+=x*y;da+=x*x;db+=y*y;} return s/Math.sqrt(da*db); };
const rets = a => a.slice(1).map((v,i)=>v/a[i]-1);

const fx = new Map((await dailyCloses("CNY=X","6mo")).map(b=>[new Date(b.tsMs).toISOString().slice(0,10),b.close]));
const idxCache = new Map();

console.log("代码    名称                    指数配置              样本  相关性   判定");
console.log("─".repeat(84));
const rows = [];
for (const e of ETFS) {
  try {
    const navs = await fuyao.navSeries(e.ths, K);
    const navRows = [...navs.entries()].sort((a,b)=>a[0]-b[0]).slice(-70);
    if (!idxCache.has(e.indexSymbol)) idxCache.set(e.indexSymbol,
      new Map((await indexSeriesFor(e)).map(b=>[new Date(b.tsMs).toISOString().slice(0,10), b.close])));
    const im = idxCache.get(e.indexSymbol);

    const nv=[], ix=[];
    for (const [ms,nav] of navRows){ const k=shDate(ms), c=im.get(k), f=fx.get(k);
      if(c==null||f==null) continue; nv.push(nav); ix.push(c*f); }
    if (nv.length < 20) { console.log(`${e.code}  ${e.name.padEnd(20)} ${e.indexSymbol.padEnd(20)} 样本不足 ${nv.length}`); continue; }
    const r = pearson(rets(nv), rets(ix));
    const verdict = r >= 0.99 ? "✓ 吻合" : r >= 0.95 ? "○ 可接受" : r >= 0.85 ? "⚠️ 偏低，建议复核" : "✗ 疑似错配";
    rows.push({ e, r, n: nv.length, verdict });
    console.log(`${e.code}  ${e.name.padEnd(20)} ${e.indexSymbol.padEnd(20)} ${String(nv.length).padStart(4)}  ${r.toFixed(4)}  ${verdict}`);
  } catch (err) {
    console.log(`${e.code}  ${e.name.padEnd(20)} ${(e.indexSymbol||"").padEnd(20)} 取数失败：${err.message.slice(0,40)}`);
  }
}
const bad = rows.filter(r => r.r < 0.95);
console.log("─".repeat(84));
console.log(bad.length ? `\n需要复核 ${bad.length} 只：${bad.map(b=>b.e.code).join(" ")}` : "\n全部映射通过（相关性均 ≥ 0.95）");
