import { db } from "./db.js";
import { getSettings } from "./config.js";
import { hammingDistance } from "./dhash.js";
import { applyGroupDedupNow, enqueueDhashMissing } from "./queue.js";

const GROUP_PREFIX = "local:";

interface Candidate {
  id: number;
  dhash: string;
  takenAt: string | null;
  duplicateGroupId?: string | null;
}

/**
 * 本地相似分组：对所有已有 dhash、且无 Immich 重复组（duplicateGroupId 为空
 * 或已是 local: 组）的照片，按拍摄时间排序后在滑动时间窗内两两比较汉明距离
 * （阈值见 localDedupThreshold），连通的归入同一 'local:' 前缀组。
 * 连拍/同场景照片拍摄时间相近，时间窗（localDedupWindowMin）可避免把不同场合的
 * 相似构图误并；缺拍摄时间的照片只在距离 ≤2（近乎一致）时才参与。
 * 每次全量重算 local 组，幂等；Immich 来源的组不受影响（优先）。
 * 返回新发现的相似组数。
 */
export function groupLocalDuplicates(): number {
  const settings = getSettings();
  if (!settings.localDedupEnabled) return 0;
  const threshold = settings.localDedupThreshold;
  const windowMs = settings.localDedupWindowMin * 60_000;

  const rows = db
    .prepare(
      `SELECT id, dhash, COALESCE(takenAt, createdAt) AS takenAt FROM photos
       WHERE dhash IS NOT NULL
         AND (duplicateGroupId IS NULL OR duplicateGroupId LIKE 'local:%')
       ORDER BY takenAt`
    )
    .all() as Candidate[];

  const timeOf = (r: Candidate): number => {
    const t = r.takenAt ? Date.parse(r.takenAt.replace(" ", "T")) : NaN;
    return Number.isFinite(t) ? t : NaN;
  };
  const times = rows.map(timeOf);

  // 完全相同 dhash 的照片直接归组：部分照片的 takenAt 存在时区偏差（相差 8 小时），
  // 若只按时间窗比较会漏掉这些实际完全相同的照片
  const byHash = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const list = byHash.get(r.dhash);
    if (list) list.push(i);
    else byHash.set(r.dhash, [i]);
  });

  // 并查集：时间窗内两两汉明距离 <= 阈值即连通
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const list of byHash.values()) {
    for (let k = 1; k < list.length; k++) union(list[0]!, list[k]!);
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const ti = times[i], tj = times[j];
      const bothTimed = Number.isFinite(ti) && Number.isFinite(tj);
      if (bothTimed) {
        // 已按时间排序，超出窗口即可停止内层循环
        if (tj - ti > windowMs) break;
        if (hammingDistance(rows[i].dhash, rows[j].dhash) <= threshold) union(i, j);
      } else if (hammingDistance(rows[i].dhash, rows[j].dhash) <= Math.min(2, threshold)) {
        union(i, j);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const root = find(i);
    const list = clusters.get(root);
    if (list) list.push(rows[i].id);
    else clusters.set(root, [rows[i].id]);
  }

  const clearGroup = db.prepare("UPDATE photos SET duplicateGroupId = NULL WHERE id = ?");
  const setGroup = db.prepare("UPDATE photos SET duplicateGroupId = ? WHERE id = ?");

  let groups = 0;
  const tx = db.transaction(() => {
    for (const ids of clusters.values()) {
      for (const id of ids) clearGroup.run(id);
      if (ids.length < 2) continue;
      groups++;
      const groupId = `${GROUP_PREFIX}${Math.min(...ids)}`;
      for (const id of ids) setGroup.run(groupId, id);
    }
    // 阈值/窗口调整或哈希新增导致组解散后：恢复不再属于任何组的已标记照片
    //（两种理由前缀都来自组内去重标记；若还有组标记的不会被误平反）
    db.prepare(
      `UPDATE photos SET auditStatus='pending', reason=NULL, error=NULL, updatedLocalAt=datetime('now')
       WHERE auditStatus='duplicate' AND reason LIKE '与组内%（保留%'
         AND duplicateGroupId IS NULL`
    ).run();
  });
  tx();
  return groups;
}

/**
 * 批量审核前预分组：为一批已经算好 dhash 的照片建立 local 相似组并立刻执行组内去重，
 * 使同一组只留一张进入 AI 审核（返回后调用方需重新过滤 duplicate）。
 * 与逐张调用 assignLocalGroupForPhoto 相比，候选照片只读一次。
 */
export function assignLocalGroupsForBatch(photoIds: number[]): void {
  const settings = getSettings();
  if (!settings.localDedupEnabled || photoIds.length === 0) return;
  const threshold = settings.localDedupThreshold;
  const windowMs = settings.localDedupWindowMin * 60_000;

  const rows = db
    .prepare(
      `SELECT id, dhash, COALESCE(takenAt, createdAt) AS takenAt, duplicateGroupId
       FROM photos
       WHERE dhash IS NOT NULL
         AND (duplicateGroupId IS NULL OR duplicateGroupId LIKE 'local:%')
       ORDER BY takenAt`
    )
    .all() as Candidate[];
  if (rows.length < 2) return;

  const timeOf = (r: Candidate): number => {
    const t = r.takenAt ? Date.parse(r.takenAt.replace(" ", "T")) : NaN;
    return Number.isFinite(t) ? t : NaN;
  };
  const times = rows.map(timeOf);
  const indexById = new Map<number, number>();
  rows.forEach((r, i) => indexById.set(r.id, i));
  const byHash = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const list = byHash.get(r.dhash);
    if (list) list.push(i);
    else byHash.set(r.dhash, [i]);
  });
  const untimed: number[] = [];
  times.forEach((t, i) => {
    if (!Number.isFinite(t)) untimed.push(i);
  });

  const setGroup = db.prepare("UPDATE photos SET duplicateGroupId = ? WHERE id = ?");
  const affected = new Set<string>();

  const tx = db.transaction(() => {
    for (const id of photoIds) {
      const selfIdx = indexById.get(id);
      if (selfIdx === undefined) continue;
      const self = rows[selfIdx]!;
      // Immich 重复组优先不动；已有 local 组的只补做组内去重，不再重新归组
      if (self.duplicateGroupId) {
        if (self.duplicateGroupId.startsWith(GROUP_PREFIX)) affected.add(self.duplicateGroupId);
        continue;
      }
      const t = times[selfIdx]!;
      let bestIdx = -1;
      let bestDist = Infinity;
      const consider = (j: number, limit: number): void => {
        if (j === selfIdx) return;
        const other = rows[j]!;
        const dist = hammingDistance(self.dhash, other.dhash);
        if (dist <= limit && dist < bestDist) {
          bestDist = dist;
          bestIdx = j;
        }
      };
      // 完全相同的哈希优先（不受时间窗影响，兼容 takenAt 时区偏差）
      for (const j of byHash.get(self.dhash) ?? []) consider(j, 0);
      if (Number.isFinite(t)) {
        // 已按拍摄时间排序：向左右扩展，超出时间窗即停止
        for (let j = selfIdx - 1; j >= 0; j--) {
          const tj = times[j]!;
          if (!Number.isFinite(tj)) continue;
          if (t - tj > windowMs) break;
          consider(j, threshold);
        }
        for (let j = selfIdx + 1; j < rows.length; j++) {
          const tj = times[j]!;
          if (!Number.isFinite(tj)) continue;
          if (tj - t > windowMs) break;
          consider(j, threshold);
        }
        for (const j of untimed) consider(j, Math.min(2, threshold));
      } else {
        // 无拍摄时间：与原逻辑一致，按更严格的阈值与所有照片比较
        for (let j = 0; j < rows.length; j++) consider(j, Math.min(2, threshold));
      }
      if (bestIdx < 0) continue;
      const other = rows[bestIdx]!;
      const groupId =
        other.duplicateGroupId ?? `${GROUP_PREFIX}${Math.min(self.id, other.id)}`;
      setGroup.run(groupId, self.id);
      setGroup.run(groupId, other.id);
      self.duplicateGroupId = groupId;
      other.duplicateGroupId = groupId;
      affected.add(groupId);
    }
  });
  tx();
  for (const g of affected) applyGroupDedupNow(g);
}

/**
 * 审核完成后的增量分组：只把这张照片与时间窗 ±window 内已有 dhash 的照片比较，
 * 命中（距离 ≤ 阈值）则并入对方所在 local 组（无组则以对方为基点建组）。
 * 避免每次审核都全量重算。
 */
export function assignLocalGroupForPhoto(photoId: number): void {
  const settings = getSettings();
  if (!settings.localDedupEnabled) return;
  const self = db
    .prepare(
      `SELECT id, dhash, COALESCE(takenAt, createdAt) AS takenAt, duplicateGroupId
       FROM photos WHERE id = ?`
    )
    .get(photoId) as
    | { id: number; dhash: string | null; takenAt: string | null; duplicateGroupId: string | null }
    | undefined;
  if (!self?.dhash) return;
  // 已属于 Immich 重复组的不动（Immich 组优先）
  if (self.duplicateGroupId && !self.duplicateGroupId.startsWith(GROUP_PREFIX)) return;

  const t = self.takenAt ? Date.parse(self.takenAt.replace(" ", "T")) : NaN;
  const windowMs = settings.localDedupWindowMin * 60_000;
  const others = db
    .prepare(
      `SELECT id, dhash, COALESCE(takenAt, createdAt) AS takenAt, duplicateGroupId
       FROM photos WHERE id != ? AND dhash IS NOT NULL
         AND (duplicateGroupId IS NULL OR duplicateGroupId LIKE 'local:%')`
    )
    .all(photoId) as Array<{
    id: number;
    dhash: string;
    takenAt: string | null;
    duplicateGroupId: string | null;
  }>;

  let best: { id: number; dist: number; groupId: string | null } | null = null;
  for (const o of others) {
    const ot = o.takenAt ? Date.parse(o.takenAt.replace(" ", "T")) : NaN;
    const limit =
      Number.isFinite(t) && Number.isFinite(ot) && Math.abs(t - ot) > windowMs
        ? Math.min(2, settings.localDedupThreshold)
        : settings.localDedupThreshold;
    const dist = hammingDistance(self.dhash, o.dhash);
    if (dist <= limit && (best === null || dist < best.dist)) {
      best = { id: o.id, dist, groupId: o.duplicateGroupId };
    }
  }
  if (!best) return;
  const groupId = best.groupId ?? `${GROUP_PREFIX}${Math.min(self.id, best.id)}`;
  const setGroup = db.prepare("UPDATE photos SET duplicateGroupId = ? WHERE id = ?");
  db.transaction(() => {
    setGroup.run(groupId, self.id);
    setGroup.run(groupId, best.id);
  })();
}

/** 同步后的入口：把缺少 dhash 的照片排进相似分析队列（队列 worker 负责算哈希、增量分组与去重） */
export function localDedupAfterSync(): void {
  const settings = getSettings();
  if (!settings.localDedupEnabled) return;
  try {
    const queued = enqueueDhashMissing();
    if (queued > 0) console.log(`[localDedup] 相似分析入队：${queued} 张`);
  } catch (e) {
    console.warn(`[localDedup] 处理失败（已忽略）: ${(e as Error).message}`);
  }
}
