import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings, setSettingsChangeHandler } from "./config.js";
import { authRequired, sessionFromCookieHeader, verifySession } from "./auth.js";
import { db, getSyncState, setSyncState } from "./db.js";
import { normalizeTakenAt } from "./timeutil.js";
import { syncAssets, refreshDuplicatesSafe, ImmichError } from "./immich.js";
import { recoverQueues, enqueueNewPhotos, applyGroupDedupNow } from "./queue.js";
import syncRoutes from "./routes/sync.js";
import photoRoutes, { registerVoteRoutes } from "./routes/photos.js";
import settingsRoutes from "./routes/settings.js";
import queueRoutes from "./routes/queues.js";
import { FONTS_DIR } from "./fonts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

/**
 * 登录鉴权（设置里开启后生效）：保护所有 /api/*，放行
 * 登录接口、Immich webhook（Immich 侧无法带 cookie）、公网临时签名图片（自带签名）。
 * 静态页面不拦（前端路由守卫负责跳登录页），避免登录页自身打不开。
 */
const AUTH_OPEN_PREFIXES = ["/api/auth/login", "/api/immich-webhook", "/api/public/image/"];
app.addHook("onRequest", async (req, reply) => {
  if (!authRequired()) return;
  const url = req.url.split("?")[0] ?? req.url;
  if (!url.startsWith("/api/")) return;
  if (url === "/api/auth/me" || AUTH_OPEN_PREFIXES.some((p) => url.startsWith(p))) return;
  if (!verifySession(sessionFromCookieHeader(req.headers.cookie))) {
    return reply.code(401).send({ error: "未登录或会话已过期" });
  }
});

await app.register(syncRoutes);
await app.register(photoRoutes);
registerVoteRoutes(app);
await app.register(settingsRoutes);
await app.register(queueRoutes);

/* 自定义字体目录（server/data/fonts）：以 /fonts/ 前缀提供字体文件下载 */
fs.mkdirSync(FONTS_DIR, { recursive: true });
await app.register(fastifyStatic, { root: FONTS_DIR, prefix: "/fonts/", decorateReply: false });

/* 静态托管 web/dist（若存在），GET * 回退 index.html；wildcard 模式按请求实时解析，
   避免前端重新构建后（文件名 hash 变化）需要重启服务端 */
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found" });
  });
} else {
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply
        .code(503)
        .type("text/plain")
        .send("web/dist 不存在：前端尚未构建。API 服务正常运行中。");
    }
    return reply.code(404).send({ error: "not found" });
  });
}

/* 服务重启后恢复未完成任务 */
const recovered = recoverQueues();
if (recovered.audit || recovered.compose) {
  app.log.info(`队列恢复：audit ${recovered.audit} 个，compose ${recovered.compose} 个`);
}

/* 拍摄时间迁移：带时区后缀（如 UTC 的 Z）的统一换算为 Asia/Shanghai 墙钟时间 */
{
  const rows = db
    .prepare("SELECT id, takenAt, createdAt FROM photos")
    .all() as Array<{ id: number; takenAt: string | null; createdAt: string | null }>;
  const upd = db.prepare("UPDATE photos SET takenAt=?, createdAt=? WHERE id=?");
  let migrated = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const t = normalizeTakenAt(r.takenAt);
      const c = normalizeTakenAt(r.createdAt);
      if (t !== r.takenAt || c !== r.createdAt) {
        upd.run(t, c, r.id);
        migrated++;
      }
    }
  });
  tx();
  if (migrated > 0) {
    app.log.info(`拍摄时间迁移：${migrated} 张照片已换算为上海时区墙钟时间`);
  }
}

/* 增量轮询：优先 updatedAfter；接口报错则退化为全量比对 updatedAt */
let polling = false;
async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const settings = getSettings();
    if (!settings.immichBaseUrl || !settings.immichApiKey) return;
    const last = getSyncState("lastUpdatedAfter");
    try {
      const result = await syncAssets(settings, last ?? undefined);
      enqueueNewPhotos(result.addedIds);
      setSyncState("lastUpdatedAfter", new Date().toISOString());
      if (result.upserted > 0) app.log.info(`增量同步 ${result.upserted} 张，新增入队 ${result.addedIds.length} 张`);
      await refreshDuplicatesSafe(settings);
      const dedup = applyGroupDedupNow();
      if (dedup.marked > 0) app.log.info(`重复组去重：${dedup.groups} 组，标记重复 ${dedup.marked} 张`);
    } catch (e) {
      if (e instanceof ImmichError) {
        // 退化为全量比对（upsert 本身幂等，新增才入队）
        app.log.warn(`updatedAfter 增量失败，退化为全量比对: ${e.message}`);
        const result = await syncAssets(settings);
        enqueueNewPhotos(result.addedIds);
        setSyncState("lastUpdatedAfter", new Date().toISOString());
        await refreshDuplicatesSafe(settings);
        const dedup = applyGroupDedupNow();
        if (dedup.marked > 0) app.log.info(`重复组去重：${dedup.groups} 组，标记重复 ${dedup.marked} 张`);
      } else {
        throw e;
      }
    }
  } catch (e) {
    app.log.warn(`轮询同步失败: ${(e as Error).message}`);
  } finally {
    polling = false;
  }
}

function schedulePoll(): void {
  const interval = getSettings().pollIntervalSec * 1000;
  setTimeout(async () => {
    await pollOnce();
    schedulePoll();
  }, interval).unref?.();
}

setSettingsChangeHandler(() => {
  // 并发数等配置在下次 pump 时自动生效，无需额外处理
});

await app.listen({ port: PORT, host: "0.0.0.0" });
app.log.info(`server  listening on http://localhost:${PORT}`);
schedulePoll();
