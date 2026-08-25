/**
 * 北京时间定时调度，零依赖。
 *
 * 不用系统 cron，也不引 node-cron：调度时刻要按 Asia/Shanghai 判断，而容器时区通常是 UTC。
 * 这里直接按东八区偏移算下一次触发时刻，与宿主机时区无关，容器不需要装 tzdata。
 */
const SH_OFFSET = 8 * 3600 * 1000;

/** 北京时间每个工作日的触发时刻（午间休市 11:30–13:00 不跑） */
export const DEFAULT_TIMES = ["09:30", "10:30", "11:30", "13:30", "14:30", "15:00"];

/** 距离下一个触发时刻还有多少毫秒 */
export function msUntilNext(times = DEFAULT_TIMES, now = Date.now()) {
  const sh = now + SH_OFFSET;
  const dayStart = Math.floor(sh / 86400000) * 86400000;
  const mins = times.map(t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; }).sort((a, b) => a - b);

  for (let d = 0; d < 8; d++) {
    const base = dayStart + d * 86400000;
    const dow = new Date(base).getUTCDay();          // base 已是东八区零点，getUTCDay 即北京星期
    if (dow === 0 || dow === 6) continue;            // 周末不跑；法定节假日由管线内的交易日历判断
    for (const m of mins) {
      const fire = base + m * 60000;
      if (fire > sh) return fire - sh;
    }
  }
  return 3600000;
}

/** 下一次触发的北京时间，仅用于日志 */
export function nextFireText(times = DEFAULT_TIMES, now = Date.now()) {
  const d = new Date(now + msUntilNext(times, now) + SH_OFFSET);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (北京时间)`;
}

export function startScheduler(times, task, log = console.log) {
  let timer = null, stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await task(); } catch (e) { log("调度任务异常：" + (e?.stack || e?.message)); }
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    const wait = msUntilNext(times);
    log(`下一次计算：${nextFireText(times)}（${Math.round(wait / 60000)} 分钟后）`);
    timer = setTimeout(tick, wait);
  };
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
