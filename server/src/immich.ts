import type { Settings } from "./config.js";
import { db } from "./db.js";
import { normalizeTakenAt, wallClock } from "./timeutil.js";

export class ImmichError extends Error {}

export interface ImmichAsset {
  id: string;
  /** IMAGE / VIDEO / AUDIO / OTHER，来自资产详情；搜索接口可能缺省 */
  type?: string;
  fileName?: string;
  takenAt?: string;
  createdAt?: string;
  updatedAt?: string;
  width?: number;
  height?: number;
  city?: string;
  state?: string;
  country?: string;
}

function apiBase(settings: Settings): string {
  const base = settings.immichBaseUrl.replace(/\/+$/, "");
  if (!base) throw new ImmichError("未配置 immichBaseUrl");
  return base;
}

async function immichFetch(
  settings: Settings,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!settings.immichApiKey) throw new ImmichError("未配置 immichApiKey");
  let res: Response;
  try {
    res = await fetch(`${apiBase(settings)}${path}`, {
      ...init,
      headers: {
        "x-api-key": settings.immichApiKey,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ImmichError(`Immich 不可达: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ImmichError(`Immich HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

/** 防御性解析资产条目（兼容字段大小写/嵌套差异） */
function parseAsset(raw: unknown): ImmichAsset | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const id = a.id ?? a.assetId ?? a.asset_id;
  if (typeof id !== "string" || !id) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const exif = (a.exifInfo ?? a.exif ?? {}) as Record<string, unknown>;
  return {
    id,
    type: str(a.type),
    fileName: str(a.fileName ?? a.originalFileName ?? (typeof a.originalPath === "string" ? a.originalPath.split("/").pop() : undefined)),
    // localDateTime 是拍摄地墙钟时间被当作 UTC 存储的，直接取墙钟部分；
    // 其余字段（真 UTC 时刻）才做时区换算
    takenAt:
      wallClock(str(a.localDateTime)) ??
      normalizeTakenAt(str(a.takenAt ?? a.fileCreatedAt ?? exif.dateTimeOriginal)) ??
      undefined,
    createdAt: str(a.createdAt ?? a.fileCreatedAt),
    updatedAt: str(a.updatedAt ?? a.fileModifiedAt ?? a.createdAt),
    width: num(a.width ?? exif.exifImageWidth),
    height: num(a.height ?? exif.exifImageHeight),
    city: str(exif.city),
    state: str(exif.state),
    country: str(exif.country),
  };
}

/** 从响应体中提取资产数组 + 下一页令牌（防御性，兼容 assets.nextPage/nextCursor 与顶层字段） */
function parseSearchResponse(data: unknown): { items: ImmichAsset[]; next: string | null } {
  const d = (data ?? {}) as Record<string, unknown>;
  const assetsObj =
    d.assets && typeof d.assets === "object" ? (d.assets as Record<string, unknown>) : undefined;
  const arr =
    (Array.isArray(assetsObj?.items) ? assetsObj.items : undefined) ??
    (Array.isArray(d.assets) ? d.assets : undefined) ??
    (Array.isArray(d.items) ? d.items : undefined) ??
    (Array.isArray(d) ? (d as unknown[]) : []);
  const items = arr.map(parseAsset).filter((a): a is ImmichAsset => a !== null);
  const nextRaw =
    assetsObj?.nextPage ?? assetsObj?.nextCursor ??
    d.nextCursor ?? d.nextPage ?? d.nextPageCursor ?? null;
  const next = typeof nextRaw === "string" && nextRaw ? nextRaw : null;
  return { items, next };
}

export interface SyncResult {
  scanned: number;
  upserted: number;
  addedIds: string[];
}

/**
 * 全量同步：POST /api/search/metadata 分页拉取。
 * Immich 的下一页令牌在 assets.nextPage（页码字符串，请求体回传 page）或
 * assets.nextCursor（不透明游标，回传 cursor），两种形态都兼容。
 * updatedAfter 可选（增量）。
 */
export async function syncAssets(settings: Settings, updatedAfter?: string): Promise<SyncResult> {
  let nextPage: number | null = null;
  let nextCursor: string | null = null;
  let scanned = 0;
  const addedIds: string[] = [];
  let upserted = 0;
  const upsertOne = (a: ImmichAsset): void => {
    if (a.type && a.type !== "IMAGE") return; // 防御：视频/音频等资产不进入照片墙
    const isNew = upsertPhoto(a);
    upserted++;
    if (isNew) addedIds.push(a.id);
  };
  for (let page = 0; page < 2000; page++) {
    const body: Record<string, unknown> = { type: "IMAGE", size: 1000 };
    if (nextCursor) body.cursor = nextCursor;
    else if (nextPage !== null) body.page = nextPage;
    if (updatedAfter) body.updatedAfter = updatedAfter;
    const res = await immichFetch(settings, "/api/search/metadata", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json();
    const { items, next } = parseSearchResponse(data);
    // 逐页写入并包事务：大图库（数万张）下单条 upsert 会很慢
    db.transaction(() => {
      for (const a of items) upsertOne(a);
    })();
    scanned += items.length;
    if (!next || items.length === 0) break;
    // 页码形态（如 "2"）回传 page；其余按游标处理
    if (/^\d+$/.test(next)) {
      nextPage = Number(next);
      nextCursor = null;
    } else {
      nextCursor = next;
      nextPage = null;
    }
  }

  return { scanned, upserted, addedIds };
}

/** 返回是否为新记录（true 时调用方应把照片放入 audit 队列） */
export function upsertPhoto(a: ImmichAsset): boolean {
  const existing = db
    .prepare("SELECT id, updatedAt FROM photos WHERE immichId = ?")
    .get(a.id) as { id: number; updatedAt: string | null } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE photos SET fileName=?, takenAt=?, createdAt=?, updatedAt=?, width=?, height=?,
       city=COALESCE(?,city), state=COALESCE(?,state), country=COALESCE(?,country),
       updatedLocalAt=datetime('now') WHERE immichId=?`
    ).run(a.fileName ?? null, a.takenAt ?? null, a.createdAt ?? null, a.updatedAt ?? null,
      a.width ?? null, a.height ?? null, a.city ?? null, a.state ?? null, a.country ?? null, a.id);
    return false;
  }
  db.prepare(
    `INSERT INTO photos (immichId, fileName, takenAt, createdAt, updatedAt, width, height, city, state, country)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(a.id, a.fileName ?? null, a.takenAt ?? null, a.createdAt ?? null, a.updatedAt ?? null,
    a.width ?? null, a.height ?? null, a.city ?? null, a.state ?? null, a.country ?? null);
  return true;
}

/**
 * 拉取 Immich 重复照片组（GET /api/duplicates）。
 * OpenAPI 规范响应结构为 DuplicateResponseDto[]：
 *   { duplicateId: string(uuid), assets: AssetResponseDto[], suggestedKeepAssetIds: string[] }
 * 这里防御性解析，同时兼容 assetIds / duplicateIds / ids 等纯 id 数组字段。
 * 返回 immichId 数组的数组（只保留 ≥2 张的组）。
 */
export async function fetchDuplicateSets(settings: Settings): Promise<string[][]> {
  const res = await immichFetch(settings, "/api/duplicates");
  const data: unknown = await res.json();
  const arr = Array.isArray(data) ? data : [];
  const sets: string[][] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const ids = new Set<string>();
    if (Array.isArray(g.assets)) {
      for (const a of g.assets) {
        const parsed = parseAsset(a);
        if (parsed) ids.add(parsed.id);
      }
    }
    for (const key of ["assetIds", "duplicateIds", "ids"]) {
      const v = g[key];
      if (Array.isArray(v)) {
        for (const id of v) {
          if (typeof id === "string" && id) ids.add(id);
        }
      }
    }
    if (ids.size >= 2) sets.push([...ids]);
  }
  return sets;
}

/** 同步成功后调用：清空旧的 Immich 重复组（保留本地 local: 相似组），再写入本次重复组关系。返回组数 */
export async function refreshDuplicateGroups(settings: Settings): Promise<number> {
  const sets = await fetchDuplicateSets(settings);
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE photos SET duplicateGroupId = NULL WHERE duplicateGroupId IS NOT NULL AND duplicateGroupId NOT LIKE 'local:%'"
    ).run();
    const upd = db.prepare("UPDATE photos SET duplicateGroupId = ? WHERE immichId = ?");
    for (const ids of sets) {
      const groupId = [...ids].sort()[0]; // 组 id 取组内最小 immichId，稳定可复现
      for (const id of ids) upd.run(groupId, id);
    }
  });
  tx();
  return sets.length;
}

/** 同步成功后调用：刷新重复组关系（dedupEnabled 关闭或拉取失败时静默跳过，不影响同步主流程） */
export async function refreshDuplicatesSafe(settings: Settings): Promise<void> {
  if (!settings.dedupEnabled) return;
  try {
    const groups = await refreshDuplicateGroups(settings);
    console.log(`[dedup] 重复组已刷新：${groups} 组`);
  } catch (e) {
    console.warn(`[dedup] 拉取重复组失败（已忽略）: ${(e as Error).message}`);
  }
}

/** 拉取单个资产元数据（用于 webhook / 单张同步），返回是否为新资产；非图片资产不入库并清除已有记录 */
export async function syncSingleAsset(settings: Settings, assetId: string): Promise<boolean> {
  const res = await immichFetch(settings, `/api/assets/${assetId}`);
  const data: unknown = await res.json();
  const asset = parseAsset(data);
  if (!asset) throw new ImmichError(`无法解析资产 ${assetId}`);
  if (asset.type && asset.type !== "IMAGE") {
    const removed = db.prepare("DELETE FROM photos WHERE immichId = ?").run(assetId).changes;
    if (removed > 0) console.log(`[sync] 已筛除非图片资产 ${assetId}（type=${asset.type}）`);
    return false;
  }
  return upsertPhoto(asset);
}

export interface AssetDetail {
  city?: string;
  state?: string;
  country?: string;
  takenAt?: string;
  /** GPS 经纬度（exifInfo.latitude/longitude） */
  latitude?: number;
  longitude?: number;
  /** Immich 中的原始文件路径 */
  originalPath?: string;
  fileName?: string;
}

/**
 * 拉取资产详情（GET /api/assets/{id}）。
 * 搜索结果里不含位置字段，装裱构图与轮播页信息卡需要时按需单拉：
 * 城市/州/国（Immich 逆地理编码）、GPS 经纬度、原始文件路径，拿到后可缓存进库。
 */
export async function fetchAssetDetail(settings: Settings, assetId: string): Promise<AssetDetail> {
  const res = await immichFetch(settings, `/api/assets/${assetId}`);
  const data: unknown = await res.json();
  const d = (data ?? {}) as Record<string, unknown>;
  const exif = (d.exifInfo ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    city: str(exif.city),
    state: str(exif.state),
    country: str(exif.country),
    latitude: num(exif.latitude),
    longitude: num(exif.longitude),
    originalPath: str(d.originalPath),
    fileName: str(d.originalFileName),
    takenAt:
      wallClock(str(d.localDateTime)) ??
      normalizeTakenAt(str(d.fileCreatedAt ?? exif.dateTimeOriginal)) ??
      undefined,
  };
}

/** 拉取图片二进制（preview/thumbnail），用于代理与 AI 传图 */
export async function fetchAssetImage(
  settings: Settings,
  assetId: string,
  size: "preview" | "thumbnail" = "preview"
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await immichFetch(settings, `/api/assets/${assetId}/thumbnail?size=${size}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const arrayBuf = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), contentType };
}

export async function fetchAssetImageBase64(
  settings: Settings,
  assetId: string,
  size: "preview" | "thumbnail" = "preview"
): Promise<string> {
  const { buffer, contentType } = await fetchAssetImage(settings, assetId, size);
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}
