import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { getSettings } from "../config.js";
import { reprocessPhotos, reauditPhotos, recomposePhotos, queueStatuses, composeQueue, setComposeRedoHint, enqueueCartoonOne } from "../queue.js";
import { scheduleMemoryUpdate } from "../memory.js";
import { fetchAssetDetail } from "../immich.js";

interface PhotoRow {
  id: number;
  immichId: string;
  fileName: string | null;
  takenAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  width: number | null;
  height: number | null;
  clarity: number | null;
  beauty: number | null;
  story: number | null;
  totalScore: number | null;
  reason: string | null;
  auditStatus: string;
  composeStatus: string;
  duplicateGroupId: string | null;
  auditVote: string | null;
  composeVote: string | null;
  instruction: string | null;
  error: string | null;
  auditedAt: string | null;
  composedAt: string | null;
  cartoonImage: string | null;
  cartoonStatus: string | null;
  cartoonedAt: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

/** 序列化照片，instruction 解析为对象，附本地代理图片地址 */
export function serializePhoto(row: PhotoRow): Record<string, unknown> {
  let instruction: unknown = null;
  if (row.instruction) {
    try {
      instruction = JSON.parse(row.instruction);
    } catch {
      instruction = null;
    }
  }
  return {
    id: row.id,
    immichId: row.immichId,
    fileName: row.fileName,
    takenAt: row.takenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    width: row.width,
    height: row.height,
    clarity: row.clarity,
    beauty: row.beauty,
    story: row.story,
    totalScore: row.totalScore,
    reason: row.reason,
    auditStatus: row.auditStatus,
    composeStatus: row.composeStatus,
    duplicateGroupId: row.duplicateGroupId,
    auditVote: row.auditVote ?? null,
    composeVote: row.composeVote ?? null,
    instruction,
    error: row.error,
    auditedAt: row.auditedAt ?? null,
    composedAt: row.composedAt ?? null,
    /** 是否已生成漫画图（有则 imageUrl/thumbnailUrl 返回漫画图） */
    cartoon: !!row.cartoonImage,
    /** 漫画化状态：pending / cartoonizing / done / failed / null */
    cartoonStatus: row.cartoonStatus ?? null,
    /** 漫画化完成时间 */
    cartoonedAt: row.cartoonedAt ?? null,
    imageUrl: `/api/assets/${row.id}/image?size=preview`,
    thumbnailUrl: `/api/assets/${row.id}/image?size=thumbnail`,
  };
}

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "必须是 ISO 日期字符串");

const listQuerySchema = z.object({
  status: z.enum(["all", "passed", "rejected", "pending", "duplicate"]).default("all"),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  /** 漫画化筛选：all 全部 / done 已漫画化 / running 漫画化中 / failed 失败 / none 未漫画化 */
  cartoon: z.enum(["all", "done", "running", "failed", "none"]).default("all"),
  /** 赞/踩筛选：all 全部 / liked 任意赞 / disliked 任意踩 / audit 审核赞 / compose 装裱赞 */
  vote: z.enum(["all", "liked", "disliked", "audit", "compose"]).default("all"),
  /** 排序字段：taken 拍摄时间 / audited 评分时间 / composed 装裱时间 / cartooned 漫画化时间 */
  sort: z.enum(["taken", "audited", "composed", "cartooned"]).default("taken"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const SORT_COLUMN: Record<"taken" | "audited" | "composed" | "cartooned", string> = {
  taken: "takenAt",
  audited: "auditedAt",
  composed: "composedAt",
  cartooned: "cartoonedAt",
};

const indexQuerySchema = listQuerySchema.omit({ page: true, pageSize: true });

const regenerateBodySchema = z.object({
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  status: z.enum(["all", "passed", "rejected", "pending", "duplicate"]).optional(),
});

const markBodySchema = z.object({
  ids: z.array(z.coerce.number().int().min(1)).min(1).max(500),
  mark: z.enum(["passed", "rejected"]),
});

function buildWhere(
  status: string,
  startDate?: string,
  endDate?: string,
  cartoon?: string,
  vote?: string
): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (status === "passed") conds.push("auditStatus = 'passed'");
  else if (status === "rejected") conds.push("auditStatus = 'rejected'");
  else if (status === "pending")
    conds.push("auditStatus IN ('pending','auditing','failed')");
  else if (status === "duplicate") conds.push("auditStatus = 'duplicate'");
  if (vote === "liked") conds.push("(auditVote = 'like' OR composeVote = 'like')");
  else if (vote === "disliked") conds.push("(auditVote = 'dislike' OR composeVote = 'dislike')");
  else if (vote === "audit") conds.push("auditVote = 'like'");
  else if (vote === "compose") conds.push("composeVote = 'like'");
  if (cartoon === "done") conds.push("cartoonStatus = 'done'");
  else if (cartoon === "running") conds.push("cartoonStatus IN ('pending','cartoonizing')");
  else if (cartoon === "failed") conds.push("cartoonStatus = 'failed'");
  else if (cartoon === "none") conds.push("(cartoonStatus IS NULL OR cartoonStatus = 'failed')");
  if (startDate) {
    conds.push("takenAt >= ?");
    params.push(startDate);
  }
  if (endDate) {
    conds.push("takenAt <= ?");
    params.push(endDate);
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export default async function photoRoutes(app: FastifyInstance): Promise<void> {
  /** 照片墙列表：status 过滤 + takenAt 日期范围（含边界）+ 分页 */
  app.get("/api/photos", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const q = parsed.data;
    const { where, params } = buildWhere(q.status, q.startDate, q.endDate, q.cartoon, q.vote);
    const total = (db.prepare(`SELECT COUNT(*) c FROM photos ${where}`).get(...params) as { c: number }).c;
    // 排序字段为空（尚未评分/装裱）的排最后，id 作稳定次序兜底
    const col = SORT_COLUMN[q.sort];
    const dir = q.order === "asc" ? "ASC" : "DESC";
    const rows = db
      .prepare(
        `SELECT * FROM photos ${where} ORDER BY ${col} IS NULL, ${col} ${dir}, id ${dir} LIMIT ? OFFSET ?`
      )
      .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as PhotoRow[];
    return reply.send({
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map(serializePhoto),
    });
  });

  /**
   * 轻量索引：仅 id / 拍摄时间 / 宽高，与列表接口同样的筛选与排序。
   * 前端照片墙一次性拉全量索引做虚拟布局与时间轴，再按可见范围回拉详情。
   */
  app.get("/api/photos/index", async (req, reply) => {
    const parsed = indexQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const q = parsed.data;
    const { where, params } = buildWhere(q.status, q.startDate, q.endDate, q.cartoon, q.vote);
    const col = SORT_COLUMN[q.sort];
    const dir = q.order === "asc" ? "ASC" : "DESC";
    const rows = db
      .prepare(
        `SELECT id, takenAt, width, height FROM photos ${where} ORDER BY ${col} IS NULL, ${col} ${dir}, id ${dir}`
      )
      .all(...params) as Array<{ id: number; takenAt: string | null; width: number | null; height: number | null }>;
    return reply.send({
      total: rows.length,
      items: rows.map((r) => ({ id: r.id, t: r.takenAt, w: r.width, h: r.height })),
    });
  });

  /** 照片详情 */
  app.get<{ Params: { id: string } }>("/api/photos/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM photos WHERE id = ?").get(Number(req.params.id)) as
      | PhotoRow
      | undefined;
    if (!row) return reply.code(404).send({ error: "photo not found" });
    return reply.send(serializePhoto(row));
  });

  /**
   * 轮播页信息卡：拍摄时间 / 地点 / 经纬度 / 文件路径。
   * 时间、城市等用库内缓存；经纬度与原始路径只在 Immich 资产详情里有，
   * 按需实时拉取（拉到城市信息时顺手回填本地缓存），Immich 不可达时退化为仅库内字段。
   */
  app.get<{ Params: { id: string } }>("/api/photos/:id/info", async (req, reply) => {
    const row = db.prepare("SELECT * FROM photos WHERE id = ?").get(Number(req.params.id)) as
      | PhotoRow
      | undefined;
    if (!row) return reply.code(404).send({ error: "photo not found" });
    const info: Record<string, unknown> = {
      id: row.id,
      fileName: row.fileName,
      takenAt: row.takenAt,
      city: row.city,
      state: row.state,
      country: row.country,
      latitude: null,
      longitude: null,
      originalPath: null,
      /** true 表示 Immich 不可达，仅返回了本地缓存字段 */
      offline: false,
    };
    try {
      const d = await fetchAssetDetail(getSettings(), row.immichId);
      if (d.takenAt) info.takenAt = d.takenAt;
      if (d.city) info.city = d.city;
      if (d.state) info.state = d.state;
      if (d.country) info.country = d.country;
      if (d.fileName) info.fileName = d.fileName;
      info.latitude = d.latitude ?? null;
      info.longitude = d.longitude ?? null;
      info.originalPath = d.originalPath ?? null;
      if (d.city || d.state || d.country) {
        db.prepare(
          `UPDATE photos SET city=COALESCE(?,city), state=COALESCE(?,state), country=COALESCE(?,country) WHERE id=?`
        ).run(d.city ?? null, d.state ?? null, d.country ?? null, row.id);
      }
    } catch {
      info.offline = true;
    }
    return reply.send(info);
  });

  /** 单张重跑：清空旧结果，重新排队 audit + compose */
  app.post<{ Params: { id: string } }>("/api/photos/:id/regenerate", async (req, reply) => {
    const id = Number(req.params.id);
    const exists = db.prepare("SELECT id FROM photos WHERE id = ?").get(id);
    if (!exists) return reply.code(404).send({ error: "photo not found" });
    reprocessPhotos([id]);
    return reply.send({ ok: true, id });
  });

  /** 单张重新打分：清空评分，只重新排队审核（通过后自动进入装裱） */
  app.post<{ Params: { id: string } }>("/api/photos/:id/reaudit", async (req, reply) => {
    const id = Number(req.params.id);
    const exists = db.prepare("SELECT id FROM photos WHERE id = ?").get(id);
    if (!exists) return reply.code(404).send({ error: "photo not found" });
    reauditPhotos([id]);
    return reply.send({ ok: true, id });
  });

  /** 单张重新装裱：只重新排队构图（仅限已通过的照片） */
  app.post<{ Params: { id: string } }>("/api/photos/:id/recompose", async (req, reply) => {
    const id = Number(req.params.id);
    const exists = db.prepare("SELECT id FROM photos WHERE id = ?").get(id);
    if (!exists) return reply.code(404).send({ error: "photo not found" });
    const queued = recomposePhotos([id]);
    if (queued === 0) {
      return reply.code(400).send({ error: "只有审核通过的照片才能重新装裱" });
    }
    return reply.send({ ok: true, id });
  });

  /** 单张手动漫画化：可附画风描述（可选），不受频率配额限制 */
  app.post<{ Params: { id: string }; Body: { cartoonPrompt?: string } }>(
    "/api/photos/:id/cartoonize",
    async (req, reply) => {
      const id = Number(req.params.id);
      const prompt = typeof req.body?.cartoonPrompt === "string" ? req.body.cartoonPrompt : undefined;
      const r = enqueueCartoonOne(id, prompt);
      if (!r.ok) {
        const status = r.error === "photo not found" ? 404 : 400;
        return reply.code(status).send({ error: r.error });
      }
      return reply.send({ ok: true, id });
    }
  );

  /** 批量重跑：配合时间范围 / 状态筛选 */
  app.post("/api/regenerate", async (req, reply) => {
    const parsed = regenerateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const { startDate, endDate, status } = parsed.data;
    const { where, params } = buildWhere(status ?? "all", startDate, endDate);
    const rows = db.prepare(`SELECT id FROM photos ${where}`).all(...params) as Array<{ id: number }>;
    reprocessPhotos(rows.map((r) => r.id));
    return reply.send({ ok: true, count: rows.length });
  });

  /**
   * 人工标记通过 / 淘汰：直接改审核状态，不写反馈表、不触发 AI 学习。
   * 标记通过的照片若尚未装裱则入队装裱；标记淘汰的从装裱队列移除。
   */
  app.post("/api/photos/mark", async (req, reply) => {
    const parsed = markBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const { ids, mark } = parsed.data;
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, composeStatus FROM photos WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; composeStatus: string }>;
    if (rows.length === 0) return reply.code(404).send({ error: "photo not found" });
    const update = db.prepare(
      `UPDATE photos SET auditStatus=?, error=NULL, updatedLocalAt=datetime('now') WHERE id=?`
    );
    for (const row of rows) {
      update.run(mark, row.id);
      if (mark === "rejected") {
        composeQueue.remove(row.id);
      } else if (row.composeStatus === "pending" || row.composeStatus === "failed") {
        composeQueue.enqueue(row.id);
      }
    }
    const fresh = db
      .prepare(`SELECT * FROM photos WHERE id IN (${placeholders})`)
      .all(...ids) as PhotoRow[];
    return reply.send({ ok: true, count: rows.length, items: fresh.map(serializePhoto) });
  });

  /** 统计：总数 / 通过 / 淘汰 / 待处理 / 队列长度 */
  app.get("/api/stats", async () => {
    const one = (sql: string): number =>
      (db.prepare(sql).get() as { c: number }).c;
    const queues = queueStatuses();
    return {
      total: one("SELECT COUNT(*) c FROM photos"),
      passed: one("SELECT COUNT(*) c FROM photos WHERE auditStatus = 'passed'"),
      rejected: one("SELECT COUNT(*) c FROM photos WHERE auditStatus = 'rejected'"),
      pending: one("SELECT COUNT(*) c FROM photos WHERE auditStatus IN ('pending','auditing','failed')"),
      duplicate: one("SELECT COUNT(*) c FROM photos WHERE auditStatus = 'duplicate'"),
      localDuplicate: one("SELECT COUNT(*) c FROM photos WHERE duplicateGroupId LIKE 'local:%'"),
      dhashDone: one("SELECT COUNT(*) c FROM photos WHERE dhash IS NOT NULL"),
      composed: one("SELECT COUNT(*) c FROM photos WHERE composeStatus = 'done'"),
      queue: {
        audit: queues.audit.pending + queues.audit.running,
        compose: queues.compose.pending + queues.compose.running,
      },
    };
  });

  /** 两队列状态 */
  app.get("/api/queue", async () => queueStatuses());
}

const voteBodySchema = z.object({
  target: z.enum(["audit", "compose"]),
  vote: z.enum(["like", "dislike"]).nullable(),
});

/** 审核判定：用户踩过的一律淘汰、赞过的一律通过，否则按当前设置阈值 */
function verdictOf(row: PhotoRow): "passed" | "rejected" {
  if (row.auditVote === "dislike") return "rejected";
  if (row.auditVote === "like") return "passed";
  const s = getSettings();
  const meets =
    (row.clarity ?? 0) >= s.clarityThreshold &&
    (row.beauty ?? 0) >= s.beautyThreshold &&
    (row.story ?? 0) >= s.storyThreshold;
  return meets ? "passed" : "rejected";
}

/** 登记投票路由（与 photoRoutes 分开导出注册） */
export function registerVoteRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>("/api/photos/:id/vote", async (req, reply) => {
    const parsed = voteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "参数错误" });
    }
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM photos WHERE id = ?").get(id) as PhotoRow | undefined;
    if (!row) return reply.code(404).send({ error: "photo not found" });
    const { target, vote } = parsed.data;

    if (target === "audit") {
      if (row.totalScore === null) {
        return reply.code(400).send({ error: "照片尚未评分，无法评价" });
      }
      const nextStatus = verdictOf({ ...row, auditVote: vote });
      db.prepare(
        `UPDATE photos SET auditVote=?, auditStatus=?, updatedLocalAt=datetime('now') WHERE id=?`
      ).run(vote, nextStatus, id);
      if (vote) {
        // 快照当时的原始分数与阈值，供 AI 总结审核偏好
        const s = getSettings();
        db.prepare(
          `INSERT INTO audit_feedback
           (photoId, vote, clarity, beauty, story, totalScore, reason, thresholdClarity, thresholdBeauty, thresholdStory)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          vote,
          row.clarity,
          row.beauty,
          row.story,
          row.totalScore,
          row.reason,
          s.clarityThreshold,
          s.beautyThreshold,
          s.storyThreshold
        );
        scheduleMemoryUpdate("audit");
      }
      if (nextStatus === "rejected") {
        composeQueue.remove(id);
      } else if (row.composeStatus === "pending" || row.composeStatus === "failed") {
        composeQueue.enqueue(id);
      }
    } else {
      if (!row.instruction) {
        return reply.code(400).send({ error: "照片尚未装裱，无法评价" });
      }
      db.prepare(
        `UPDATE photos SET composeVote=?, updatedLocalAt=datetime('now') WHERE id=?`
      ).run(vote, id);
      if (vote) {
        // 快照当时的装裱指令，供 AI 学习偏好；赞/踩都攒批异步总结（阈值见设置）
        db.prepare(
          "INSERT INTO compose_feedback (photoId, vote, instruction) VALUES (?, ?, ?)"
        ).run(id, vote, row.instruction);
        scheduleMemoryUpdate("compose");
      }
      if (vote === "dislike" && row.instruction) {
        // 立即重新装裱；旧指令快照留在内存态重做提示里，让这次装裱明确避开旧风格，
        // 踩记录本身与其他反馈一起攒够数量后再批量总结进审美记忆
        setComposeRedoHint(id, row.instruction);
        recomposePhotos([id]);
      }
    }

    const fresh = db.prepare("SELECT * FROM photos WHERE id = ?").get(id) as PhotoRow;
    return reply.send(serializePhoto(fresh));
  });
}
