/**
 * 本地跑通完整管线（SQLite 用内存库）。
 * 用法：FUYAO_KEY=sk-... node test/pipeline.mjs
 */
import { runPipeline } from "../src/pipeline.js";
import { createStore } from "../src/store.js";

if (!process.env.FUYAO_KEY) { console.error("需要 FUYAO_KEY"); process.exit(1); }
const store = createStore(":memory:");
const quiet = process.env.VERBOSE !== "1";
const opts = { kv: store, apiKey: process.env.FUYAO_KEY, force: true,
               log: (l, m) => { if (!quiet || l !== "info") console.log(`   [${l}] ${m}`); } };

function report(tag, r) {
  console.log(`\n${"═".repeat(74)}\n【${tag}】`);
  if (r.skipped) return console.log(`  跳过：${r.reason}（${r.date}）`);
  console.log(`  日期 ${r.date}  交易日 ${r.isTradingDay}  耗时 ${(r.elapsedMs/1000).toFixed(1)}s  上游请求 ${r.requests} 次`);
  console.log(`  标的 ${r.counts.total}  触发 ${r.counts.triggered}  已分级 ${r.counts.graded}  ` +
              `待补 ${r.counts.pending}  不支持 ${r.counts.unsupported}  失败 ${r.counts.error}`);
  console.log(`  基线：新建 ${r.baselines.built.length}  复用 ${r.baselines.reused.length}  失败 ${r.baselines.failed.length}` +
              (r.baselines.failed.length ? `（${r.baselines.failed.join(" ")}）` : ""));
}

const r1 = await runPipeline(opts);
report("第 1 次运行 · 冷启动（应一轮算完）", r1);

console.log("\n分级结果：");
for (const i of r1.items) {
  if (i.status === "ok")
    console.log(`  ${i.code}  ${i.name.padEnd(22)} ${i.prem.toFixed(2).padStart(6)}%  ` +
      `溢价分位 ${i.premPct.toFixed(1).padStart(5)}  指数分位 ${i.idxPct.toFixed(1).padStart(5)}  ${i.grade}` +
      `${i.proxy ? "  [代理]" : ""}${i.indexVerified ? "" : "  ⚠️映射待核实"}`);
  else if (i.status === "not_triggered")
    console.log(`  ${i.code}  ${i.name.padEnd(22)} ${i.prem.toFixed(2).padStart(6)}%  —— 未触发（≤${i.threshold}%）`);
  else
    console.log(`  ${i.code}  ${i.name.padEnd(22)} ${i.status}：${i.message || ""}`);
}

const r2 = await runPipeline(opts);
report("第 2 次运行 · 当日缓存命中（请求数应大幅下降）", r2);

const anyOk = r2.items.find(i => i.status === "ok");
if (anyOk) {
  const det = await store.get(`detail:${anyOk.code}`, "json");
  const bar = n => "█".repeat(n);
  console.log(`\n明细 detail:${anyOk.code} —— 序列 ${det.series.length} 天`);
  console.log(`  分级占比  A${bar(det.dist.A)} ${det.dist.A}  B${bar(det.dist.B)} ${det.dist.B}  ` +
              `C${bar(det.dist.C)} ${det.dist.C}  D${bar(det.dist.D)} ${det.dist.D}`);
}
console.log(`\n存储：${JSON.stringify(store.stats())}`);
