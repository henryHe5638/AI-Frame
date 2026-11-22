import { db, DATA_DIR } from "./db.js";
import { getSettings, updateSettings } from "./config.js";
import { chatCompletion, extractJson, AiError, cartoonizeImage, DEFAULT_CARTOON_PROMPT } from "./ai.js";
import fs from "node:fs";
import path from "node:path";
import { fetchAssetImage, fetchAssetImageBase64, fetchAssetDetail } from "./immich.js";
import { signPublicImageUrl } from "./publicImage.js";
import { listCustomFonts } from "./fonts.js";
import { computeDhash } from "./dhash.js";
import { assignLocalGroupsForBatch, assignLocalGroupForPhoto, groupLocalDuplicates } from "./localDedup.js";
import { getMemory } from "./memory.js";
import { formatTakenAt } from "./timeutil.js";
import sharp from "sharp";

type ChatMessageContent = Array<
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
>;

export type QueueName = "audit" | "compose" | "dhash" | "cartoon";

export interface QueueStatus {
  pending: number;
  running: number;
  concurrency: number;
  /** 每个运行槽一次取走的照片数（批量大小） */
  batchSize: number;
  paused: boolean;
}

/* ---------------- 自适应批量上限 ---------------- */

/**
 * 部分推理后端（如 LM Studio 的 MLX 视觉后端）对单次请求的图片数有承受上限，
 * 超了会直接崩（HTTP 400/500）。批量失败时按折半收缩上限，后续批次自动用可行批量；
 * 用户在设置里修改批量大小时上限重置。
 * 注意：只有「批量/上下文过大」类错误才收缩；模型重载、超时、网络错误等临时问题
 * 只做拆分重试，不改变上限，避免 10 张被一次偶发错误永久压到 5 张。
 * 每次成功处理一批后上限 +1，逐步恢复到配置值。
 */
const batchCap: Record<"audit" | "compose", number | null> = { audit: null, compose: null };
const batchSeen: Record<"audit" | "compose", number | null> = { audit: null, compose: null };

function effectiveBatchSize(name: "audit" | "compose", configured: number): number {
  if (batchSeen[name] !== configured) {
    batchSeen[name] = configured;
    batchCap[name] = null;
  }
  return Math.max(1, Math.min(configured, batchCap[name] ?? configured));
}

/** 判断失败是否由「一次塞太多图 / 上下文超限」引起；临时错误不收缩上限 */
function isBatchCapacityError(message: string): boolean {
  const m = message.toLowerCase();
  // 临时性错误：模型重载、超时、连接断开、限流、服务端 5xx
  if (
    /model reload|loading model|timeout|timed out|aborted|abort|econnreset|econnrefused|fetch failed|socket hang|eai_again|enotfound|rate.?limit|http 429|http 5\d\d/.test(
      m
    )
  ) {
    return false;
  }
  // 自身返回数量不符：说明模型一次处理不了这么多张
  if (/items|数量不符|length/.test(m)) return true;
  // 容量/上下文类错误
  return /too many|too large|payload|context|token|image.*(count|limit)|maximum|exceed|超过|超出|413/.test(m);
}

function shrinkBatchCap(name: "audit" | "compose", failedSize: number): void {
  const next = Math.max(1, Math.floor(failedSize / 2));
  const prev = batchCap[name];
  const value = prev === null ? next : Math.min(prev, next);
  if (value !== prev) {
    batchCap[name] = value;
    console.warn(`[batch:${name}] 批量上限收缩为 ${value}（本批 ${failedSize} 张）`);
  }
}

/** 成功处理一批后逐步上调上限，最终回到用户配置值 */
function growBatchCap(name: "audit" | "compose", configured: number): void {
  const cap = batchCap[name];
  if (cap === null || cap >= configured) return;
  batchCap[name] = cap + 1 >= configured ? null : cap + 1;
  console.log(`[batch:${name}] 批量上限恢复为 ${batchCap[name] ?? configured}`);
}

class TaskQueue {
  readonly name: QueueName;
  /** 队列排空（无等待且无运行中任务）时触发，用于批量任务结束后的统一收尾 */
  onDrained: (() => void) | null = null;
  private waiting: number[] = []; // photoId
  private waitingSet = new Set<number>(); // 与 waiting 同步，保证入队去重为 O(1)
  private runningCount = 0;
  private worker: (photoIds: number[]) => Promise<void>;

  constructor(name: QueueName, worker: (photoIds: number[]) => Promise<void>) {
    this.name = name;
    this.worker = worker;
  }

  get concurrency(): number {
    const s = getSettings();
    if (this.name === "audit") return s.auditConcurrency;
    if (this.name === "compose") return s.composeConcurrency;
    if (this.name === "cartoon") return s.cartoonConcurrency;
    return s.dhashConcurrency;
  }

  /** 每个运行槽一次取走的照片数（一次 AI 请求批量处理），dhash 固定 1 */
  private get batchSize(): number {
    const s = getSettings();
    if (this.name === "audit") return effectiveBatchSize("audit", s.auditBatchSize);
    if (this.name === "compose") return effectiveBatchSize("compose", s.composeBatchSize);
    return 1;
  }

  get paused(): boolean {
    const s = getSettings();
    if (this.name === "audit") return s.auditPaused;
    if (this.name === "compose") return s.composePaused;
    if (this.name === "cartoon") return s.cartoonPaused;
    return s.dhashPaused;
  }

  enqueue(photoId: number): void {
    if (!this.waitingSet.has(photoId)) {
      this.waiting.push(photoId);
      this.waitingSet.add(photoId);
    }
    this.schedulePump();
  }

  enqueueMany(photoIds: number[]): void {
    for (const id of photoIds) {
      if (!this.waitingSet.has(id)) {
        this.waiting.push(id);
        this.waitingSet.add(id);
      }
    }
    this.schedulePump();
  }

  /**
   * 入队调度：等待数不足一个批量时延迟一小会儿再派发，
   * 让陆续入队的照片（如审核逐张通过）攒成整批发给 AI；
   * 积压充足时立即派发，不影响全速处理。
   */
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;

  private schedulePump(): void {
    if (this.paused) return;
    if (this.waiting.length >= this.batchSize) {
      clearTimeout(this.pumpTimer);
      void this.pump();
      return;
    }
    if (this.pumpTimer !== undefined) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      void this.pump();
    }, 1500);
  }

  /** 从等待队列移除（已在运行的任务无法取消，只能让其跑完后由调用方忽略结果） */
  remove(photoId: number): void {
    if (!this.waitingSet.delete(photoId)) return;
    this.waiting = this.waiting.filter((id) => id !== photoId);
  }

  /** 批量移除等待任务（一次过滤，避免逐个 remove 的 O(n²)） */
  removeMany(photoIds: number[]): void {
    const drop = new Set(photoIds);
    let removed = 0;
    this.waiting = this.waiting.filter((id) => {
      if (drop.has(id)) {
        removed++;
        return false;
      }
      return true;
    });
    if (removed > 0) {
      this.waitingSet.clear();
      for (const id of this.waiting) this.waitingSet.add(id);
    }
  }

  /** 清空等待队列，返回取消的数量；运行中的任务不受影响 */
  clearWaiting(): number {
    const count = this.waiting.length;
    this.waiting = [];
    this.waitingSet.clear();
    return count;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  /** 恢复后立即尝试启动等待中的任务 */
  kick(): void {
    void this.pump();
  }

  /**
   * 手动触发的任务在队列暂停时绕过队列直接运行（不受暂停与并发上限限制）。
   * 用于详情页的单张重新打分/装裱：队列停着也要能手动处理。
   */
  runBypass(ids: number[]): void {
    const unique = [...new Set(ids)];
    // 已在等待队列里的先摘除，避免恢复队列后重复处理
    const drop = new Set(unique);
    this.waiting = this.waiting.filter((id) => !drop.has(id));
    for (const id of unique) this.waitingSet.delete(id);
    if (unique.length === 0) return;
    console.log(`[queue:${this.name}] 手动处理 ${unique.length} 张（队列暂停，绕过队列直接运行）`);
    this.runningCount++;
    void this.run(unique);
  }

  status(): QueueStatus {
    return {
      pending: this.waiting.length,
      running: this.runningCount,
      concurrency: this.concurrency,
      batchSize: this.batchSize,
      paused: this.paused,
    };
  }

  private async pump(): Promise<void> {
    if (this.paused) return;
    while (this.runningCount < this.concurrency && this.waiting.length > 0) {
      if (this.paused) break;
      const n = Math.max(1, Math.min(this.batchSize, this.waiting.length));
      const ids = this.waiting.splice(0, n);
      for (const id of ids) this.waitingSet.delete(id);
      if (this.name !== "dhash") {
        console.log(`[queue:${this.name}] 派发 ${ids.length} 张（剩余等待 ${this.waiting.length}）`);
      }
      this.runningCount++;
      void this.run(ids);
    }
  }

  private async run(photoIds: number[]): Promise<void> {
    try {
      await this.worker(photoIds);
    } catch (e) {
      console.error(`[queue:${this.name}] 批次 ${photoIds.join(",")} 未捕获错误:`, e);
      for (const id of photoIds) markFailed(this.name, id, (e as Error).message);
    } finally {
      this.runningCount--;
      this.pump();
      if (this.waiting.length === 0 && this.runningCount === 0) {
        try {
          this.onDrained?.();
        } catch (e) {
          console.warn(`[queue:${this.name}] onDrained 回调出错（已忽略）: ${(e as Error).message}`);
        }
      }
    }
  }
}

interface PhotoRow {
  id: number;
  immichId: string;
  takenAt: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  width: number | null;
  height: number | null;
}

function getPhoto(id: number): PhotoRow | undefined {
  return db
    .prepare("SELECT id, immichId, takenAt, city, state, country, width, height FROM photos WHERE id = ?")
    .get(id) as PhotoRow | undefined;
}

function markFailed(queue: QueueName, photoId: number, error: string): void {
  if (queue === "dhash") {
    db.prepare("UPDATE photos SET dhashFailed=1, error=?, updatedLocalAt=datetime('now') WHERE id=?")
      .run(error.slice(0, 1000), photoId);
    return;
  }
  if (queue === "cartoon") {
    db.prepare("UPDATE photos SET cartoonStatus='failed', error=?, updatedLocalAt=datetime('now') WHERE id=?")
      .run(error.slice(0, 1000), photoId);
    return;
  }
  const col = queue === "audit" ? "auditStatus" : "composeStatus";
  db.prepare(`UPDATE photos SET ${col}='failed', error=?, updatedLocalAt=datetime('now') WHERE id=?`)
    .run(error.slice(0, 1000), photoId);
}

/* ---------------- audit 工作流 ---------------- */

/** 批量请求时缩小图片：本地视觉模型的 prompt 处理耗时随图像 token 数爆炸，大图批量会卡死 */
const BATCH_AUDIT_IMG_DIM = 512;
const BATCH_COMPOSE_IMG_DIM = 768;
const BATCH_TIMEOUT_MS = 900_000;

/** 可选缩放后转 base64 data URL（缩放输出 JPEG） */
async function toDataUrl(buffer: Buffer, contentType: string, maxDim?: number): Promise<string> {
  if (!maxDim) return `data:${contentType};base64,${buffer.toString("base64")}`;
  const out = await sharp(buffer, { limitInputPixels: 1e8 })
    .rotate() // 按 EXIF 方向摆正，与模型看到的画面一致
    .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

/** 拉预览图并顺手算 dhash（不重复下载），返回 base64 data URL；maxDim 用于批量模式缩小图片 */
async function fetchPreviewForAudit(
  settings: ReturnType<typeof getSettings>,
  photo: PhotoRow,
  maxDim?: number
): Promise<string> {
  const { buffer, contentType } = await fetchAssetImage(settings, photo.immichId, "preview");
  if (settings.localDedupEnabled) {
    const existing = db.prepare("SELECT dhash FROM photos WHERE id = ?").get(photo.id) as
      | { dhash: string | null }
      | undefined;
    if (existing && !existing.dhash) {
      const hash = await computeDhash(buffer);
      if (hash) db.prepare("UPDATE photos SET dhash = ? WHERE id = ?").run(hash, photo.id);
    }
  }
  return toDataUrl(buffer, contentType, maxDim);
}

function parseAuditScores(
  parsed: { clarity?: unknown; beauty?: unknown; story?: unknown; reason?: unknown },
  thresholds: { clarity: number; beauty: number; story: number }
): { clarity: number; beauty: number; story: number; reason: string; total: number; passed: boolean } {
  const score = (v: unknown): number => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (!Number.isFinite(n)) return 0;
    return Math.max(1, Math.min(10, Math.round(n)));
  };
  const clarity = score(parsed.clarity);
  const beauty = score(parsed.beauty);
  const story = score(parsed.story);
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : "";
  const total = clarity + beauty + story;
  // 三个维度都达到各自阈值才通过
  const passed =
    clarity >= thresholds.clarity && beauty >= thresholds.beauty && story >= thresholds.story;
  return { clarity, beauty, story, reason, total, passed };
}

function auditThresholds(s: ReturnType<typeof getSettings>): {
  clarity: number;
  beauty: number;
  story: number;
} {
  return { clarity: s.clarityThreshold, beauty: s.beautyThreshold, story: s.storyThreshold };
}

/** 审核系统提示词：注入用户审核审美记忆（来自以往赞/踩的 AI 总结） */
function auditSystemPrompt(settings: ReturnType<typeof getSettings>): string {
  const memory = getMemory("audit");
  if (!memory) return settings.audit.prompt;
  return `${settings.audit.prompt}\n\n用户审核审美记忆（来自以往审核赞/踩的总结，打分时请体现这些偏好与底线）：\n${memory}`;
}

function currentAuditStatus(photoId: number): string | undefined {
  const row = db.prepare("SELECT auditStatus FROM photos WHERE id=?").get(photoId) as
    | { auditStatus: string }
    | undefined;
  return row?.auditStatus;
}

/** 评分落库 + 通过后进入构图（含组内重复策略） */
function applyAuditResult(
  photoId: number,
  r: { clarity: number; beauty: number; story: number; reason: string; total: number }
): void {
  // AI 处理期间可能已被相似去重标记为重复（在途批次无法取消），保留标识、丢弃结果
  if (currentAuditStatus(photoId) === "duplicate") return;
  // 用户踩过的照片永远淘汰、赞过的一律通过，重跑评分也不推翻用户判断
  const vote = db.prepare("SELECT auditVote FROM photos WHERE id=?").get(photoId) as
    | { auditVote: string | null }
    | undefined;
  // 用落库这一刻的最新阈值重判（批次起跑后到写库之间用户可能改了阈值，
  // 避免在途批次带着旧阈值逃逸阈值变更时的全量重判）
  const s = getSettings();
  const meets =
    r.clarity >= s.clarityThreshold && r.beauty >= s.beautyThreshold && r.story >= s.storyThreshold;
  const passed =
    vote?.auditVote === "like" ? true : vote?.auditVote === "dislike" ? false : meets;
  db.prepare(
    `UPDATE photos SET clarity=?, beauty=?, story=?, totalScore=?, reason=?,
     auditStatus=?, auditedAt=datetime('now'), updatedLocalAt=datetime('now') WHERE id=?`
  ).run(r.clarity, r.beauty, r.story, r.total, r.reason, passed ? "passed" : "rejected", photoId);

  if (passed) {
    db.prepare("UPDATE photos SET composeStatus='pending', instruction=NULL WHERE id=?").run(photoId);
    // 本地相似增量分组（dhash 已在拉图时顺手算好），再套用组内重复策略
    assignLocalGroupForPhoto(photoId);
    applyDuplicatePolicy(photoId);
    const stillPassed = db
      .prepare("SELECT auditStatus FROM photos WHERE id=?")
      .get(photoId) as { auditStatus: string } | undefined;
    if (stillPassed?.auditStatus === "passed") composeQueue.enqueue(photoId);
  }
  // 未通过时不提拔组内其他成员重审：每组只送审一张，避免重复照片反复消耗 AI
}

/**
 * 按当前阈值重判所有已评分照片的通过/淘汰（用户在设置里改阈值后立即生效）。
 * 用户踩过（auditVote='dislike'）的一律淘汰、赞过的一律通过；其余按清晰度/美观/故事各自阈值判定。
 * 新晋通过且无装裱结果的进 compose 队列；转为淘汰的从 compose 等待队列移除。
 */
export function recomputeAuditVerdicts(): { toPassed: number; toRejected: number } {
  const s = getSettings();
  const rows = db
    .prepare(
      `SELECT id, clarity, beauty, story, auditStatus, auditVote, composeStatus
       FROM photos
       WHERE totalScore IS NOT NULL AND auditStatus IN ('passed','rejected')`
    )
    .all() as Array<{
    id: number;
    clarity: number | null;
    beauty: number | null;
    story: number | null;
    auditStatus: string;
    auditVote: string | null;
    composeStatus: string;
  }>;
  const setStatus = db.prepare(
    "UPDATE photos SET auditStatus=?, updatedLocalAt=datetime('now') WHERE id=?"
  );
  const toPassed: Array<{ id: number; composeStatus: string }> = [];
  const toRejected: number[] = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      const meets =
        (r.clarity ?? 0) >= s.clarityThreshold &&
        (r.beauty ?? 0) >= s.beautyThreshold &&
        (r.story ?? 0) >= s.storyThreshold;
      const next =
        r.auditVote === "dislike"
          ? "rejected"
          : r.auditVote === "like" || meets
            ? "passed"
            : "rejected";
      if (next === r.auditStatus) continue;
      setStatus.run(next, r.id);
      if (next === "passed") toPassed.push({ id: r.id, composeStatus: r.composeStatus });
      else toRejected.push(r.id);
    }
  });
  tx();
  for (const id of toRejected) composeQueue.remove(id);
  for (const p of toPassed) {
    if (p.composeStatus === "pending" || p.composeStatus === "failed") composeQueue.enqueue(p.id);
  }
  return { toPassed: toPassed.length, toRejected: toRejected.length };
}

async function auditWorker(photoId: number): Promise<void> {
  const photo = getPhoto(photoId);
  if (!photo) return;
  // 入队后已被相似去重标记为重复的，不再送审（保留重复标识）
  if (currentAuditStatus(photoId) === "duplicate") return;
  const settings = getSettings();
  db.prepare("UPDATE photos SET auditStatus='auditing', error=NULL WHERE id=?").run(photoId);

  const imageUrl = await fetchPreviewForAudit(settings, photo);
  // 单张审核前也先做一次相似分组，若已并入有代表的重复组则直接跳过 AI
  if (settings.localDedupEnabled) {
    assignLocalGroupsForBatch([photoId]);
    if (currentAuditStatus(photoId) === "duplicate") return;
  }
  // Immich 重复组兜底：确认自己仍是组内代表再送审
  if (settings.dedupEnabled) {
    const gid = db.prepare("SELECT duplicateGroupId FROM photos WHERE id=?").get(photoId) as
      | { duplicateGroupId: string | null }
      | undefined;
    if (gid?.duplicateGroupId && !gid.duplicateGroupId.startsWith("local:")) {
      applyGroupDedupNow(gid.duplicateGroupId);
      if (currentAuditStatus(photoId) === "duplicate") return;
    }
  }
  const content = await chatCompletion({
    group: "audit",
    jsonMode: true,
    settings,
    messages: [
      { role: "system", content: auditSystemPrompt(settings) },
      {
        role: "user",
        content: [
          { type: "text", text: "请评审这张照片：" },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  const parsed = extractJson<{ clarity?: unknown; beauty?: unknown; story?: unknown; reason?: unknown }>(content);
  applyAuditResult(photoId, parseAuditScores(parsed, auditThresholds(settings)));
}

/**
 * 批量审核：一次请求带多张照片，模型按顺序输出 {"items":[...]}。
 * 单张拉图失败只剔除该张；AI 批量请求失败时折半拆分重试并收缩自适应批量上限，
 * 最终降级为逐张处理，不丢照片。
 */
async function auditBatch(photoIds: number[]): Promise<void> {
  if (photoIds.length === 1) return auditWorker(photoIds[0]!);
  const settings = getSettings();
  const photos = photoIds
    .map((id) => getPhoto(id))
    .filter(
      (p): p is PhotoRow => p !== undefined && currentAuditStatus(p.id) !== "duplicate"
    );
  if (photos.length === 0) return;
  if (photos.length === 1) return auditWorker(photos[0]!.id);

  const markAuditing = db.prepare("UPDATE photos SET auditStatus='auditing', error=NULL WHERE id=?");
  for (const p of photos) markAuditing.run(p.id);

  // 并行拉图（批量模式缩小图片）：单张失败只剔除该张，不拖垮整批
  const settled = await Promise.allSettled(
    photos.map((p) => fetchPreviewForAudit(settings, p, BATCH_AUDIT_IMG_DIM))
  );
  let okPhotos: PhotoRow[] = [];
  let okImages: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      okPhotos.push(photos[i]!);
      okImages.push(r.value);
    } else {
      markFailed("audit", photos[i]!.id, r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  });
  if (okPhotos.length === 0) return;
  if (okPhotos.length === 1) return auditWorker(okPhotos[0]!.id);

  // 送 AI 前先按 dHash 预分组：同一相似组只保留一张进模型，其余标记 duplicate
  if (settings.localDedupEnabled) {
    const before = okPhotos.length;
    assignLocalGroupsForBatch(okPhotos.map((p) => p.id));
    const keptPhotos: PhotoRow[] = [];
    const keptImages: string[] = [];
    okPhotos.forEach((p, i) => {
      if (currentAuditStatus(p.id) !== "duplicate") {
        keptPhotos.push(p);
        keptImages.push(okImages[i]!);
      }
    });
    okPhotos = keptPhotos;
    okImages = keptImages;
    if (before > okPhotos.length) {
      console.log(
        `[audit] 相似去重：本批 ${before} 张中 ${before - okPhotos.length} 张并入重复组，只送审 ${okPhotos.length} 张`
      );
    }
    if (okPhotos.length === 0) return;
    if (okPhotos.length === 1) return auditWorker(okPhotos[0]!.id);
  }

  // Immich 重复组兜底：批内同组只留一张。入队时的全量去重之后，
  // 组内可能又出现新的待审成员（新同步/平反），这里再收敛一次
  if (settings.dedupEnabled) {
    const before = okPhotos.length;
    dedupImmichGroupsOfBatch(okPhotos);
    const keptPhotos: PhotoRow[] = [];
    const keptImages: string[] = [];
    okPhotos.forEach((p, i) => {
      if (currentAuditStatus(p.id) !== "duplicate") {
        keptPhotos.push(p);
        keptImages.push(okImages[i]!);
      }
    });
    okPhotos = keptPhotos;
    okImages = keptImages;
    if (before > okPhotos.length) {
      console.log(
        `[audit] 重复组去重：本批 ${before} 张中 ${before - okPhotos.length} 张与组内代表重复，跳过评分`
      );
    }
    if (okPhotos.length === 0) return;
    if (okPhotos.length === 1) return auditWorker(okPhotos[0]!.id);
  }

  try {
    const n = okPhotos.length;
    const batchHint =
      `本次共 ${n} 张照片，请按「第 1 张」「第 2 张」…的顺序评审，严格按系统提示词中规定的批量 JSON 格式输出，` +
      `items 长度必须恰好为 ${n}。不要输出 JSON 以外的任何内容。`;
    const userContent: ChatMessageContent = [
      { type: "text", text: "请按顺序依次评审以下照片：" },
    ];
    okPhotos.forEach((_p, i) => {
      userContent.push({ type: "text", text: `第 ${i + 1} 张：` });
      userContent.push({ type: "image_url", image_url: { url: okImages[i]! } });
    });
    const content = await chatCompletion({
      group: "audit",
      jsonMode: true,
      settings,
      timeoutMs: BATCH_TIMEOUT_MS,
      retries: 0,
      messages: [
        { role: "system", content: `${auditSystemPrompt(settings)}\n\n${batchHint}` },
        { role: "user", content: userContent },
      ],
    });
    const parsed = extractJson<{ items?: unknown }>(content);
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
    if (!items || items.length !== n) {
      throw new AiError(
        `批量审核返回数量不符（期望 ${n}，实际 ${items ? items.length : "非数组"}）`
      );
    }
    for (let i = 0; i < n; i++) {
      // AI 判定本张与批内前面某张几乎相同 → 标为重复、丢弃本张评分（保留被引用的那张）
      const item = (items[i] ?? {}) as Record<string, unknown>;
      const dupOf = Number(item.dupOf);
      if (
        Number.isInteger(dupOf) &&
        dupOf >= 1 &&
        dupOf <= n &&
        dupOf - 1 !== i &&
        okPhotos[dupOf - 1]
      ) {
        const target = okPhotos[dupOf - 1]!;
        const marked = db
          .prepare(
            `UPDATE photos SET auditStatus='duplicate', reason=?, clarity=NULL, beauty=NULL, story=NULL,
               totalScore=NULL, auditedAt=NULL, updatedLocalAt=datetime('now')
             WHERE id=? AND auditStatus != 'duplicate' AND (auditVote IS NULL OR auditVote != 'like')`
          )
          .run(`与本批第 ${dupOf} 张相似（#${target.id}）`, okPhotos[i]!.id);
        if (marked.changes > 0) continue;
      }
      applyAuditResult(
        okPhotos[i]!.id,
        parseAuditScores(
          item as { clarity?: unknown; beauty?: unknown; story?: unknown; reason?: unknown },
          auditThresholds(settings)
        )
      );
    }
    growBatchCap("audit", settings.auditBatchSize);
  } catch (e) {
    const msg = (e as Error).message;
    if (isBatchCapacityError(msg)) {
      shrinkBatchCap("audit", okPhotos.length);
    } else {
      console.warn(`[audit] 批量审核失败（${msg}），判定为临时错误，保留批量上限`);
    }
    if (okPhotos.length > 2) {
      const mid = Math.ceil(okPhotos.length / 2);
      console.warn(
        `[audit] 批量审核失败（${msg}），拆分为 ${mid}+${okPhotos.length - mid} 重试`
      );
      await auditBatch(okPhotos.slice(0, mid).map((p) => p.id));
      await auditBatch(okPhotos.slice(mid).map((p) => p.id));
    } else {
      console.warn(`[audit] 批量审核失败（${msg}），降级为逐张处理: ${okPhotos.map((p) => p.id).join(",")}`);
      for (const p of okPhotos) {
        try {
          await auditWorker(p.id);
        } catch (e2) {
          markFailed("audit", p.id, (e2 as Error).message);
        }
      }
    }
  }
}

interface DupMember {
  id: number;
  fileName: string | null;
  totalScore: number | null;
  composeStatus: string;
}

/**
 * 同一 duplicateGroupId 组内只保留 totalScore 最高的一张 passed 照片进入 compose，
 * 其余置 auditStatus='duplicate' 并取消其 pending compose。
 *
 * 时序取舍（近似实现）：同组照片可能先后完成审核，本函数在每次审核完成后执行——
 * - 若组内已有 composeStatus 为 composing/done 的照片，视为“已锁定”的组内最佳，不再替换
 *   （后来的高分者直接标 duplicate）；
 * - 否则按 totalScore 动态选最佳，后来者分更高时把先前 passed 但未开始 compose 的降级。
 * - 正在 composing 的非最佳照片不强制中断（无法取消进行中的 AI 调用），仅标 duplicate。
 */
export function applyDuplicatePolicy(photoId: number): void {
  const settings = getSettings();
  if (!settings.dedupEnabled) return;
  const photo = db
    .prepare("SELECT duplicateGroupId FROM photos WHERE id=?")
    .get(photoId) as { duplicateGroupId: string | null } | undefined;
  const groupId = photo?.duplicateGroupId;
  if (!groupId) return;

  const members = db
    .prepare(
      `SELECT id, fileName, totalScore, composeStatus FROM photos
       WHERE duplicateGroupId = ? AND auditStatus = 'passed'`
    )
    .all(groupId) as DupMember[];
  if (members.length <= 1) return;

  const locked = members.find((m) => m.composeStatus === "composing" || m.composeStatus === "done");
  const best =
    locked ??
    members.reduce((a, b) => ((b.totalScore ?? 0) > (a.totalScore ?? 0) ? b : a));
  const keepName = best.fileName ?? `#${best.id}`;

  for (const m of members) {
    if (m.id === best.id) continue;
    db.prepare(
      `UPDATE photos SET auditStatus='duplicate', reason=?, clarity=NULL, beauty=NULL, story=NULL,
       totalScore=NULL, auditedAt=NULL, updatedLocalAt=datetime('now') WHERE id=?`
    ).run(`与组内最佳照片重复（保留 ${keepName}）`, m.id);
    if (m.composeStatus === "pending") composeQueue.remove(m.id);
  }
}

/**
 * 对重复组整体去重（同步后 / 批次送审前调用），覆盖 Immich 组与本地 local: 相似组：
 * 每组只留一张代表照片——优先已在构图/完成的（锁定），其次已通过中总分最高的，
 * 再次任何已有评分结果的（避免同一组被反复送审），最后才按拍摄时间取最早的一张待审照片；
 * 其余成员标记 auditStatus='duplicate' 并从审核等待队列移除。
 * 幂等：已全部去重的组直接跳过。
 */
export function applyGroupDedupNow(groupId?: string): { groups: number; marked: number } {
  const groups = groupId
    ? [{ g: groupId }]
    : (db
        .prepare(
          `SELECT DISTINCT duplicateGroupId AS g FROM photos
           WHERE duplicateGroupId IS NOT NULL`
        )
        .all() as Array<{ g: string }>);

  interface GroupMember {
    id: number;
    fileName: string | null;
    takenAt: string | null;
    totalScore: number | null;
    auditStatus: string;
    composeStatus: string;
  }
  const memberStmt = db.prepare(
    `SELECT id, fileName, takenAt, totalScore, auditStatus, composeStatus
     FROM photos WHERE duplicateGroupId=?`
  );
  const markStmt = db.prepare(
    `UPDATE photos SET auditStatus='duplicate', reason=?, clarity=NULL, beauty=NULL, story=NULL,
       totalScore=NULL, auditedAt=NULL, updatedLocalAt=datetime('now') WHERE id=?`
  );
  const bestOf = (list: GroupMember[]): GroupMember =>
    list.reduce((a, b) => ((b.totalScore ?? 0) > (a.totalScore ?? 0) ? b : a));

  let marked = 0;
  const toRemove: number[] = [];
  const tx = db.transaction(() => {
    for (const { g } of groups) {
      const members = memberStmt.all(g) as GroupMember[];
      if (members.length < 2) continue;
      const active = members.filter((m) => m.auditStatus !== "duplicate");
      if (active.length <= 1) continue;

      const locked = active.find(
        (m) => m.composeStatus === "composing" || m.composeStatus === "done"
      );
      const passed = active.filter((m) => m.auditStatus === "passed");
      const scored = active.filter((m) => m.totalScore != null);
      const keeper =
        locked ??
        (passed.length > 0
          ? bestOf(passed)
          : scored.length > 0
            ? bestOf(scored) // 组内已有评分结果就不再换人评，避免同组反复送审
            : [...active].sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""))[0]);
      const keepName = keeper.fileName ?? `#${keeper.id}`;

      for (const m of active) {
        if (m.id === keeper.id) continue;
        markStmt.run(`与组内照片重复（保留 ${keepName}）`, m.id);
        if (m.composeStatus === "pending") composeQueue.remove(m.id);
        toRemove.push(m.id);
        marked++;
      }
    }
  });
  tx();
  if (toRemove.length > 0) auditQueue.removeMany(toRemove);
  return { groups: groups.length, marked };
}

/**
 * 批次送审前的 Immich 重复组兜底：对批内照片所属的 Immich 组（非 local:）执行组内去重。
 * 入队时虽已全量去重，但入队后新同步成员、组解散平反等会让同组多张重新待审，
 * 不兜底就会同一组多张一起送 AI 评分。
 */
function dedupImmichGroupsOfBatch(photos: PhotoRow[]): void {
  const stmt = db.prepare("SELECT duplicateGroupId FROM photos WHERE id=?");
  const groups = new Set<string>();
  for (const p of photos) {
    const gid = (stmt.get(p.id) as { duplicateGroupId: string | null } | undefined)?.duplicateGroupId;
    if (gid && !gid.startsWith("local:")) groups.add(gid);
  }
  for (const g of groups) applyGroupDedupNow(g);
}

/* ---------------- compose 工作流 ---------------- */

export interface ComposeInstruction {
  crop: { cx: number; cy: number; width: number; height: number };
  /** 展示比例：标准横竖屏比例，original 表示保持 AI 给的自由比例 */
  ratio: "original" | "16:9" | "9:16" | "4:3" | "3:4" | "1:1";
  rotate: 0 | 90 | 180 | 270;
  frame: { style: "none" | "wood" | "black" | "white" | "gold"; widthPx: number };
  text: {
    content: string;
    position: "bottom" | "top" | "left" | "right";
    /** 竖排文字（适合竖构图/左右留白多的画面） */
    vertical: boolean;
    /** 下划线（手账感） */
    underline: boolean;
    /** 字号：字高占照片高度的百分比（2-12），null 为自动 */
    fontSize: number | null;
    font: TextFont;
    gradientFrom: string;
    gradientTo: string;
    strokeColor: string;
  };
  /** AI 直接写的 SVG 叠加层代码（可选），铺满照片区域渲染 */
  overlay: string | null;
  /** AI 自行决定本张是否漫画化（仅装裱设置开启漫画化时提示词中才出现该字段） */
  cartoonize: boolean;
  /** AI 给出的漫画风格描述（可选），作为图像编辑模型的 prompt */
  cartoonPrompt: string | null;
}

const RATIOS = { "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3, "3:4": 3 / 4, "1:1": 1 } as const;
const RATIO_NAMES = Object.keys(RATIOS) as Array<keyof typeof RATIOS>;
const FRAME_STYLES = ["none", "wood", "black", "white", "gold"] as const;
const TEXT_POSITIONS = ["bottom", "top", "left", "right"] as const;
/** 内置题字字体：与前端 ArtFrame 的字体表一一对应；此外允许自定义字体 id（server/data/fonts/） */
const TEXT_FONTS = ["brush", "kai", "cute", "round", "hand", "gentle"] as const;
export type TextFont = (typeof TEXT_FONTS)[number] | string;
const ROTATES = [0, 90, 180, 270] as const;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** 保守清洗 AI 写的 SVG 叠加层：只放行安全的形状/文本/渐变，禁止脚本与外部资源 */
function sanitizeOverlaySvg(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 20000 || !/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return null;
  const banned: RegExp[] = [
    /<\s*(script|foreignObject|iframe|object|embed|link|style|image|use|a)[\s>/]/i,
    /\son\w+\s*=/i,
    /javascript:/i,
    /xlink:href/i,
    /(href|src)\s*=\s*["']\s*(https?:|data:)/i,
  ];
  for (const re of banned) if (re.test(s)) return null;
  return s;
}

/** 服务端校验并修正 compose 指令；sourceAspect 为照片原始宽高比（用于把裁剪框矫正到标准展示比例） */
export function sanitizeInstruction(raw: unknown, sourceAspect?: number): ComposeInstruction {
  const r = (raw ?? {}) as Record<string, unknown>;
  const cropRaw = (r.crop ?? {}) as Record<string, unknown>;
  const clamp01 = (v: unknown, fallback: number): number => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
  };
  let width = clamp01(cropRaw.width, 0.9);
  let height = clamp01(cropRaw.height, 0.9);
  width = Math.max(0.3, width);
  height = Math.max(0.3, height);

  // 展示比例：AI 只需给中心与大致范围，服务端按目标比例精确矫正裁剪框
  const ratioName = String(r.ratio ?? "");
  const ratio = (RATIO_NAMES as readonly string[]).includes(ratioName)
    ? (ratioName as keyof typeof RATIOS)
    : "original";
  if (
    ratio !== "original" &&
    typeof sourceAspect === "number" &&
    Number.isFinite(sourceAspect) &&
    sourceAspect > 0
  ) {
    // 有效宽高比 = sourceAspect * width / height = RATIOS[ratio]  =>  width / height = ratio / sourceAspect
    const k = RATIOS[ratio] / sourceAspect;
    height = width / k;
    if (height > 1) {
      height = 1;
      width = k;
    }
    width = clamp01(width, 0.9);
    height = clamp01(height, 0.9);
  }
  // 中心 ± 宽高/2 限制在界内
  const cxMin = width / 2, cxMax = 1 - width / 2;
  const cyMin = height / 2, cyMax = 1 - height / 2;
  const cx = Math.max(cxMin, Math.min(cxMax, clamp01(cropRaw.cx, 0.5)));
  const cy = Math.max(cyMin, Math.min(cyMax, clamp01(cropRaw.cy, 0.5)));

  const rotateNum = Number(r.rotate);
  const rotate = (ROTATES as readonly number[]).includes(rotateNum)
    ? (rotateNum as 0 | 90 | 180 | 270)
    : 0;

  const frameRaw = (r.frame ?? {}) as Record<string, unknown>;
  const style = (FRAME_STYLES as readonly string[]).includes(String(frameRaw.style))
    ? (frameRaw.style as (typeof FRAME_STYLES)[number])
    : "none";
  const widthPxNum = Number(frameRaw.widthPx);
  const frameWidthPx = Number.isFinite(widthPxNum) ? Math.max(0, Math.min(80, Math.round(widthPxNum))) : 0;

  const textRaw = (r.text ?? {}) as Record<string, unknown>;
  // 允许一次换行（最多两行），其余控制字符去掉；字数上限 20（不含换行符）
  const content = String(textRaw.content ?? "")
    .replace(/\\n/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, 21)
    .replace(/\n$/, "");
  const position = (TEXT_POSITIONS as readonly string[]).includes(String(textRaw.position))
    ? (textRaw.position as (typeof TEXT_POSITIONS)[number])
    : "bottom";
  const vertical = textRaw.vertical === true || textRaw.vertical === "true";
  const underline = textRaw.underline === true || textRaw.underline === "true";
  const fontSizeNum = Number(textRaw.fontSize);
  const fontSize = Number.isFinite(fontSizeNum)
    ? Math.max(2, Math.min(12, Math.round(fontSizeNum * 10) / 10))
    : null;
  // 内置字体之外允许自定义字体 id（server/data/fonts/ 里的文件，slug 形式）
  const fontRaw = String(textRaw.font ?? "");
  const font = (TEXT_FONTS as readonly string[]).includes(fontRaw)
    ? (fontRaw as TextFont)
    : /^[a-z0-9][a-z0-9-]{0,39}$/.test(fontRaw)
      ? fontRaw
      : "brush";
  const color = (v: unknown, fallback: string): string =>
    HEX_RE.test(String(v)) ? String(v) : fallback;

  return {
    crop: { cx, cy, width, height },
    ratio,
    rotate,
    frame: { style, widthPx: frameWidthPx },
    text: {
      content,
      position,
      vertical,
      underline,
      fontSize,
      font,
      gradientFrom: color(textRaw.gradientFrom, "#fff8ec"),
      gradientTo: color(textRaw.gradientTo, "#f0dcc0"),
      strokeColor: color(textRaw.strokeColor, "#3d3630"),
    },
    overlay: sanitizeOverlaySvg(r.overlay),
    cartoonize: r.cartoonize === true || r.cartoonize === "true",
    cartoonPrompt:
      typeof r.cartoonPrompt === "string" && r.cartoonPrompt.trim()
        ? r.cartoonPrompt.trim().slice(0, 300)
        : null,
  };
}

/** 拍摄时间/地点上下文：搜索结果不含地理位置，按需拉一次详情并缓存进库（失败则忽略） */
async function photoContextLines(
  settings: ReturnType<typeof getSettings>,
  photo: PhotoRow
): Promise<string[]> {
  let { takenAt, city, state, country } = photo;
  if (!city && !state && !country) {
    try {
      const detail = await fetchAssetDetail(settings, photo.immichId);
      city = detail.city ?? city;
      state = detail.state ?? state;
      country = detail.country ?? country;
      takenAt = takenAt ?? detail.takenAt ?? null;
      if (detail.city || detail.state || detail.country) {
        db.prepare("UPDATE photos SET city=?, state=?, country=? WHERE id=?").run(
          city, state, country, photo.id
        );
      }
    } catch {
      // 地点不可得，仅按时间生成
    }
  }
  const contextLines: string[] = [];
  const takenText = formatTakenAt(takenAt);
  if (takenText) contextLines.push(`拍摄时间：${takenText}`);
  const place = [city ?? state, country].filter(
    (v, i, arr): v is string => Boolean(v) && arr.indexOf(v) === i
  );
  if (place.length > 0) contextLines.push(`拍摄地点：${place.join("，")}`);
  return contextLines;
}

function composeSystemPrompt(settings: ReturnType<typeof getSettings>): string {
  let base = settings.compose.prompt;
  // 自定义字体（server/data/fonts/ 里用户自配的字体文件），运行时动态附加到可选字体表
  const customFonts = listCustomFonts();
  if (customFonts.length > 0) {
    // 提示词里的「只能取以下值」会把 AI 限制在内置字体上，动态改写为开放口径
    base = base.replace(
      /text\.font 只能取以下值/g,
      "text.font 可以取以下内置值，或文末「自定义字体」列表里的任意 id"
    );
    base = base.replace(/只能取以下值（根据照片气质主动选择）/g, "可以取以下值或自定义字体 id（根据照片气质主动选择）");
    base +=
      `\n\n自定义字体（重要，用户特意安装的字体，请积极按照片气质选用，不要只盯着内置字体）：` +
      customFonts.map((f) => `${f.id}（${f.family}）`).join("、") +
      `。以上 id 在 text.font 中与内置字体（brush/kai/cute/round/hand/gentle）完全同等合法，` +
      `选字时在全部内置字体与这些自定义字体中一起比较、挑最贴合画面气质的；同一批照片尽量多用不同的自定义字体。` +
      `overlay SVG 中 font-family 可使用这些字体的原名："${customFonts.map((f) => f.family).join('"、"')}"。`;
  }
  const memory = getMemory("compose");
  if (memory) {
    base += `\n\n六、用户审美记忆（来自以往装裱的赞/踩总结，务必遵循）：\n${memory}`;
  }
  // 漫画化开关打开时，追加可选字段说明，由 AI 自行判断是否漫画化（附频率统计，控制预算）
  if (settings.compose.cartoonEnabled && settings.compose.cartoonModel) {
    const stats = cartoonStats();
    base +=
      `\n\n漫画化（可选）：如果你判断这张照片非常适合转成漫画/插画风格展示（如宠物、美食、风景、趣味场景；纪实感强或人像为主的慎用），` +
      `请在输出 JSON 顶层加 "cartoonize": true，并附 "cartoonPrompt"（只描述想要的画风，如「吉卜力水彩风」「美漫粗线条风」；` +
      `生成时会以这张照片为底图做画风迁移，构图与主体会严格保留，无需你在 prompt 里描述画面内容）；` +
      `不适合漫画化时省略该字段或填 false。漫画化由单独的图像编辑模型执行，你的装裱指令仍按原照片画面设计（裁剪、题字、配色照常）。` +
      `\n漫画化频率限制（重要）：漫画化调用成本高，装裱过的照片中最多 ${Math.round(stats.ratio * 100)}% 可以漫画化（约每 ${Math.round(1 / stats.ratio)} 张挑 1 张），宁缺毋滥，只选特别适合的。` +
      `当前统计：已装裱 ${stats.composed} 张，已漫画化 ${stats.cartoonized} 张（含进行中的 ${stats.inflight} 张），` +
      `配额上限 ${stats.quota} 张${stats.quotaReached ? "，配额已用完，本次一律不要输出 cartoonize" : ""}。`;
  }
  return base;
}

/** 这张照片最近一次被踩时的装裱指令快照（用于重装裱时明确避开） */
function lastDislikeInstruction(photoId: number): string | null {
  const row = db
    .prepare(
      `SELECT instruction FROM compose_feedback
       WHERE photoId = ? AND vote = 'dislike' ORDER BY id DESC LIMIT 1`
    )
    .get(photoId) as { instruction: string | null } | undefined;
  return row?.instruction ?? null;
}

/**
 * 装裱被踩后的重做提示（内存态）：踩记录总结进记忆后即从 feedback 表删除，
 * 这里的快照保证紧随其后的重新装裱仍能拿到旧指令、明确避开旧风格。
 * 服务重启后丢失（此时教训已在审美记忆里），仅作一次性提示。
 */
const composeRedoHints = new Map<number, string>();

export function setComposeRedoHint(photoId: number, instruction: string): void {
  composeRedoHints.set(photoId, instruction.slice(0, 800));
}

/** 取一次即消费 */
function takeRedoHint(photoId: number): string | null {
  const hint = composeRedoHints.get(photoId) ?? null;
  composeRedoHints.delete(photoId);
  return hint;
}

/** 漫画化生成的本地图片目录（data/cartoon/<photoId>.jpg） */
const CARTOON_DIR = path.join(DATA_DIR, "cartoon");

/** 清除照片的漫画图（重新装裱/重跑时调用） */
function clearCartoon(photoId: number): void {
  db.prepare("UPDATE photos SET cartoonImage=NULL, cartoonStatus=NULL, cartoonedAt=NULL WHERE id=?").run(photoId);
  fs.rmSync(path.join(CARTOON_DIR, `${photoId}.jpg`), { force: true });
}

/** 漫画化统计：已装裱数（分母）、已漫画化数、进行中数、配额（频率上限在设置里可调，默认 1/10） */
function cartoonStats(): { composed: number; cartoonized: number; inflight: number; quota: number; quotaReached: boolean; ratio: number } {
  const ratio = getSettings().cartoonRatio;
  // 分母用已装裱数而不是全部通过数：漫画化决策发生在装裱时，
  // 否则大量「已通过但还没装裱」的照片会把配额提前撑大
  const composed = (db.prepare("SELECT COUNT(*) c FROM photos WHERE composeStatus='done'").get() as { c: number }).c;
  const inflight = (
    db.prepare("SELECT COUNT(*) c FROM photos WHERE cartoonStatus IN ('pending','cartoonizing')").get() as { c: number }
  ).c;
  const done = (db.prepare("SELECT COUNT(*) c FROM photos WHERE cartoonStatus='done'").get() as { c: number }).c;
  const cartoonized = done + inflight;
  const quota = Math.floor(composed * ratio);
  return { composed, cartoonized, inflight, quota, quotaReached: cartoonized >= quota, ratio };
}

/**
 * 装裱完成后处理漫画化入队：AI 判定 cartoonize 且功能开启时投入漫画化队列，
 * 由独立队列异步生成（图像生成较慢，不阻塞装裱）。超过频率配额时跳过（硬性限制）。
 */
function maybeEnqueueCartoon(photo: PhotoRow, instruction: ComposeInstruction): void {
  const settings = getSettings();
  if (!instruction.cartoonize) return;
  if (!settings.compose.cartoonEnabled || !settings.compose.cartoonModel) return;
  const stats = cartoonStats();
  if (stats.quotaReached) {
    console.log(`[cartoon] #${photo.id} 超出漫画化频率配额（${stats.cartoonized}/${stats.quota}），跳过`);
    return;
  }
  db.prepare("UPDATE photos SET cartoonStatus='pending' WHERE id=?").run(photo.id);
  cartoonQueue.enqueue(photo.id);
}

/**
 * 漫画化任务：读最新装裱指令（确认仍要漫画化），调图像模型生成漫画图存本地。
 * 失败抛错由队列标记 cartoonStatus='failed'，不影响装裱结果（仍展示原图）。
 */
async function cartoonWorker(photoId: number): Promise<void> {
  const settings = getSettings();
  if (!settings.compose.cartoonEnabled || !settings.compose.cartoonModel) {
    throw new AiError("漫画化未开启或未配置漫画化模型");
  }
  const row = db
    .prepare("SELECT id, immichId, instruction FROM photos WHERE id = ?")
    .get(photoId) as { id: number; immichId: string; instruction: string | null } | undefined;
  if (!row?.instruction) throw new AiError("照片无装裱指令，无法漫画化");
  const instruction = JSON.parse(row.instruction) as ComposeInstruction;
  if (!instruction.cartoonize) {
    db.prepare("UPDATE photos SET cartoonStatus=NULL WHERE id=?").run(photoId);
    return;
  }
  db.prepare("UPDATE photos SET cartoonStatus='cartoonizing', error=NULL WHERE id=?").run(photoId);
  const { buffer } = await fetchAssetImage(settings, row.immichId, "preview");
  // 基础提示词用设置里的漫画化提示词（含画风迁移保真约束），AI 给出的 cartoonPrompt 作为画风补充
  const base = settings.compose.cartoonPrompt || DEFAULT_CARTOON_PROMPT;
  const prompt = instruction.cartoonPrompt ? `${base}\n画风要求：${instruction.cartoonPrompt}` : base;
  const out = await cartoonizeImage(
    settings,
    await sharp(buffer, { limitInputPixels: 1e8 }).rotate().jpeg({ quality: 85 }).toBuffer(),
    prompt,
    // 提供方不支持上传（如阿里云 MaaS 网关）时改用公网签名 URL 拉图
    signPublicImageUrl(settings, photoId)
  );
  // 统一转 JPEG 存储（提供方可能返回 PNG，既减体积也保证文件内容与实际类型一致）
  const jpeg = await sharp(out, { limitInputPixels: 1e8 }).jpeg({ quality: 88 }).toBuffer();
  fs.mkdirSync(CARTOON_DIR, { recursive: true });
  fs.writeFileSync(path.join(CARTOON_DIR, `${photoId}.jpg`), jpeg);
  db.prepare(
    "UPDATE photos SET cartoonImage=?, cartoonStatus='done', cartoonedAt=datetime('now'), updatedLocalAt=datetime('now') WHERE id=?"
  ).run(`${photoId}.jpg`, photoId);
  console.log(`[cartoon] #${photoId} 漫画化完成（${settings.compose.cartoonModel}）`);
}

/** 装裱指令校验入库（含按照片宽高比的裁剪矫正）；新装裱完成后清空旧的装裱评价 */
function applyComposeInstruction(photo: PhotoRow, raw: unknown): ComposeInstruction | null {
  // AI 处理期间若已被组内策略降级为重复，丢弃本次装裱结果（composeStatus 由重启恢复兜底）
  if (currentAuditStatus(photo.id) !== "passed") return null;
  const sourceAspect =
    photo.width && photo.height && photo.width > 0 && photo.height > 0
      ? photo.width / photo.height
      : undefined;
  const instruction = sanitizeInstruction(raw, sourceAspect);
  db.prepare(
    `UPDATE photos SET instruction=?, composeStatus='done', composeVote=NULL, composedAt=datetime('now'), updatedLocalAt=datetime('now') WHERE id=?`
  ).run(JSON.stringify(instruction), photo.id);
  return instruction;
}

async function composeWorker(photoId: number): Promise<void> {
  const photo = getPhoto(photoId);
  if (!photo) return;
  // 入队后已被降级为重复（或状态异常）的，不再装裱
  if (currentAuditStatus(photoId) !== "passed") return;
  const settings = getSettings();
  db.prepare("UPDATE photos SET composeStatus='composing', error=NULL WHERE id=?").run(photoId);

  const imageUrl = await fetchAssetImageBase64(settings, photo.immichId, "preview");
  const contextLines = await photoContextLines(settings, photo);
  const dislikeSnapshot = takeRedoHint(photoId) ?? lastDislikeInstruction(photoId);
  const userText = [
    "请为这张照片生成装裱指令：",
    ...contextLines,
    ...(contextLines.length > 0
      ? ["题字可呼应以上拍摄时间与地点（如季节、节日、晨昏、城市意象），含蓄自然，不要照抄时间地点，与画面气质无关时也可不用。"]
      : []),
    ...(dislikeSnapshot
      ? [`上一次装裱被用户踩了，旧指令：${dislikeSnapshot.slice(0, 600)}；请换一种明显不同的风格（相框/字体/配色/题字至少换一项）。`]
      : []),
  ].join("\n");

  const content = await chatCompletion({
    group: "compose",
    jsonMode: true,
    settings,
    messages: [
      { role: "system", content: composeSystemPrompt(settings) },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  const instruction = applyComposeInstruction(photo, extractJson(content));
  if (instruction) maybeEnqueueCartoon(photo, instruction);
}

/**
 * 批量装裱：一次请求带多张照片（各自附拍摄时间/地点），模型按顺序输出 {"items":[...]}。
 * 提示词明确要求每张独立设计、避免整批套模板；单张拉图失败只剔除该张，
 * AI 批量请求失败时折半拆分重试并收缩自适应批量上限，最终降级为逐张处理。
 */
async function composeBatch(photoIds: number[]): Promise<void> {
  if (photoIds.length === 1) return composeWorker(photoIds[0]!);
  const settings = getSettings();
  const photos = photoIds
    .map((id) => getPhoto(id))
    .filter((p): p is PhotoRow => p !== undefined && currentAuditStatus(p.id) === "passed");
  if (photos.length === 0) return;
  if (photos.length === 1) return composeWorker(photos[0]!.id);

  const markComposing = db.prepare("UPDATE photos SET composeStatus='composing', error=NULL WHERE id=?");
  for (const p of photos) markComposing.run(p.id);

  const contextLines: string[][] = [];
  for (const p of photos) contextLines.push(await photoContextLines(settings, p));

  // 并行拉图（批量模式缩小图片）：单张失败只剔除该张，不拖垮整批
  const settled = await Promise.allSettled(
    photos.map(async (p) => {
      const { buffer, contentType } = await fetchAssetImage(settings, p.immichId, "preview");
      return toDataUrl(buffer, contentType, BATCH_COMPOSE_IMG_DIM);
    })
  );
  const okPhotos: PhotoRow[] = [];
  const okImages: string[] = [];
  const okContexts: string[][] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      okPhotos.push(photos[i]!);
      okImages.push(r.value);
      okContexts.push(contextLines[i]!);
    } else {
      markFailed("compose", photos[i]!.id, r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  });
  if (okPhotos.length === 0) return;
  if (okPhotos.length === 1) return composeWorker(okPhotos[0]!.id);

  try {
    const n = okPhotos.length;
    const batchHint =
      `本次共 ${n} 张照片，请按「第 1 张」「第 2 张」…的顺序给出（各自附拍摄时间/地点）。` +
      `请按相同顺序输出严格 JSON：{"items": [...]}，items 长度必须恰好为 ${n}，每项是一套装裱指令（字段要求见系统提示词）。` +
      `每张独立设计，刻意让相框、字体、配色与展示比例有所变化，不要给整批照片套用同一模板。` +
      `不要输出 JSON 以外的任何内容。`;
    const userContent: ChatMessageContent = [
      { type: "text", text: "请按顺序为以下照片分别生成装裱指令：" },
    ];
    okPhotos.forEach((p, i) => {
      const lines = [...okContexts[i]!];
      const dislikeSnapshot = takeRedoHint(p.id) ?? lastDislikeInstruction(p.id);
      if (dislikeSnapshot) {
        lines.push(`上一次装裱被用户踩了，旧指令：${dislikeSnapshot.slice(0, 600)}；请换一种明显不同的风格（相框/字体/配色/题字至少换一项）。`);
      }
      userContent.push({
        type: "text",
        text: lines.length > 0 ? `第 ${i + 1} 张：\n${lines.join("\n")}` : `第 ${i + 1} 张：`,
      });
      userContent.push({ type: "image_url", image_url: { url: okImages[i]! } });
    });
    const content = await chatCompletion({
      group: "compose",
      jsonMode: true,
      settings,
      timeoutMs: BATCH_TIMEOUT_MS,
      retries: 0,
      messages: [
        { role: "system", content: `${composeSystemPrompt(settings)}\n\n${batchHint}` },
        { role: "user", content: userContent },
      ],
    });
    const parsed = extractJson<{ items?: unknown }>(content);
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
    if (!items || items.length !== n) {
      throw new AiError(
        `批量装裱返回数量不符（期望 ${n}，实际 ${items ? items.length : "非数组"}）`
      );
    }
    for (let i = 0; i < n; i++) {
      const instruction = applyComposeInstruction(okPhotos[i]!, items[i]);
      if (instruction) maybeEnqueueCartoon(okPhotos[i]!, instruction);
    }
    growBatchCap("compose", settings.composeBatchSize);
  } catch (e) {
    const msg = (e as Error).message;
    if (isBatchCapacityError(msg)) {
      shrinkBatchCap("compose", okPhotos.length);
    } else {
      console.warn(`[compose] 批量装裱失败（${msg}），判定为临时错误，保留批量上限`);
    }
    if (okPhotos.length > 2) {
      const mid = Math.ceil(okPhotos.length / 2);
      console.warn(
        `[compose] 批量装裱失败（${msg}），拆分为 ${mid}+${okPhotos.length - mid} 重试`
      );
      await composeBatch(okPhotos.slice(0, mid).map((p) => p.id));
      await composeBatch(okPhotos.slice(mid).map((p) => p.id));
    } else {
      console.warn(`[compose] 批量装裱失败（${msg}），降级为逐张处理: ${okPhotos.map((p) => p.id).join(",")}`);
      for (const p of okPhotos) {
        try {
          await composeWorker(p.id);
        } catch (e2) {
          markFailed("compose", p.id, (e2 as Error).message);
        }
      }
    }
  }
}

/* ---------------- 相似分析（dhash）工作流 ---------------- */

/**
 * 单个任务只负责取缩略图 + 算哈希入库，不做比对；
 * 比对分组统一在队列排空后做一次全量重算（见 dhashQueue.onDrained），
 * 避免每张都触发增量分组/去重造成的 O(n²) 开销与分组抖动。
 */
async function dhashWorker(photoId: number): Promise<boolean> {
  const photo = getPhoto(photoId);
  if (!photo) return false;
  const settings = getSettings();
  const { buffer } = await fetchAssetImage(settings, photo.immichId, "thumbnail");
  const hash = await computeDhash(buffer);
  if (!hash) {
    db.prepare("UPDATE photos SET dhashFailed=1, error=?, updatedLocalAt=datetime('now') WHERE id=?")
      .run("缩略图解码失败", photoId);
    return false;
  }
  db.prepare(
    "UPDATE photos SET dhash=?, dhashFailed=0, error=NULL, updatedLocalAt=datetime('now') WHERE id=?"
  ).run(hash, photoId);
  return true;
}

/* ---------------- 队列实例与恢复 ---------------- */

export const auditQueue = new TaskQueue("audit", async (ids) => {
  try {
    await auditBatch(ids);
  } catch (e) {
    for (const id of ids) markFailed("audit", id, (e as Error).message);
  }
});

export const composeQueue = new TaskQueue("compose", async (ids) => {
  try {
    await composeBatch(ids);
  } catch (e) {
    for (const id of ids) markFailed("compose", id, (e as Error).message);
  }
});

/** 漫画化限流重试计数（内存态，重启清零重新计） */
const cartoonRetry = new Map<number, number>();
const CARTOON_MAX_RETRY = 6;

function isRateLimitError(msg: string): boolean {
  return /429|rate.?limit|limit_requests|too many requests|限流/i.test(msg);
}

export const cartoonQueue = new TaskQueue("cartoon", async (ids) => {
  const id = ids[0]!; // 漫画化队列批量固定为 1（图像生成逐张执行）
  try {
    await cartoonWorker(id);
    cartoonRetry.delete(id);
  } catch (e) {
    const msg = (e as Error).message;
    const attempts = (cartoonRetry.get(id) ?? 0) + 1;
    // 限流（429）是暂时的：延迟重试，不标失败
    if (isRateLimitError(msg) && attempts <= CARTOON_MAX_RETRY) {
      cartoonRetry.set(id, attempts);
      const waitSec = Math.min(600, 30 * attempts);
      console.warn(`[cartoon] #${id} 触发限流，${waitSec}s 后第 ${attempts}/${CARTOON_MAX_RETRY} 次重试`);
      db.prepare("UPDATE photos SET cartoonStatus='pending', error=? WHERE id=?").run(
        `触发限流，${waitSec}s 后自动重试（第 ${attempts} 次）`,
        id
      );
      setTimeout(() => cartoonQueue.enqueue(id), waitSec * 1000);
      return;
    }
    cartoonRetry.delete(id);
    markFailed("cartoon", id, msg);
  }
});

/** 连续网络失败计数：Immich 宕机/断网时自动暂停队列，避免整批任务被误标失败 */
let dhashNetFailStreak = 0;
/** 本轮运行新算出的哈希数：>0 时队列排空后统一做一次全量比对分组 */
let dhashComputedSinceGroup = 0;

export const dhashQueue = new TaskQueue("dhash", async (ids) => {
  const id = ids[0]!; // dhash 队列 batchSize 固定为 1
  try {
    if (await dhashWorker(id)) dhashComputedSinceGroup++;
    dhashNetFailStreak = 0;
  } catch (e) {
    const msg = (e as Error).message;
    markFailed("dhash", id, msg);
    if (/不可达|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/.test(msg)) {
      dhashNetFailStreak++;
      if (dhashNetFailStreak >= 20) {
        dhashNetFailStreak = 0;
        updateSettings({ dhashPaused: true });
        console.warn(
          "[dhash] 连续 20 次连接 Immich 失败，已自动暂停相似分析队列；Immich 恢复后在队列页点「恢复」即可继续"
        );
      }
    }
  }
});

// 批量哈希算完后统一收尾：全量比对分组 + 组内去重，只跑一次
dhashQueue.onDrained = () => {
  if (dhashComputedSinceGroup === 0) return;
  const computed = dhashComputedSinceGroup;
  dhashComputedSinceGroup = 0;
  try {
    const groups = groupLocalDuplicates();
    const marked = getSettings().dedupEnabled ? applyGroupDedupNow().marked : 0;
    console.log(
      `[dhash] 队列排空，统一比对：新算哈希 ${computed} 个，分组 ${groups} 组，标记重复 ${marked} 张`
    );
  } catch (e) {
    console.warn(`[dhash] 队列排空后的统一比对失败（已忽略）: ${(e as Error).message}`);
  }
};

/** 服务重启后，把 auditing/composing 状态重置为 pending 并重新排队 */
export function recoverQueues(): { audit: number; compose: number } {
  const stuckAudit = db
    .prepare("SELECT id FROM photos WHERE auditStatus = 'auditing'")
    .all() as Array<{ id: number }>;
  db.prepare("UPDATE photos SET auditStatus='pending' WHERE auditStatus='auditing'").run();

  const stuckCompose = db
    .prepare("SELECT id FROM photos WHERE composeStatus = 'composing'")
    .all() as Array<{ id: number }>;
  db.prepare("UPDATE photos SET composeStatus='pending' WHERE composeStatus='composing'").run();

  // 漫画化：cartoonizing 视为中断，连同 pending 一起重新入队
  db.prepare("UPDATE photos SET cartoonStatus='pending' WHERE cartoonStatus='cartoonizing'").run();
  const pendingCartoon = db
    .prepare("SELECT id FROM photos WHERE cartoonStatus = 'pending'")
    .all() as Array<{ id: number }>;
  for (const r of pendingCartoon) cartoonQueue.enqueue(r.id);

  // audit 失败/pending 的不自动重试；compose pending 且 audit 已通过的重新排队
  const pendingCompose = db
    .prepare("SELECT id FROM photos WHERE composeStatus='pending' AND auditStatus='passed'")
    .all() as Array<{ id: number }>;
  for (const r of stuckAudit) auditQueue.enqueue(r.id);
  for (const r of [...stuckCompose, ...pendingCompose]) composeQueue.enqueue(r.id);
  return { audit: stuckAudit.length, compose: stuckCompose.length + pendingCompose.length };
}

/** 新同步的照片入 audit 队列（分批查询，避免 SQLite 占位符数量上限） */
export function enqueueNewPhotos(ids: string[]): void {
  if (ids.length === 0) return;
  const CHUNK = 500;
  const photoIds: number[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(`SELECT id FROM photos WHERE immichId IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as Array<{ id: number }>;
    photoIds.push(...rows.map((r) => r.id));
  }
  const setPending = db.prepare("UPDATE photos SET auditStatus='pending' WHERE id=?");
  db.transaction(() => {
    for (const id of photoIds) setPending.run(id);
  })();
  auditQueue.enqueueMany(photoIds);
}

/**
 * 手动触发的处理调度：队列运行中则入队，跟下一批一起处理；
 * 队列暂停时小批量（≤10 张）绕过队列直接运行，大批量仍入队等待恢复。
 */
function dispatchManual(queue: TaskQueue, ids: number[]): void {
  if (!queue.paused) {
    queue.enqueueMany(ids);
    return;
  }
  const direct = ids.slice(0, 10);
  const rest = ids.slice(10);
  queue.runBypass(direct);
  if (rest.length > 0) queue.enqueueMany(rest);
}

/** 重跑：清空结果重新排队（audit + compose） */
export function reprocessPhotos(ids: number[]): number {
  const reset = db.prepare(
    `UPDATE photos SET auditStatus='pending', composeStatus='pending',
     clarity=NULL, beauty=NULL, story=NULL, totalScore=NULL, reason=NULL,
     instruction=NULL, error=NULL, auditedAt=NULL, composedAt=NULL, updatedLocalAt=datetime('now') WHERE id=?`
  );
  db.transaction(() => {
    for (const id of ids) reset.run(id);
  })();
  for (const id of ids) clearCartoon(id);
  dispatchManual(auditQueue, ids);
  return ids.length;
}

/** 只重新打分：清空评分重新进审核队列（通过后仍会触发装裱） */
export function reauditPhotos(ids: number[]): number {
  const reset = db.prepare(
    `UPDATE photos SET auditStatus='pending', clarity=NULL, beauty=NULL, story=NULL,
     totalScore=NULL, reason=NULL, error=NULL, auditedAt=NULL, updatedLocalAt=datetime('now') WHERE id=?`
  );
  db.transaction(() => {
    for (const id of ids) reset.run(id);
  })();
  dispatchManual(auditQueue, ids);
  return ids.length;
}

/** 只重新装裱：已通过的照片清空装裱结果重新进构图队列，返回实际入队数 */
export function recomposePhotos(ids: number[]): number {
  const rows = ids.length
    ? (db
        .prepare(
          `SELECT id FROM photos WHERE auditStatus='passed' AND id IN (${ids.map(() => "?").join(",")})`
        )
        .all(...ids) as Array<{ id: number }>)
    : [];
  const reset = db.prepare(
    `UPDATE photos SET composeStatus='pending', instruction=NULL, error=NULL,
     composedAt=NULL, updatedLocalAt=datetime('now') WHERE id=?`
  );
  db.transaction(() => {
    for (const r of rows) reset.run(r.id);
  })();
  for (const r of rows) clearCartoon(r.id);
  dispatchManual(composeQueue, rows.map((r) => r.id));
  return rows.length;
}

/* ---------------- 队列批量操作 ---------------- */

/** 全部审核：所有照片清空评分后重新排队 */
export function enqueueAuditAll(): number {
  // 重复照片保持标记、不参与重审（要重审某张可在详情页单独「重新打分」）
  const rows = db
    .prepare("SELECT id FROM photos WHERE auditStatus != 'duplicate'")
    .all() as Array<{ id: number }>;
  return reprocessPhotos(rows.map((r) => r.id));
}

/** 缺省审核：只处理尚无评分结果（pending）或失败的照片 */
export function enqueueAuditMissing(): number {
  // 入队前先用已有 dHash 重建相似组并去重，保证同一组只送一张进 AI
  if (getSettings().localDedupEnabled) {
    try {
      const groups = groupLocalDuplicates();
      const marked = applyGroupDedupNow().marked;
      if (groups > 0 || marked > 0) {
        console.log(`[audit] 入队前相似去重：${groups} 组，标记重复 ${marked} 张`);
      }
    } catch (e) {
      console.warn(`[audit] 入队前相似去重失败（已忽略）: ${(e as Error).message}`);
    }
  }
  const rows = db
    .prepare("SELECT id FROM photos WHERE auditStatus IN ('pending','failed')")
    .all() as Array<{ id: number }>;
  const ids = rows.map((r) => r.id);
  const setPending = db.prepare(
    "UPDATE photos SET auditStatus='pending', error=NULL, updatedLocalAt=datetime('now') WHERE id=?"
  );
  db.transaction(() => {
    for (const id of ids) setPending.run(id);
  })();
  auditQueue.enqueueMany(ids);
  return ids.length;
}

/** 全部构图：所有已通过照片清空装裱指令后重新排队 */
export function enqueueComposeAll(): number {
  const rows = db
    .prepare("SELECT id FROM photos WHERE auditStatus='passed'")
    .all() as Array<{ id: number }>;
  const ids = rows.map((r) => r.id);
  const reset = db.prepare(
    `UPDATE photos SET composeStatus='pending', instruction=NULL, error=NULL,
     composedAt=NULL, updatedLocalAt=datetime('now') WHERE id=?`
  );
  db.transaction(() => {
    for (const id of ids) reset.run(id);
  })();
  for (const id of ids) clearCartoon(id);
  composeQueue.enqueueMany(ids);
  return ids.length;
}

/** 全部相似分析：清空本地组与哈希后全部重新入队（分析推进时增量重建分组） */
export function enqueueDhashAll(): number {
  db.transaction(() => {
    db.prepare(
      `UPDATE photos SET auditStatus='pending', reason=NULL, error=NULL, updatedLocalAt=datetime('now')
       WHERE auditStatus='duplicate' AND duplicateGroupId LIKE 'local:%'`
    ).run();
    db.prepare("UPDATE photos SET duplicateGroupId=NULL WHERE duplicateGroupId LIKE 'local:%'").run();
    db.prepare("UPDATE photos SET dhash=NULL, dhashFailed=0, updatedLocalAt=datetime('now')").run();
  })();
  const rows = db.prepare("SELECT id FROM photos").all() as Array<{ id: number }>;
  dhashQueue.enqueueMany(rows.map((r) => r.id));
  return rows.length;
}

/** 缺省相似分析：只处理尚无哈希或此前失败的照片 */
export function enqueueDhashMissing(): number {
  const rows = db.prepare("SELECT id FROM photos WHERE dhash IS NULL").all() as Array<{ id: number }>;
  db.prepare("UPDATE photos SET dhashFailed=0 WHERE dhash IS NULL AND dhashFailed=1").run();
  dhashQueue.enqueueMany(rows.map((r) => r.id));
  return rows.length;
}

/** 缺省构图：只处理已通过但尚无装裱结果（待构图/失败）的照片 */
export function enqueueComposeMissing(): number {
  const rows = db
    .prepare(
      `SELECT id FROM photos WHERE auditStatus='passed'
       AND (instruction IS NULL OR composeStatus IN ('pending','failed'))`
    )
    .all() as Array<{ id: number }>;
  const ids = rows.map((r) => r.id);
  const setPending = db.prepare(
    "UPDATE photos SET composeStatus='pending', error=NULL, updatedLocalAt=datetime('now') WHERE id=?"
  );
  db.transaction(() => {
    for (const id of ids) setPending.run(id);
  })();
  composeQueue.enqueueMany(ids);
  return ids.length;
}

/** 装裱指令中 AI 判定要漫画化的照片 id（json_extract 取 cartoonize 标志） */
function cartoonizeWantedIds(): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM photos
       WHERE auditStatus='passed' AND instruction IS NOT NULL
         AND json_extract(instruction, '$.cartoonize') = 1`
    )
    .all() as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/** 全部漫画化：所有 AI 判定要漫画化的照片清掉旧漫画图后重新入队 */
export function enqueueCartoonAll(): number {
  const ids = cartoonizeWantedIds();
  db.transaction(() => {
    for (const id of ids) clearCartoon(id);
  })();
  const setPending = db.prepare(
    "UPDATE photos SET cartoonStatus='pending', error=NULL, updatedLocalAt=datetime('now') WHERE id=?"
  );
  db.transaction(() => {
    for (const id of ids) setPending.run(id);
  })();
  cartoonQueue.enqueueMany(ids);
  return ids.length;
}

/** 缺省漫画化：只处理 AI 判定要漫画化但还没有漫画图（或此前失败）的照片 */
export function enqueueCartoonMissing(): number {
  const ids = cartoonizeWantedIds();
  const rows = ids.length
    ? (db
        .prepare(
          `SELECT id FROM photos WHERE id IN (${ids.map(() => "?").join(",")})
           AND (cartoonImage IS NULL OR cartoonStatus IN ('pending','failed'))`
        )
        .all(...ids) as Array<{ id: number }>)
    : [];
  const setPending = db.prepare(
    "UPDATE photos SET cartoonStatus='pending', error=NULL, updatedLocalAt=datetime('now') WHERE id=?"
  );
  db.transaction(() => {
    for (const r of rows) setPending.run(r.id);
  })();
  cartoonQueue.enqueueMany(rows.map((r) => r.id));
  return rows.length;
}

/**
 * 详情页手动触发单张漫画化（用户明确操作，不受频率配额限制）：
 * 在装裱指令上标记 cartoonize（保留/写入画风描述），并入漫画化队列。
 */
export function enqueueCartoonOne(photoId: number, cartoonPrompt?: string): { ok: boolean; error?: string } {
  const settings = getSettings();
  if (!settings.compose.cartoonEnabled || !settings.compose.cartoonModel) {
    return { ok: false, error: "漫画化未开启或未配置漫画化模型（在设置页的装裱组开启）" };
  }
  const row = db
    .prepare("SELECT instruction, auditStatus FROM photos WHERE id = ?")
    .get(photoId) as { instruction: string | null; auditStatus: string } | undefined;
  if (!row) return { ok: false, error: "photo not found" };
  if (row.auditStatus !== "passed") return { ok: false, error: "只有审核通过的照片才能漫画化" };
  if (!row.instruction) return { ok: false, error: "照片尚未装裱，无法漫画化" };
  let ins: Record<string, unknown>;
  try {
    ins = JSON.parse(row.instruction) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "装裱指令损坏，请重新装裱" };
  }
  ins.cartoonize = true;
  if (cartoonPrompt?.trim()) ins.cartoonPrompt = cartoonPrompt.trim().slice(0, 300);
  db.prepare(
    "UPDATE photos SET instruction=?, cartoonStatus='pending', error=NULL, updatedLocalAt=datetime('now') WHERE id=?"
  ).run(JSON.stringify(ins), photoId);
  cartoonQueue.enqueue(photoId);
  return { ok: true };
}

const QUEUES: Record<QueueName, TaskQueue> = {
  audit: auditQueue,
  compose: composeQueue,
  dhash: dhashQueue,
  cartoon: cartoonQueue,
};

/** 取消某个队列的等待任务（已在运行的任务无法中止） */
export function cancelQueue(name: QueueName): number {
  return QUEUES[name].clearWaiting();
}

/** 恢复队列后立即启动等待中的任务 */
export function kickQueue(name: QueueName): void {
  QUEUES[name].kick();
}

export interface QueueStatuses {
  audit: QueueStatus & { dbPending: number };
  compose: QueueStatus & { dbPending: number };
  dhash: QueueStatus & { dbPending: number };
  cartoon: QueueStatus & { dbPending: number };
}

export function queueStatuses(): QueueStatuses {
  const auditPending = (db.prepare("SELECT COUNT(*) c FROM photos WHERE auditStatus IN ('pending','auditing')").get() as { c: number }).c;
  const composePending = (db.prepare("SELECT COUNT(*) c FROM photos WHERE composeStatus IN ('pending','composing') AND auditStatus='passed'").get() as { c: number }).c;
  const dhashPending = (db.prepare("SELECT COUNT(*) c FROM photos WHERE dhash IS NULL AND dhashFailed=0").get() as { c: number }).c;
  const cartoonPending = (db.prepare("SELECT COUNT(*) c FROM photos WHERE cartoonStatus IN ('pending','cartoonizing')").get() as { c: number }).c;
  return {
    audit: { ...auditQueue.status(), dbPending: auditPending },
    compose: { ...composeQueue.status(), dbPending: composePending },
    dhash: { ...dhashQueue.status(), dbPending: dhashPending },
    cartoon: { ...cartoonQueue.status(), dbPending: cartoonPending },
  };
}
