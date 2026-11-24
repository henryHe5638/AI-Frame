import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { db, DB_PATH, DATA_DIR } from "../db.js";
import { buildZip, extractZip, type ZipEntry } from "../zip.js";
import {
  getSettings,
  updateSettings,
  publicSettings,
  type SettingsPatch,
} from "../config.js";
import { groupLocalDuplicates } from "../localDedup.js";
import { applyGroupDedupNow, recomputeAuditVerdicts } from "../queue.js";
import { getMemory, regenerateMemory, pendingFeedback } from "../memory.js";
import { listModels } from "../ai.js";
import { listCustomFonts } from "../fonts.js";
import {
  authenticate,
  authRequired,
  changePassword,
  createUser,
  deleteUser,
  issueSession,
  listUsers,
  sessionFromCookieHeader,
  verifySession,
  SESSION_COOKIE_NAME,
} from "../auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const patchSchema = z
  .object({
    immichBaseUrl: z.string().optional(),
    immichApiKey: z.string().optional(),
    pollIntervalSec: z.number().int().min(10).max(86400).optional(),
    webhookEnabled: z.boolean().optional(),
    auditPaused: z.boolean().optional(),
    composePaused: z.boolean().optional(),
    dhashPaused: z.boolean().optional(),
    frameFit: z.enum(["contain", "cover", "stretch"]).optional(),
    frameShowClock: z.boolean().optional(),
    frameShowCalendar: z.boolean().optional(),
    publicBaseUrl: z.string().optional(),
    frameClockLayout: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        scale: z.number().min(0.4).max(3),
      })
      .nullable()
      .optional(),
    frameCalendarLayout: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        scale: z.number().min(0.4).max(3),
      })
      .nullable()
      .optional(),
    framePreferAspect: z.boolean().optional(),
    frameIntervalSec: z.number().int().min(2).max(3600).optional(),
    amapKey: z.string().optional(),
    amapSecurityCode: z.string().optional(),
    dedupEnabled: z.boolean().optional(),
    localDedupEnabled: z.boolean().optional(),
    localDedupThreshold: z.number().int().min(0).max(32).optional(),
    localDedupWindowMin: z.number().int().min(1).max(10080).optional(),
    clarityThreshold: z.number().min(1).max(10).optional(),
    beautyThreshold: z.number().min(1).max(10).optional(),
    storyThreshold: z.number().min(1).max(10).optional(),
    auditConcurrency: z.number().int().min(1).max(16).optional(),
    composeConcurrency: z.number().int().min(1).max(16).optional(),
    dhashConcurrency: z.number().int().min(1).max(32).optional(),
    cartoonConcurrency: z.number().int().min(1).max(8).optional(),
    cartoonPaused: z.boolean().optional(),
    cartoonRatio: z.number().min(0.01).max(1).optional(),
    auditBatchSize: z.number().int().min(1).max(30).optional(),
    composeBatchSize: z.number().int().min(1).max(10).optional(),
    memoryEnabled: z.boolean().optional(),
    memoryThreshold: z.number().int().min(1).max(50).optional(),
    memoryComposePrompt: z.string().optional(),
    memoryAuditPrompt: z.string().optional(),
    audit: z
      .object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        model: z.string().optional(),
        prompt: z.string().optional(),
        thinking: z.enum(["default", "on", "off"]).optional(),
      })
      .optional(),
    compose: z
      .object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        model: z.string().optional(),
        prompt: z.string().optional(),
        thinking: z.enum(["default", "on", "off"]).optional(),
        cartoonEnabled: z.boolean().optional(),
        cartoonModel: z.string().optional(),
        cartoonPrompt: z.string().optional(),
      })
      .optional(),
  })
  .strict();

/** 脱敏值（"****" 前缀）表示“未修改”，从 patch 中剔除 */
function stripMasked(patch: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = { ...patch };
  if (out.immichApiKey?.startsWith("****")) delete out.immichApiKey;
  for (const g of ["audit", "compose"] as const) {
    const group = out[g];
    if (group?.apiKey?.startsWith("****")) {
      const { apiKey: _drop, ...rest } = group;
      out[g] = rest;
      if (Object.keys(rest).length === 0) delete out[g];
    }
  }
  return out;
}

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // 允许 POST /api/import/zip 直接以 application/octet-stream 上传备份文件（避免引入 multipart 依赖）
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  /** 获取设置（API key 脱敏，只回后 4 位）；附带审核/装裱审美记忆与待学习反馈数 */
  app.get("/api/settings", async () => ({
    ...publicSettings(),
    composeMemory: getMemory("compose"),
    auditMemory: getMemory("audit"),
    composeFeedbackPending: pendingFeedback("compose"),
    auditFeedbackPending: pendingFeedback("audit"),
  }));

  /** 手动重新生成审美记忆（kind=compose 装裱 / audit 审核） */
  app.post<{ Params: { kind: string } }>("/api/settings/memory/:kind/regenerate", async (req, reply) => {
    const kind = req.params.kind;
    if (kind !== "compose" && kind !== "audit") return reply.code(400).send({ error: "kind 只能是 compose 或 audit" });
    const r = await regenerateMemory(kind);
    if (!r.ok) return reply.code(400).send({ error: r.error ?? "生成失败" });
    return reply.send({ ok: true, memory: r.memory });
  });

  /** 拉取模型列表（GET {baseUrl}/models），供设置页下拉选择；group=audit|compose */
  app.get<{ Querystring: { group?: string } }>("/api/models", async (req, reply) => {
    const group = req.query.group === "compose" ? "compose" : "audit";
    try {
      const models = await listModels(group, getSettings());
      return reply.send({ models });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 登录状态查询（前端据此决定是否跳登录页） */
  app.get("/api/auth/me", async (req) => {
    const session = verifySession(sessionFromCookieHeader(req.headers.cookie));
    return { authRequired: authRequired(), authed: !!session, user: session?.username ?? null };
  });

  /** 登录：校验用户名密码，签发 httpOnly 会话 cookie（7 天） */
  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    if (!authRequired()) return reply.send({ ok: true });
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return reply.code(400).send({ error: "参数错误" });
    }
    const user = authenticate(body.username, body.password);
    if (!user) return reply.code(401).send({ error: "用户名或密码错误" });
    const { token, maxAgeSec } = issueSession(user);
    reply.header(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
    );
    return reply.send({ ok: true });
  });

  /** 登出：清会话 cookie */
  app.post("/api/auth/logout", async (_req, reply) => {
    reply.header("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return reply.send({ ok: true });
  });

  /** 用户列表（用户名与创建时间，不含哈希） */
  app.get("/api/auth/users", async () => ({ users: listUsers() }));

  /** 创建用户（无任何用户时为初始化，允许未登录调用——此时全局钩子本来就放行） */
  app.post("/api/auth/users", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return reply.code(400).send({ error: "参数错误" });
    }
    const r = createUser(body.username, body.password);
    if (r.error) return reply.code(400).send({ error: r.error });
    return reply.send({ ok: true, users: listUsers() });
  });

  /** 删除用户（不允许删除最后一个） */
  app.delete<{ Params: { id: string } }>("/api/auth/users/:id", async (req, reply) => {
    const r = deleteUser(Number(req.params.id));
    if (r.error) return reply.code(400).send({ error: r.error });
    return reply.send({ ok: true, users: listUsers() });
  });

  /** 修改自己的密码 */
  app.post("/api/auth/password", async (req, reply) => {
    const session = verifySession(sessionFromCookieHeader(req.headers.cookie));
    if (!session) return reply.code(401).send({ error: "未登录" });
    const body = (req.body ?? {}) as { password?: string };
    if (typeof body.password !== "string") return reply.code(400).send({ error: "参数错误" });
    const r = changePassword(session.userId, body.password);
    if (r.error) return reply.code(400).send({ error: r.error });
    return reply.send({ ok: true });
  });

  /** 自定义字体列表（server/data/fonts/ 目录下的字体文件，供装裱题字使用） */
  app.get("/api/fonts", async () => ({ fonts: listCustomFonts() }));

  /** 更新设置（部分更新，合并到现有配置） */
  app.put("/api/settings", async (req, reply) => {
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const prev = getSettings();
    const settings = updateSettings(stripMasked(parsed.data));
    // 通过阈值变化后按新阈值重判所有已评分照片（通过/淘汰随设置即时生效）
    if (
      prev.clarityThreshold !== settings.clarityThreshold ||
      prev.beautyThreshold !== settings.beautyThreshold ||
      prev.storyThreshold !== settings.storyThreshold
    ) {
      try {
        const r = recomputeAuditVerdicts();
        console.log(`[settings] 阈值变更重判：转通过 ${r.toPassed} 张，转淘汰 ${r.toRejected} 张`);
      } catch (e) {
        console.warn(`[settings] 阈值重判失败（已忽略）: ${(e as Error).message}`);
      }
    }
    // 相似阈值/时间窗口变化后按新参数全量重新分组（异步，不阻塞响应）
    if (
      parsed.data.localDedupThreshold !== undefined ||
      parsed.data.localDedupWindowMin !== undefined
    ) {
      void Promise.resolve().then(() => {
        try {
          const groups = groupLocalDuplicates();
          const dedup = applyGroupDedupNow();
          console.log(`[localDedup] 参数变更重新分组：${groups} 组，标记重复 ${dedup.marked} 张`);
        } catch (e) {
          console.warn(`[localDedup] 重新分组失败（已忽略）: ${(e as Error).message}`);
        }
      });
    }
    return reply.send({
      ...publicSettings(settings),
      composeMemory: getMemory("compose"),
      auditMemory: getMemory("audit"),
      composeFeedbackPending: pendingFeedback("compose"),
      auditFeedbackPending: pendingFeedback("audit"),
    });
  });

  /** 备份文件名（yyyymmdd） */
  const backupStamp = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "");

  /** 收集卡通画目录下的所有文件为 zip 条目（cartoon/<文件名>） */
  function collectCartoonEntries(): ZipEntry[] {
    const dir = path.join(DATA_DIR, "cartoon");
    if (!fs.existsSync(dir)) return [];
    const out: ZipEntry[] = [];
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isFile()) out.push({ name: `cartoon/${f}`, data: fs.readFileSync(fp) });
    }
    return out;
  }

  /**
   * 导出备份 zip（deflate 压缩）：app.db（含全部设置与照片数据）+ cartoon/ 下所有卡通画。
   * 导出前先 TRUNCATE checkpoint 把 WAL 合并回主库，保证库文件完整一致。
   */
  app.get("/api/export/zip", async (_req, reply) => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    const zip = buildZip([{ name: "app.db", data: fs.readFileSync(DB_PATH) }, ...collectCartoonEntries()]);
    reply.header("Content-Disposition", `attachment; filename="ai-art-frame-backup-${backupStamp()}.zip"`);
    return reply.type("application/zip").send(zip);
  });

  /**
   * 导入备份 zip（body 为 application/octet-stream 的 zip 文件）。
   * query: overwriteSettings=true 用备份里的设置整体覆盖（含 API Key）；
   *        默认 false，保留当前设置（含全部 API Key），只恢复照片数据与卡通画。
   * 流程：解析校验 zip → 校验 app.db → 备份当前库与卡通画目录 → 落盘新库与卡通画 →
   * （可选）把当前设置写回新库 → 返回 {ok, restartRequired} 后自动重启（看门狗 touch src/index.ts 触发 tsx watch 重跑）。
   */
  app.post<{ Querystring: { overwriteSettings?: string } }>("/api/import/zip", async (req, reply) => {
    const overwriteSettings = req.query.overwriteSettings === "true";
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 22) {
      return reply.code(400).send({ ok: false, error: "body 需为备份 zip 文件（application/octet-stream）" });
    }

    let entries: ZipEntry[];
    try {
      entries = extractZip(body);
    } catch (e) {
      return reply.code(400).send({ ok: false, error: `zip 解析失败：${(e as Error).message}` });
    }
    const dbEntry = entries.find((e) => e.name === "app.db");
    if (!dbEntry || dbEntry.data.length < 16) {
      return reply.code(400).send({ ok: false, error: "备份包中缺少 app.db" });
    }
    if (dbEntry.data.subarray(0, 15).toString("latin1") !== "SQLite format 3") {
      return reply.code(400).send({ ok: false, error: "备份包中的 app.db 不是合法的 SQLite 文件" });
    }
    // 写入临时文件后用 better-sqlite3 试开，确认文件结构可读
    const tmpPath = path.join(path.dirname(DB_PATH), `.import-${Date.now()}.db`);
    fs.writeFileSync(tmpPath, dbEntry.data);
    try {
      const probe = new Database(tmpPath, { readonly: true });
      probe.pragma("schema_version");
      probe.close();
    } catch {
      fs.rmSync(tmpPath, { force: true });
      return reply.code(400).send({ ok: false, error: "备份包中的 SQLite 文件损坏或无法打开" });
    }
    fs.rmSync(tmpPath, { force: true });

    // 卡通画条目：zip slip 防护，只取文件名部分
    const cartoonEntries = entries
      .filter((e) => e.name.startsWith("cartoon/") && !e.name.endsWith("/"))
      .map((e) => ({ file: path.basename(e.name), data: e.data }))
      .filter((e) => e.file && e.file !== "." && e.file !== "..");

    // 不覆盖设置时，先读出当前设置，落盘新库后再写回
    let keepSettings: string | null = null;
    if (!overwriteSettings) {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
        | { value: string }
        | undefined;
      keepSettings = row?.value ?? null;
    }

    // 合并 WAL 后关闭连接，再备份/替换文件
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${DB_PATH}.bak-${ts}`;
    fs.copyFileSync(DB_PATH, backupPath);
    for (const suffix of ["-wal", "-shm"]) {
      fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
    }
    fs.writeFileSync(DB_PATH, dbEntry.data);

    // 卡通画目录整体替换（旧目录备份为 cartoon.bak-<时间戳>）
    const cartoonDir = path.join(DATA_DIR, "cartoon");
    const hadCartoon = fs.existsSync(cartoonDir);
    if (hadCartoon) fs.renameSync(cartoonDir, `${cartoonDir}.bak-${ts}`);
    fs.mkdirSync(cartoonDir, { recursive: true });
    for (const e of cartoonEntries) {
      fs.writeFileSync(path.join(cartoonDir, e.file), e.data);
    }

    // 保留当前设置：写回新库
    if (keepSettings != null) {
      const restored = new Database(DB_PATH);
      restored
        .prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(keepSettings);
      restored.close();
    }

    // 看门狗：本进程退出 1.2s 后 touch src/index.ts，触发 tsx watch 重跑
    const watchTarget = path.resolve(__dirname, "../index.ts");
    const { spawn } = await import("node:child_process");
    const dog = spawn(
      process.execPath,
      ["-e", `setTimeout(()=>{try{const fs=require('fs');const t=new Date();fs.utimesSync(${JSON.stringify(watchTarget)},t,t);}catch{}},1200)`],
      { detached: true, stdio: "ignore" }
    );
    dog.unref();

    await reply.send({
      ok: true,
      restartRequired: true,
      backup: path.basename(backupPath),
      cartoons: cartoonEntries.length,
      settingsOverwritten: overwriteSettings,
    });
    setTimeout(() => process.exit(0), 300);
  });
}
