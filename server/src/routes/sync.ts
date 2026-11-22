import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { db, DATA_DIR } from "../db.js";
import { getSettings } from "../config.js";
import { syncAssets, syncSingleAsset, fetchAssetImage, refreshDuplicatesSafe, ImmichError } from "../immich.js";
import { enqueueNewPhotos, applyGroupDedupNow } from "../queue.js";
import { localDedupAfterSync } from "../localDedup.js";
import { verifyPublicImageUrl } from "../publicImage.js";

/** 内存 LRU（简单 Map，上限 50 条：手机端批量浏览时降低服务端常驻内存） */
const imageCache = new Map<string, { buffer: Buffer; contentType: string }>();
const IMAGE_CACHE_MAX = 50;

function cacheGet(key: string): { buffer: Buffer; contentType: string } | undefined {
  const v = imageCache.get(key);
  if (v) {
    imageCache.delete(key);
    imageCache.set(key, v); // 移到末尾（最近使用）
  }
  return v;
}

function cacheSet(key: string, value: { buffer: Buffer; contentType: string }): void {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(key, value);
}

/** 从 webhook body 中宽容地提取 asset id */
function extractWebhookAssetIds(body: unknown): string[] {
  const ids = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || v == null) return;
    if (typeof v === "string") {
      // UUID 形态
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) ids.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/^(id|assetId|asset_id|assetIds)$/i.test(k) && typeof val === "string") {
          ids.add(val);
        } else {
          visit(val, depth + 1);
        }
      }
    }
  };
  visit(body, 0);
  return [...ids];
}

export default async function syncRoutes(app: FastifyInstance): Promise<void> {
  /** 触发全量同步（Immich 不可达时返回友好错误，不 crash） */
  app.post("/api/sync", async (_req, reply) => {
    const settings = getSettings();
    try {
      const result = await syncAssets(settings);
      enqueueNewPhotos(result.addedIds);
      await refreshDuplicatesSafe(settings);
      const dedup = applyGroupDedupNow();
      // 兜底：为仍无 dhash 的照片排入相似分析队列
      localDedupAfterSync();
      return reply.send({ ok: true, ...result, queued: result.addedIds.length, dedupMarked: dedup.marked });
    } catch (e) {
      if (e instanceof ImmichError) {
        return reply.code(502).send({ ok: false, error: e.message });
      }
      throw e;
    }
  });

  /** Immich v3 Workflow webhook：解析出 asset id 即触发该资产同步 + 入队 */
  app.post("/api/immich-webhook", async (req, reply) => {
    const settings = getSettings();
    if (!settings.webhookEnabled) {
      return reply.send({ ok: true, skipped: true, reason: "webhook disabled" });
    }
    const ids = extractWebhookAssetIds(req.body);
    if (ids.length === 0) {
      return reply.send({ ok: true, synced: 0, queued: 0 });
    }
    let synced = 0;
    const queued: string[] = [];
    const errors: string[] = [];
    for (const id of ids.slice(0, 50)) {
      try {
        const isNew = await syncSingleAsset(settings, id);
        synced++;
        if (isNew) queued.push(id);
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message}`);
      }
    }
    enqueueNewPhotos(queued);
    return reply.send({ ok: errors.length === 0, synced, queued: queued.length, errors });
  });

  /**
   * 公网临时签名图片（供只接受 HTTP(S) 图片地址的图像提供方拉图，如阿里云 MaaS 网关）。
   * 无需登录，但必须带有效签名与有效期（见 publicImage.ts），只提供 preview 图。
   */
  app.get<{
    Params: { id: string };
    Querystring: { exp?: string; sig?: string };
  }>("/api/public/image/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig ?? "");
    if (!verifyPublicImageUrl(id, exp, sig)) {
      return reply.code(403).send({ error: "签名无效或已过期" });
    }
    const photo = db
      .prepare("SELECT immichId FROM photos WHERE id = ?")
      .get(id) as { immichId: string } | undefined;
    if (!photo) return reply.code(404).send({ error: "photo not found" });
    try {
      const img = await fetchAssetImage(getSettings(), photo.immichId, "preview");
      return reply.type(img.contentType).send(img.buffer);
    } catch (e) {
      if (e instanceof ImmichError) {
        return reply.code(502).send({ error: e.message });
      }
      throw e;
    }
  });

  /** 图片代理：服务端带 x-api-key 从 Immich 拉流返回，带内存缓存 */
  app.get<{
    Params: { id: string };
    Querystring: { size?: string };
  }>("/api/assets/:id/image", async (req, reply) => {
    const photo = db
      .prepare("SELECT immichId, cartoonImage FROM photos WHERE id = ?")
      .get(Number(req.params.id)) as { immichId: string; cartoonImage: string | null } | undefined;
    if (!photo) return reply.code(404).send({ error: "photo not found" });
    // 漫画化完成后优先返回本地生成的漫画图（不进 Immich 图片缓存，便于重新装裱后立即生效）
    if (photo.cartoonImage) {
      const file = path.join(DATA_DIR, "cartoon", path.basename(photo.cartoonImage));
      try {
        const buffer = fs.readFileSync(file);
        return reply.header("Cache-Control", "no-cache").type("image/jpeg").send(buffer);
      } catch {
        // 文件丢失则回退原图
      }
    }
    const size = req.query.size === "thumbnail" ? "thumbnail" : "preview";
    const cacheKey = `${photo.immichId}:${size}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return reply.type(cached.contentType).send(cached.buffer);
    }
    try {
      const img = await fetchAssetImage(getSettings(), photo.immichId, size);
      cacheSet(cacheKey, img);
      return reply.type(img.contentType).send(img.buffer);
    } catch (e) {
      if (e instanceof ImmichError) {
        return reply.code(502).send({ error: e.message });
      }
      throw e;
    }
  });
}
