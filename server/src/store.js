/**
 * 存储层：SQLite 键值表。
 *
 * 用 Node 24 内置的 node:sqlite，不引入任何 npm 依赖 —— 与本项目"零依赖"的一贯取向一致，
 * 也让 Docker 镜像不需要编译原生模块。
 *
 * 数据量很小（全量约 200KB，纯 key-value 访问、没有 JOIN 和范围查询），散装 JSON 文件也够用；
 * 选 SQLite 是因为它免费换来三件事：写入原子性（进程被 kill 不会留下半截文件）、
 * 单文件挂卷备份、以及以后要存更长历史时不用换架构。
 *
 * 接口刻意与 Cloudflare KV 保持一致（get/put + expirationTtl），
 * 这样 pipeline 不需要知道底下是 KV 还是 SQLite，测试里也能直接用内存 Map 顶替。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createStore(file = "/data/buypoint.db") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (
        k        TEXT PRIMARY KEY,
        v        TEXT NOT NULL,
        expires  INTEGER,           -- epoch ms；NULL 表示永不过期
        updated  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kv_expires ON kv(expires);
    `);
  } catch (e) {
    // errcode 8 = SQLITE_READONLY，几乎总是宿主机 bind mount 的所有权与容器内非 root
    // 用户（uid 10001）不匹配。用 named volume（docker-compose.yml 默认配置）不会遇到这个问题；
    // 若你手动改成了 bind mount，需要先 `sudo chown -R 10001:10001` 挂载的宿主机目录。
    if (e.errcode === 8 || /readonly database/i.test(e.message)) {
      throw new Error(
        `无法写入数据库 ${file}（SQLITE_READONLY）。这通常是 bind mount 的宿主机目录所有权` +
        `与容器内非 root 用户（uid 10001）不匹配导致的。docker-compose.yml 默认用 named volume ` +
        `规避此问题；若你改成了 bind mount，请先执行 ` +
        `\`sudo chown -R 10001:10001 <宿主机挂载目录>\` 再重启容器。`
      );
    }
    throw e;
  }

  const selectStmt = db.prepare("SELECT v, expires FROM kv WHERE k = ?");
  const upsertStmt = db.prepare(
    `INSERT INTO kv (k, v, expires, updated) VALUES (?, ?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires = excluded.expires, updated = excluded.updated`
  );
  const deleteStmt = db.prepare("DELETE FROM kv WHERE k = ?");
  const sweepStmt = db.prepare("DELETE FROM kv WHERE expires IS NOT NULL AND expires < ?");
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM kv");

  return {
    async get(key, type) {
      const row = selectStmt.get(key);
      if (!row) return null;
      if (row.expires != null && row.expires < Date.now()) { deleteStmt.run(key); return null; }
      return type === "json" ? JSON.parse(row.v) : row.v;
    },

    async put(key, value, opts = {}) {
      const expires = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
      upsertStmt.run(key, typeof value === "string" ? value : JSON.stringify(value), expires, Date.now());
    },

    async delete(key) { deleteStmt.run(key); },

    /** 清掉过期行，定时任务跑完后顺手调一次 */
    sweep() { return sweepStmt.run(Date.now()).changes; },

    stats() { return { keys: countStmt.get().n }; },

    close() { db.close(); }
  };
}
