import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { updateSettings } from "../config.js";
import { memoryStatus } from "../memory.js";
import {
  cancelQueue,
  enqueueAuditAll,
  enqueueAuditMissing,
  enqueueCartoonAll,
  enqueueCartoonMissing,
  enqueueComposeAll,
  enqueueComposeMissing,
  enqueueDhashAll,
  enqueueDhashMissing,
  kickQueue,
  queueStatuses,
  type QueueName,
} from "../queue.js";

const nameSchema = z.enum(["audit", "compose", "dhash", "cartoon"]);
const runSchema = z.object({ mode: z.enum(["all", "missing"]) });

function one(sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

const ENQUEUE: Record<QueueName, Record<"all" | "missing", () => number>> = {
  audit: { all: enqueueAuditAll, missing: enqueueAuditMissing },
  compose: { all: enqueueComposeAll, missing: enqueueComposeMissing },
  dhash: { all: enqueueDhashAll, missing: enqueueDhashMissing },
  cartoon: { all: enqueueCartoonAll, missing: enqueueCartoonMissing },
};

const PAUSE_FLAG: Record<QueueName, "auditPaused" | "composePaused" | "dhashPaused" | "cartoonPaused"> = {
  audit: "auditPaused",
  compose: "composePaused",
  dhash: "dhashPaused",
  cartoon: "cartoonPaused",
};

interface QueueCounts {
  pending: number;
  running: number;
  failed: number;
  done: number;
}

/** 队列计数：待处理 / 运行中 / 失败 / 已完成 */
function queueCounts(): { audit: QueueCounts; compose: QueueCounts; dhash: QueueCounts; cartoon: QueueCounts } {
  return {
    audit: {
      pending: one("SELECT COUNT(*) c FROM photos WHERE auditStatus='pending'"),
      running: one("SELECT COUNT(*) c FROM photos WHERE auditStatus='auditing'"),
      failed: one("SELECT COUNT(*) c FROM photos WHERE auditStatus='failed'"),
      done: one("SELECT COUNT(*) c FROM photos WHERE totalScore IS NOT NULL"),
    },
    compose: {
      pending: one(
        "SELECT COUNT(*) c FROM photos WHERE auditStatus='passed' AND composeStatus='pending'"
      ),
      running: one(
        "SELECT COUNT(*) c FROM photos WHERE auditStatus='passed' AND composeStatus='composing'"
      ),
      failed: one(
        "SELECT COUNT(*) c FROM photos WHERE auditStatus='passed' AND composeStatus='failed'"
      ),
      done: one("SELECT COUNT(*) c FROM photos WHERE composeStatus='done'"),
    },
    dhash: {
      pending: one("SELECT COUNT(*) c FROM photos WHERE dhash IS NULL AND dhashFailed=0"),
      // dhash 任务不在库里落 running 状态，以内存队列的 runningCount 为准（下方合并时覆盖）
      running: 0,
      failed: one("SELECT COUNT(*) c FROM photos WHERE dhashFailed=1"),
      done: one("SELECT COUNT(*) c FROM photos WHERE dhash IS NOT NULL"),
    },
    cartoon: {
      pending: one("SELECT COUNT(*) c FROM photos WHERE cartoonStatus='pending'"),
      running: one("SELECT COUNT(*) c FROM photos WHERE cartoonStatus='cartoonizing'"),
      failed: one("SELECT COUNT(*) c FROM photos WHERE cartoonStatus='failed'"),
      done: one("SELECT COUNT(*) c FROM photos WHERE cartoonImage IS NOT NULL"),
    },
  };
}

export default async function queueRoutes(app: FastifyInstance): Promise<void> {
  /** 三个队列的详细状态与计数 */
  app.get("/api/queues", async () => {
    const statuses = queueStatuses();
    const counts = queueCounts();
    counts.dhash.running = statuses.dhash.running;
    return {
      audit: { ...statuses.audit, counts: counts.audit },
      compose: { ...statuses.compose, counts: counts.compose },
      dhash: { ...statuses.dhash, counts: counts.dhash },
      cartoon: { ...statuses.cartoon, counts: counts.cartoon },
      memory: memoryStatus(),
    };
  });

  /** 批量入队：mode=all 全部重跑 / missing 只补缺失 */
  app.post<{ Params: { name: string } }>("/api/queues/:name/run", async (req, reply) => {
    const name = nameSchema.safeParse(req.params.name);
    const body = runSchema.safeParse(req.body ?? {});
    if (!name.success || !body.success) {
      return reply.code(400).send({ error: "队列名或 mode 参数错误" });
    }
    const queued = ENQUEUE[name.data][body.data.mode]();
    return reply.send({ ok: true, queued });
  });

  /** 暂停队列：已排队任务保留，不再启动新任务 */
  app.post<{ Params: { name: string } }>("/api/queues/:name/pause", async (req, reply) => {
    const name = nameSchema.safeParse(req.params.name);
    if (!name.success) return reply.code(400).send({ error: "队列名错误" });
    updateSettings({ [PAUSE_FLAG[name.data]]: true });
    return reply.send({ ok: true });
  });

  /** 恢复队列并立即启动等待中的任务 */
  app.post<{ Params: { name: string } }>("/api/queues/:name/resume", async (req, reply) => {
    const name = nameSchema.safeParse(req.params.name);
    if (!name.success) return reply.code(400).send({ error: "队列名错误" });
    updateSettings({ [PAUSE_FLAG[name.data]]: false });
    kickQueue(name.data);
    return reply.send({ ok: true });
  });

  /** 取消队列中尚未开始的任务（运行中的任务无法中止） */
  app.post<{ Params: { name: string } }>("/api/queues/:name/cancel", async (req, reply) => {
    const name = nameSchema.safeParse(req.params.name);
    if (!name.success) return reply.code(400).send({ error: "队列名错误" });
    const cancelled = cancelQueue(name.data);
    return reply.send({ ok: true, cancelled });
  });
}
