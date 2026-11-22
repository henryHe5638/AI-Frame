import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, "../data");
export const DB_PATH = path.join(DATA_DIR, "app.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  immichId TEXT NOT NULL UNIQUE,
  fileName TEXT,
  takenAt TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  width INTEGER,
  height INTEGER,
  clarity INTEGER,
  beauty INTEGER,
  story INTEGER,
  totalScore INTEGER,
  reason TEXT,
  auditStatus TEXT NOT NULL DEFAULT 'pending',   -- pending | auditing | passed | rejected | failed
  composeStatus TEXT NOT NULL DEFAULT 'pending', -- pending | composing | done | failed
  instruction TEXT,                              -- compose JSON 指令（文本）
  error TEXT,
  createdLocalAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedLocalAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_takenAt ON photos(takenAt);
CREATE INDEX IF NOT EXISTS idx_photos_auditStatus ON photos(auditStatus);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// 迁移：photos 增加 duplicateGroupId（重复照片分组，可空；同组共享组 id）
const photoCols = db.prepare("PRAGMA table_info(photos)").all() as Array<{ name: string }>;
if (!photoCols.some((c) => c.name === "duplicateGroupId")) {
  db.exec("ALTER TABLE photos ADD COLUMN duplicateGroupId TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_photos_duplicateGroupId ON photos(duplicateGroupId)");

// 迁移：photos 增加 dhash（本地差异哈希，16 位十六进制，可空）
if (!photoCols.some((c) => c.name === "dhash")) {
  db.exec("ALTER TABLE photos ADD COLUMN dhash TEXT");
}

// 迁移：photos 增加 dhashFailed（相似分析失败标记，0/1）
if (!photoCols.some((c) => c.name === "dhashFailed")) {
  db.exec("ALTER TABLE photos ADD COLUMN dhashFailed INTEGER NOT NULL DEFAULT 0");
}

// 迁移：photos 增加拍摄地点（来自 Immich exifInfo，可空）
for (const col of ["city", "state", "country"]) {
  if (!photoCols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE photos ADD COLUMN ${col} TEXT`);
  }
}

// 迁移：photos 增加用户评价（auditVote / composeVote：like | dislike | null）
for (const col of ["auditVote", "composeVote"]) {
  if (!photoCols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE photos ADD COLUMN ${col} TEXT`);
  }
}

// 迁移：photos 增加评分/装裱完成时间（排序用；重跑对应环节时清空）
let timeColsAdded = false;for (const col of ["auditedAt", "composedAt"]) {
  if (!photoCols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE photos ADD COLUMN ${col} TEXT`);
    timeColsAdded = true;
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_photos_auditedAt ON photos(auditedAt)");
db.exec("CREATE INDEX IF NOT EXISTS idx_photos_composedAt ON photos(composedAt)");
// 仅在新增列时回填一次：老数据没有独立时间戳，用最后更新时间近似
if (timeColsAdded) {
  db.prepare(
    "UPDATE photos SET auditedAt=updatedLocalAt WHERE auditedAt IS NULL AND totalScore IS NOT NULL"
  ).run();
  db.prepare(
    "UPDATE photos SET composedAt=updatedLocalAt WHERE composedAt IS NULL AND composeStatus='done' AND instruction IS NOT NULL"
  ).run();
}

// 迁移：photos 增加 cartoonImage（漫画化生成的本地图片文件名，存于 data/cartoon/，可空）
if (!photoCols.some((c) => c.name === "cartoonImage")) {
  db.exec("ALTER TABLE photos ADD COLUMN cartoonImage TEXT");
}

// 迁移：photos 增加 cartoonStatus（漫画化队列状态：pending | cartoonizing | done | failed，NULL = 未漫画化）
if (!photoCols.some((c) => c.name === "cartoonStatus")) {
  db.exec("ALTER TABLE photos ADD COLUMN cartoonStatus TEXT");
}

// 迁移：photos 增加 cartoonedAt（漫画化完成时间，排序用）；已有漫画图按文件修改时间回填
if (!photoCols.some((c) => c.name === "cartoonedAt")) {
  db.exec("ALTER TABLE photos ADD COLUMN cartoonedAt TEXT");
  try {
    const dir = path.join(DATA_DIR, "cartoon");
    const rows = db.prepare("SELECT id FROM photos WHERE cartoonImage IS NOT NULL").all() as Array<{ id: number }>;
    const backfill = db.prepare("UPDATE photos SET cartoonedAt=? WHERE id=?");
    for (const r of rows) {
      try {
        const st = fs.statSync(path.join(dir, `${r.id}.jpg`));
        backfill.run(new Date(st.mtimeMs).toISOString().replace("T", " ").slice(0, 19), r.id);
      } catch { /* 文件缺失则留空 */ }
    }
  } catch { /* 回填失败不阻塞启动 */ }
}

// 用户表：登录鉴权（存在任一用户即强制全站登录）
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  passHash TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// 迁移：旧版单用户设置（settings.authUser/authPassHash）迁入 users 表
{
  const cnt = (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
    | { value: string }
    | undefined;
  if (cnt === 0 && row) {
    try {
      const s = JSON.parse(row.value) as { authUser?: string; authPassHash?: string };
      if (s.authUser && s.authPassHash) {
        db.prepare("INSERT INTO users (username, passHash) VALUES (?, ?)").run(
          s.authUser,
          s.authPassHash
        );
        console.log(`[auth] 旧版单用户配置已迁入用户表：${s.authUser}`);
      }
    } catch {
      // 忽略坏数据
    }
  }
}

// 装裱反馈表：记录赞/踩当时的指令快照，供 AI 学习
db.exec(`
CREATE TABLE IF NOT EXISTS compose_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photoId INTEGER NOT NULL,
  vote TEXT NOT NULL,           -- like | dislike
  instruction TEXT,             -- 当时的装裱指令 JSON 快照
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_compose_feedback_photo ON compose_feedback(photoId);
CREATE INDEX IF NOT EXISTS idx_compose_feedback_createdAt ON compose_feedback(createdAt);
`);

// AI 记忆表：赞/踩记录定期由 AI 总结成简短偏好记忆，注入提示词（比逐条塞样例省上下文）
db.exec(`
CREATE TABLE IF NOT EXISTS ai_memory (
  key TEXT PRIMARY KEY,          -- 例如 'compose' / 'audit' / 'composeFeedbackCursor'
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// 审核反馈表：赞/踩当时的原始分数与阈值快照，供 AI 总结审核偏好
db.exec(`
CREATE TABLE IF NOT EXISTS audit_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photoId INTEGER NOT NULL,
  vote TEXT NOT NULL,            -- like | dislike
  clarity INTEGER,
  beauty INTEGER,
  story INTEGER,
  totalScore INTEGER,
  reason TEXT,
  thresholdClarity INTEGER,
  thresholdBeauty INTEGER,
  thresholdStory INTEGER,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_feedback_createdAt ON audit_feedback(createdAt);
`);

// 数据修复：旧版本误用 Immich /preview 接口导致的 404 失败记录，重置为待审核并清理错误
db.prepare(
  `UPDATE photos SET auditStatus='pending', updatedLocalAt=datetime('now')
   WHERE auditStatus='failed' AND error LIKE '%/preview?size=preview%'`
).run();
db.prepare(
  `UPDATE photos SET error=NULL, updatedLocalAt=datetime('now')
   WHERE error LIKE '%/preview?size=preview%'`
).run();

export function getSyncState(key: string): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSyncState(key: string, value: string): void {
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function touchPhoto(id: number): void {
  db.prepare("UPDATE photos SET updatedLocalAt = datetime('now') WHERE id = ?").run(id);
}
