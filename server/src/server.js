/**
 * HTTP 入口：对外提供分级 JSON，同时把看板本体也一并托管。
 *
 * 同源托管是有意为之 —— 看板和 API 在同一个域名下，既不需要 CORS，也不会触发混合内容拦截，
 * 前端连"分级服务地址"都不用填。跨域仍然放开，方便看板部署在别处（如 Cloudflare Pages）。
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createStore } from "./store.js";
import { runPipeline } from "./pipeline.js";
import { startScheduler, DEFAULT_TIMES, nextFireText } from "./scheduler.js";

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "0.0.0.0";
const DB_FILE = process.env.DB_FILE || "/data/buypoint.db";
const PUBLIC_DIR = process.env.PUBLIC_DIR || new URL("../public/", import.meta.url).pathname;
const API_KEY = process.env.FUYAO_API_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const TIMES = (process.env.SCHEDULE_TIMES || DEFAULT_TIMES.join(",")).split(",").map(s => s.trim());
const RUN_ON_BOOT = process.env.RUN_ON_BOOT !== "0";

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (level, msg) => console.log(`${ts()} [${level}] ${msg}`);

const store = createStore(DB_FILE);
let running = null;         // 同一时刻只允许一个计算任务，避免调度与手动触发撞车

async function compute({ force = false } = {}) {
  if (running) { log("info", "已有计算在进行，复用该次结果"); return running; }
  running = runPipeline({ kv: store, apiKey: API_KEY, force, log })
    .catch(async (err) => {
      log("error", `计算失败：${err.message}`);
      await store.put("lastError", { at: Date.now(), message: err.message });
      throw err;
    })
    .finally(() => { running = null; });
  return running;
}

/* ── 响应工具 ───────────────────────────────────────────────────────────
   Cache-Control 是给 Cloudflare 看的：分级结果允许 CDN 缓存 60 秒（大幅削减回源），
   健康检查和手动触发必须 no-store，否则 CDN 会把结果缓存下来发给别人。 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};
function json(res, obj, status = 200, cache = "no-store") {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": cache,
    ...CORS
  });
  res.end(body);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".webmanifest": "application/manifest+json" };

async function serveStatic(res, urlPath) {
  // normalize + 前缀校验，挡掉 ../ 穿越
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel === "/" || rel === "." ? "etf-dashboard.html" : rel);
  if (!file.startsWith(normalize(PUBLIC_DIR))) { json(res, { error: "forbidden" }, 403); return; }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    const buf = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Content-Length": buf.length,
      // 看板本体不长期缓存，改完重启就能生效
      "Cache-Control": "public, max-age=0, must-revalidate"
    });
    res.end(buf);
  } catch {
    json(res, { error: "not found" }, 404);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  try {
    if (path === "/api/buypoint" && req.method === "GET") {
      const data = await store.get("latest", "json");
      if (!data) return json(res, { error: "尚无数据，等待首次计算完成" }, 503);
      return json(res, data, 200, "public, max-age=60, s-maxage=60");
    }

    const m = path.match(/^\/api\/buypoint\/(\d{6})$/);
    if (m && req.method === "GET") {
      const code = m[1];
      const data = await store.get(`detail:${code}`, "json");
      if (data) return json(res, data, 200, "public, max-age=60, s-maxage=60");

      const latest = await store.get("latest", "json");
      const it = latest?.items?.find(i => i.code === code);
      if (!it) return json(res, { error: `未知标的 ${code}` }, 404);
      const why = {
        not_triggered: `当前溢价 ${it.prem?.toFixed(2)}%，未超过 ${it.threshold}% 阈值，未触发分级计算`,
        unsupported: it.message || "该品种不支持分级计算",
        pending: it.message || "基线暂不可用",
        error: it.message || "计算失败"
      }[it.status] || "暂无分级明细";
      return json(res, { error: why, code, status: it.status, name: it.name }, 404);
    }

    // 净值/规模/基金公司/年涨跌幅：一天只变一次，前端页面加载时读一次即可，不必每次点
    // 刷新都直连 Fuyao 重拉。max-age 给到 5 分钟——数据实际上一天才变一次，但留短一点
    // 的缓存期方便部署后很快就能通过重新访问验证到最新结果，不必死等一整天。
    if (path === "/api/fund-info" && req.method === "GET") {
      const data = await store.get("fundinfo", "json");
      if (!data || !data.items || !Object.keys(data.items).length)
        return json(res, { error: "尚无数据，等待首次计算完成" }, 503);
      return json(res, data, 200, "public, max-age=300, s-maxage=300");
    }

    if (path === "/health") {
      const data = await store.get("latest", "json");
      const info = await store.get("fundinfo", "json");
      const err = await store.get("lastError", "json");
      return json(res, {
        ok: true, service: "etf-buypoint",
        hasData: !!data, updatedAt: data?.updatedAt || null, date: data?.date || null,
        counts: data?.counts || null, computing: !!running,
        fundInfo: { updatedAt: info?.updatedAt || null, count: info ? Object.keys(info.items || {}).length : 0 },
        nextRun: nextFireText(TIMES), store: store.stats(), lastError: err || null
      });
    }

    // 手动触发。用 POST + Authorization 头，不用 GET+query —— 口令写在 URL 里会进
    // Cloudflare 的访问日志和分析面板，而且 GET 响应可能被 CDN 缓存后发给别人。
    if (path === "/api/refresh") {
      if (req.method !== "POST") return json(res, { error: "请用 POST" }, 405);
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!ADMIN_TOKEN || auth !== ADMIN_TOKEN) return json(res, { error: "unauthorized" }, 401);
      const r = await compute({ force: url.searchParams.get("force") === "1" });
      return json(res, { ok: true, ...r, items: undefined, itemCount: r.items?.length });
    }

    if (req.method === "GET") return serveStatic(res, path);
    json(res, { error: "not found" }, 404);
  } catch (e) {
    log("error", `${path} 处理异常：${e.stack || e.message}`);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, HOST, () => {
  log("info", `监听 ${HOST}:${PORT}  数据库 ${DB_FILE}`);
  log("info", `调度时刻（北京时间）：${TIMES.join(" ")}`);
  if (!API_KEY) log("warn", "未设置 FUYAO_API_KEY，计算会失败");
  if (!ADMIN_TOKEN) log("warn", "未设置 ADMIN_TOKEN，/api/refresh 不可用");
});

startScheduler(TIMES, () => compute(), m => log("info", m));

if (RUN_ON_BOOT) {
  store.get("latest", "json").then(d => {
    // 冷启动或数据过夜就立刻算一次，不用干等到下一个调度点
    if (!d || Date.now() - d.updatedAt > 6 * 3600 * 1000) {
      log("info", "启动时无最新数据，立即计算一次");
      compute({ force: true }).catch(() => {});
    }
  });
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log("info", `收到 ${sig}，正在关闭`);
    server.close(() => { store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
