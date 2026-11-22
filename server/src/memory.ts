import { db, DATA_DIR } from "./db.js";
import { getSettings } from "./config.js";
import { chatCompletion, AiError } from "./ai.js";
import { fetchAssetImage } from "./immich.js";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

type ChatMessageContent = Array<
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
>;

/**
 * AI 审美记忆：赞/踩记录不逐条塞进提示词（上下文会爆炸），
 * 而是攒够数量后由 AI 总结成一段简短记忆存 ai_memory 表，
 * 审核/装裱时注入系统提示词。投票后异步触发更新（增量计数阈值，
 * 阈值与总结提示词均可在设置中配置），也可通过设置接口手动重新生成。
 */

export type MemoryKind = "compose" | "audit";

const MEMORY_KEY: Record<MemoryKind, string> = { compose: "compose", audit: "audit" };
const CURSOR_KEY: Record<MemoryKind, string> = {
  compose: "composeFeedbackCursor",
  audit: "auditFeedbackCursor",
};
const FEEDBACK_TABLE: Record<MemoryKind, string> = {
  compose: "compose_feedback",
  audit: "audit_feedback",
};
/** 附图的压缩尺寸（与批量审核一致：本地视觉模型随图像 token 数爆炸） */
const MEMORY_IMG_DIM = 512;

/** 取某张照片的压缩预览图（JPEG data URL）；照片已删除或拉图失败时返回 null（不阻塞学习） */
async function feedbackImageDataUrl(photoId: number): Promise<string | null> {
  const row = db.prepare("SELECT immichId FROM photos WHERE id = ?").get(photoId) as
    | { immichId: string }
    | undefined;
  if (!row) return null;
  try {
    const settings = getSettings();
    const { buffer } = await fetchAssetImage(settings, row.immichId, "preview");
    return await shrinkToDataUrl(buffer);
  } catch {
    return null;
  }
}

async function shrinkToDataUrl(buffer: Buffer): Promise<string> {
  const out = await sharp(buffer, { limitInputPixels: 1e8 })
    .rotate() // 按 EXIF 方向摆正，与模型看到的画面一致
    .resize(MEMORY_IMG_DIM, MEMORY_IMG_DIM, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

/** 同步读漫画图文件（不存在返回 null） */
function cartoonImageBuffer(photoId: number): Buffer | null {
  const row = db.prepare("SELECT cartoonImage FROM photos WHERE id = ?").get(photoId) as
    | { cartoonImage: string | null }
    | undefined;
  if (!row?.cartoonImage) return null;
  try {
    return fs.readFileSync(path.join(DATA_DIR, "cartoon", path.basename(row.cartoonImage)));
  } catch {
    return null;
  }
}

/** 尚未总结进记忆的反馈条数（游标之后的新增赞/踩） */
export function pendingFeedback(kind: MemoryKind): number {
  return (
    db
      .prepare(`SELECT COUNT(*) c FROM ${FEEDBACK_TABLE[kind]} WHERE id > ?`)
      .get(getCursor(kind)) as { c: number }
  ).c;
}

export function getMemory(kind: MemoryKind): string | null {
  const row = db.prepare("SELECT value FROM ai_memory WHERE key = ?").get(MEMORY_KEY[kind]) as
    | { value: string }
    | undefined;
  return row?.value || null;
}

function getCursor(kind: MemoryKind): number {
  const row = db.prepare("SELECT value FROM ai_memory WHERE key = ?").get(CURSOR_KEY[kind]) as
    | { value: string }
    | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : 0;
}

function setMemory(kind: MemoryKind, value: string, cursor: number): void {
  const upsert = db.prepare(
    "INSERT INTO ai_memory (key, value, updatedAt) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt"
  );
  const tx = db.transaction(() => {
    upsert.run(MEMORY_KEY[kind], value);
    upsert.run(CURSOR_KEY[kind], String(cursor));
  });
  tx();
}

interface ComposeFeedbackRow {
  id: number;
  photoId: number;
  vote: string;
  instruction: string | null;
}

interface AuditFeedbackRow {
  id: number;
  photoId: number;
  vote: string;
  clarity: number | null;
  beauty: number | null;
  story: number | null;
  totalScore: number | null;
  reason: string | null;
  thresholdClarity: number | null;
  thresholdBeauty: number | null;
  thresholdStory: number | null;
}

/** 一条待学习的反馈：反馈表 id + 一行文字说明 + 对应照片 id（用于附压缩图） */
interface FeedbackItem {
  id: number;
  line: string;
  photoId: number;
}

function voteTag(vote: string): string {
  return vote === "like" ? "赞" : "踩";
}

function composeItems(rows: ComposeFeedbackRow[]): FeedbackItem[] {
  return rows.map((r) => ({
    id: r.id,
    line: `- 【${voteTag(r.vote)}】装裱指令：${r.instruction ? r.instruction.slice(0, 800) : "(无指令)"}`,
    photoId: r.photoId,
  }));
}

function auditItems(rows: AuditFeedbackRow[]): FeedbackItem[] {
  return rows.map((r) => ({
    id: r.id,
    line:
      `- 【${voteTag(r.vote)}】分数：清晰 ${r.clarity ?? "?"}/美观 ${r.beauty ?? "?"}/故事 ${r.story ?? "?"}` +
      `（总 ${r.totalScore ?? "?"}，当时阈值 清晰 ${r.thresholdClarity ?? "?"}/美观 ${r.thresholdBeauty ?? "?"}/故事 ${r.thresholdStory ?? "?"}` +
      `，AI 评语：${(r.reason ?? "").slice(0, 80)}）`,
    photoId: r.photoId,
  }));
}

const MEMORY_PROMPT_KEY: Record<MemoryKind, "memoryComposePrompt" | "memoryAuditPrompt"> = {
  compose: "memoryComposePrompt",
  audit: "memoryAuditPrompt",
};

let regenerating = false;

export interface MemoryQueueStatus {
  /** 待学习：游标之后尚未总结的赞/踩条数 */
  pending: number;
  /** 自动学习阈值（攒够多少条触发一次总结） */
  threshold: number;
  /** 自动学习开关（设置里的 memoryEnabled） */
  enabled: boolean;
  /** 是否正在总结 */
  running: boolean;
  /** 是否已有记忆 */
  learned: boolean;
}

/** 队列管理页展示用：两类反馈（审核/装裱）的学习状态 */
export function memoryStatus(): Record<MemoryKind, MemoryQueueStatus> {
  const s = getSettings();
  return {
    audit: {
      pending: pendingFeedback("audit"),
      threshold: s.memoryThreshold,
      enabled: s.memoryEnabled,
      running: regenerating,
      learned: getMemory("audit") !== null,
    },
    compose: {
      pending: pendingFeedback("compose"),
      threshold: s.memoryThreshold,
      enabled: s.memoryEnabled,
      running: regenerating,
      learned: getMemory("compose") !== null,
    },
  };
}

/**
 * 重新总结审美记忆（compose 用装裱赞/踩原文，audit 用审核赞/踩的分数+阈值）。
 * 所有尚未学习的反馈（游标之后；无记忆时全量）按学习阈值分批发送，
 * 每批的文字与对应照片压缩图全部发给 AI，逐批迭代进记忆；
 * 每批成功后即落库并推进游标，中途失败时保留已学批次的成果，剩余批次留待下次。
 */
export async function regenerateMemory(
  kind: MemoryKind
): Promise<{ ok: boolean; memory?: string; error?: string }> {
  if (regenerating) return { ok: false, error: "正在生成中" };
  regenerating = true;
  try {
    const settings = getSettings();
    const batchSize = Math.max(1, settings.memoryThreshold);
    const cursor = getMemory(kind) === null ? 0 : getCursor(kind);
    let items: FeedbackItem[];
    if (kind === "compose") {
      const rows = db
        .prepare(`SELECT id, photoId, vote, instruction FROM ${FEEDBACK_TABLE.compose} WHERE id > ? ORDER BY id ASC`)
        .all(cursor) as ComposeFeedbackRow[];
      items = composeItems(rows);
    } else {
      const rows = db
        .prepare(`SELECT * FROM ${FEEDBACK_TABLE.audit} WHERE id > ? ORDER BY id ASC`)
        .all(cursor) as AuditFeedbackRow[];
      items = auditItems(rows);
    }
    if (items.length === 0) {
      return { ok: false, error: getMemory(kind) === null ? "暂无赞/踩记录" : "没有待学习的新反馈" };
    }

    const totalBatches = Math.ceil(items.length / batchSize);
    for (let b = 0; b < totalBatches; b++) {
      const batch = items.slice(b * batchSize, (b + 1) * batchSize);
      const batchMaxId = Math.max(...batch.map((it) => it.id));

      // 每条反馈都附上对应照片的压缩预览图；拉图失败 / 照片已删除的条目只发文字，不阻塞学习。
      // 装裱学习额外附上漫画图（该照片若被漫画化）：赞/踩针对的是用户实际看到的漫画效果
      const images = await Promise.all(
        batch.map(async (it) => {
          const cartoonBuf = kind === "compose" ? cartoonImageBuffer(it.photoId) : null;
          return {
            original: await feedbackImageDataUrl(it.photoId),
            cartoon: cartoonBuf ? await shrinkToDataUrl(cartoonBuf) : null,
          };
        })
      );
      const attached = images.filter((i) => i.original || i.cartoon).length;

      // 带上记忆将要注入的工作提示词（审核/装裱），让 AI 结合使用场景理解哪些偏好值得记；
      // 迭代式总结：在已有记忆（含前面批次刚学到的）基础上修改，吸收本批反馈
      const workPrompt =
        kind === "compose" ? settings.compose.prompt : settings.audit.prompt;
      const header =
        `这段审美记忆之后会注入到以下${kind === "compose" ? "装裱" : "审核"}系统提示词中使用（结合它理解记忆该怎么写、记什么才有用）：\n${workPrompt}\n\n` +
        `以下是用户的赞/踩记录（按时间正序，第 ${b + 1}/${totalBatches} 批），每条记录后面跟着对应照片的压缩图（部分条目可能无图）。` +
        (kind === "compose"
          ? `若某条附了两张图，则第一张是原照片、第二张是装裱时 AI 生成的漫画图（用户看到的是漫画图）。`
          : "") +
        `请结合照片画面理解用户为什么赞/踩。`;
      const prev = getMemory(kind);
      const headerWithPrev = prev
        ? `已有审美记忆（在其基础上修改：保留仍成立的结论，吸收新反馈，剔除已过时的）：\n${prev}\n\n${header}`
        : header;

      const userContent: ChatMessageContent = [{ type: "text", text: headerWithPrev }];
      batch.forEach((it, i) => {
        userContent.push({ type: "text", text: it.line });
        const img = images[i];
        if (img?.original) userContent.push({ type: "image_url", image_url: { url: img.original } });
        if (img?.cartoon) userContent.push({ type: "image_url", image_url: { url: img.cartoon } });
      });

      const content = await chatCompletion({
        group: kind,
        jsonMode: false,
        settings,
        messages: [
          { role: "system", content: settings[MEMORY_PROMPT_KEY[kind]] },
          { role: "user", content: userContent },
        ],
      });
      const memory = content.replace(/^```(?:text|markdown)?|```$/g, "").trim().slice(0, 800);
      if (!memory) throw new AiError(`第 ${b + 1}/${totalBatches} 批学习返回为空`);
      setMemory(kind, memory, batchMaxId);
      if (kind === "compose") {
        // 装裱踩记录的教训已总结进记忆，落库即删（赞记录保留为长期偏好样本）；
        // 失败时不删，留给下次总结
        db.prepare(`DELETE FROM ${FEEDBACK_TABLE.compose} WHERE vote='dislike' AND id <= ?`).run(batchMaxId);
      }
      console.log(
        `[memory] ${kind} 审美记忆已更新（第 ${b + 1}/${totalBatches} 批，反馈 ${batch.length} 条，附图 ${attached} 张，游标 ${batchMaxId}）`
      );
    }
    return { ok: true, memory: getMemory(kind) ?? undefined };
  } catch (e) {
    console.warn(`[memory] ${kind} 审美记忆生成失败（已学批次保留）: ${(e as Error).message}`);
    return { ok: false, error: (e as Error).message };
  } finally {
    regenerating = false;
  }
}

/** 投票后调用：开启自动学习且新增反馈达到阈值时，异步重新总结记忆 */
export function scheduleMemoryUpdate(kind: MemoryKind): void {
  if (regenerating) return;
  try {
    const s = getSettings();
    if (!s.memoryEnabled) return;
    const unseen = pendingFeedback(kind);
    const shouldUpdate = getMemory(kind) === null ? unseen >= 1 : unseen >= s.memoryThreshold;
    if (shouldUpdate) void regenerateMemory(kind);
  } catch (e) {
    console.warn(`[memory] 触发 ${kind} 审美记忆更新失败（已忽略）: ${(e as Error).message}`);
  }
}
