export type AuditStatus = "pending" | "auditing" | "passed" | "rejected" | "failed" | "duplicate";
export type ComposeStatus = "pending" | "composing" | "done" | "failed";
export type StatusFilter = "all" | "passed" | "rejected" | "pending" | "duplicate";

export interface Crop {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface FrameSpec {
  style: "none" | "wood" | "black" | "white" | "gold";
  widthPx: number;
}

export type TextFont = "brush" | "kai" | "cute" | "round" | "hand" | "gentle";

export interface TextSpec {
  content: string;
  position: "bottom" | "top" | "left" | "right";
  /** 竖排文字（旧数据缺省视为 false） */
  vertical?: boolean;
  /** 下划线（旧数据缺省视为 false） */
  underline?: boolean;
  /** 字号：字高占照片高度的百分比 2-12，缺省为自动 */
  fontSize?: number | null;
  font?: TextFont;
  gradientFrom: string;
  gradientTo: string;
  strokeColor: string;
}

export interface Instruction {
  crop: Crop;
  /** 展示比例：standard 横竖屏比例，original 表示自由比例（旧数据可能缺省） */
  ratio?: "original" | "16:9" | "9:16" | "4:3" | "3:4" | "1:1";
  rotate: number;
  frame: FrameSpec;
  text: TextSpec;
  /** AI 直接写的 SVG 叠加层代码（可选），铺满照片区域渲染 */
  overlay?: string | null;
}

export interface Photo {
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
  auditStatus: AuditStatus;
  composeStatus: ComposeStatus;
  /** 用户对审核结果的评价（like/dislike，踩则不再展示） */
  auditVote: Vote | null;
  /** 用户对装裱结果的评价（like/dislike，踩则重新装裱） */
  composeVote: Vote | null;
  instruction: Instruction | null;
  error: string | null;
  /** 评分完成时间（重跑打分后清空重计） */
  auditedAt: string | null;
  /** 装裱完成时间（重新装裱后清空重计） */
  composedAt: string | null;
  imageUrl: string;
  thumbnailUrl: string;
  /** 是否已生成漫画图（有则 imageUrl/thumbnailUrl 返回漫画图） */
  cartoon?: boolean;
  /** 漫画化状态：pending / cartoonizing / done / failed / null */
  cartoonStatus?: string | null;
  /** 漫画化完成时间 */
  cartoonedAt?: string | null;
}

export type Vote = "like" | "dislike";

/** 对照片打分/装裱结果投票；vote 传 null 表示取消 */
export function votePhoto(id: number, target: "audit" | "compose", vote: Vote | null): Promise<Photo> {
  return request<Photo>(`/api/photos/${id}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, vote }),
  });
}

export interface PhotoList {
  total: number;
  page: number;
  pageSize: number;
  items: Photo[];
}

export interface Stats {
  total: number;
  passed: number;
  rejected: number;
  pending: number;
  /** 重复照片数（后端并行开发中，可能缺省） */
  duplicate?: number;
  /** 本地相似分析：已完成 dhash 的照片数（可能缺省） */
  dhashDone?: number;
  composed: number;
  queue: { audit: number; compose: number };
}

export interface QueueInfo {
  pending: number;
  running: number;
  concurrency: number;
  /** 每个并发槽一次取走的照片数（批量大小，自适应后会低于设置值） */
  batchSize: number;
  dbPending: number;
  paused: boolean;
}

export interface QueueStatus {
  audit: QueueInfo;
  compose: QueueInfo;
}

/** 时钟 / 日历浮层的位置与缩放（相对屏幕的比例，scale=1 为默认大小） */
export interface HudLayout {
  x: number;
  y: number;
  scale: number;
}

/** 思考模式：default 不加参数 / on 开启 / off 关闭 */
export type ThinkingMode = "default" | "on" | "off";

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  thinking?: ThinkingMode;
  /** 仅装裱组：允许 AI 在装裱时自行决定是否把照片漫画化（调用图像编辑模型） */
  cartoonEnabled?: boolean;
  /** 漫画化使用的图像编辑模型（OpenAI 兼容 /images/edits），复用本组 baseUrl/apiKey */
  cartoonModel?: string;
  /** 漫画化风格提示词（基础要求，装裱 AI 的画风描述会追加在后面） */
  cartoonPrompt?: string;
}

export interface Settings {
  immichBaseUrl: string;
  immichApiKey: string;
  pollIntervalSec: number;
  webhookEnabled: boolean;
  auditPaused: boolean;
  composePaused: boolean;
  dhashPaused?: boolean;
  frameFit: FrameFit;
  frameShowClock: boolean;
  frameShowCalendar: boolean;
  /** 服务的公网访问地址，漫画化走「网关拉图」的提供方（如阿里云 MaaS）时必填 */
  publicBaseUrl?: string;
  /** 时钟浮层位置与缩放；null 表示使用默认角落位置 */
  frameClockLayout?: HudLayout | null;
  /** 日历浮层位置与缩放；null 表示使用默认角落位置 */
  frameCalendarLayout?: HudLayout | null;
  framePreferAspect?: boolean;
  frameIntervalSec: number;
  /** 高德地图 JS API key / 安全密钥（轮播页信息卡地图；空则退回静态瓦片） */
  amapKey?: string;
  amapSecurityCode?: string;
  dedupEnabled?: boolean;
  localDedupEnabled?: boolean;
  localDedupThreshold?: number;
  localDedupWindowMin?: number;
  audit: AiSettings;
  compose: AiSettings;
  /** 三个维度各自的通过阈值（1-10），全部不低于阈值才进入装裱 */
  clarityThreshold: number;
  beautyThreshold: number;
  storyThreshold: number;
  auditConcurrency: number;
  composeConcurrency: number;
  dhashConcurrency?: number;
  /** 漫画化队列并发数（1-8） */
  cartoonConcurrency?: number;
  /** 漫画化频率上限（0.01-1）：通过审核的照片中最多按此比例漫画化，默认 0.1 */
  cartoonRatio?: number;
  /** 单次 AI 请求批量处理的照片数：1 = 逐张（关闭批量） */
  auditBatchSize?: number;
  composeBatchSize?: number;
  /** 装裱审美记忆（由赞/踩记录经 AI 总结，GET /api/settings 附带，只读） */
  composeMemory?: string | null;
  /** 审核审美记忆（含原始分数与阈值的赞/踩记录经 AI 总结） */
  auditMemory?: string | null;
  /** 装裱 / 审核各自待学习（尚未总结进记忆）的赞/踩条数 */
  composeFeedbackPending?: number;
  auditFeedbackPending?: number;
  /** 赞/踩自动学习开关：关闭后只能在设置页手动重新生成记忆 */
  memoryEnabled?: boolean;
  /** 新增赞/踩累计到该数量才自动总结进审美记忆 */
  memoryThreshold?: number;
  /** 装裱 / 审核审美记忆的总结提示词 */
  memoryComposePrompt?: string;
  memoryAuditPrompt?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    // 会话失效：跳登录页（登录页自身的请求除外）
    if (res.status === 401 && !location.pathname.startsWith("/login")) {
      location.href = "/login";
    }
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/* ---------- 登录鉴权与用户管理 ---------- */

export interface AuthMe {
  /** 是否存在用户（存在即强制全站登录） */
  authRequired: boolean;
  authed: boolean;
  user: string | null;
}

export interface AuthUser {
  id: number;
  username: string;
  createdAt: string;
}

export function fetchAuthMe(): Promise<AuthMe> {
  return request<AuthMe>("/api/auth/me");
}

export function login(username: string, password: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

export function fetchUsers(): Promise<{ users: AuthUser[] }> {
  return request<{ users: AuthUser[] }>("/api/auth/users");
}

export function createUser(
  username: string,
  password: string
): Promise<{ ok: boolean; users: AuthUser[] }> {
  return request("/api/auth/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export function deleteUser(id: number): Promise<{ ok: boolean; users: AuthUser[] }> {
  return request(`/api/auth/users/${id}`, { method: "DELETE" });
}

export function changeMyPassword(password: string): Promise<{ ok: boolean }> {
  return request("/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export type PhotoSort = "taken" | "audited" | "composed" | "cartooned";
export type CartoonFilter = "all" | "done" | "running" | "failed" | "none";
export type VoteFilter = "all" | "liked" | "disliked" | "audit" | "compose";

export function fetchPhotos(params: {
  status: StatusFilter;
  cartoon?: CartoonFilter;
  vote?: VoteFilter;
  startDate?: string;
  endDate?: string;
  sort?: PhotoSort;
  order?: "asc" | "desc";
  page: number;
  pageSize: number;
}): Promise<PhotoList> {
  const q = new URLSearchParams();
  q.set("status", params.status);
  if (params.cartoon && params.cartoon !== "all") q.set("cartoon", params.cartoon);
  if (params.vote && params.vote !== "all") q.set("vote", params.vote);
  if (params.startDate) q.set("startDate", params.startDate);
  if (params.endDate) q.set("endDate", params.endDate);
  if (params.sort) q.set("sort", params.sort);
  if (params.order) q.set("order", params.order);
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  return request<PhotoList>(`/api/photos?${q.toString()}`);
}

export function fetchStats(): Promise<Stats> {
  return request<Stats>("/api/stats");
}

/** 轻量索引条目：虚拟滚动布局只需要 id / 拍摄时间 / 宽高 */
export interface PhotoIndexItem {
  id: number;
  /** takenAt（ISO 字符串，可空） */
  t: string | null;
  w: number | null;
  h: number | null;
}

/** 与 fetchPhotos 同筛选同排序的全量轻量索引（无分页） */
export function fetchPhotoIndex(params: {
  status: StatusFilter;
  cartoon?: CartoonFilter;
  vote?: VoteFilter;
  startDate?: string;
  endDate?: string;
  sort?: PhotoSort;
  order?: "asc" | "desc";
}): Promise<{ total: number; items: PhotoIndexItem[] }> {
  const q = new URLSearchParams();
  q.set("status", params.status);
  if (params.cartoon && params.cartoon !== "all") q.set("cartoon", params.cartoon);
  if (params.vote && params.vote !== "all") q.set("vote", params.vote);
  if (params.startDate) q.set("startDate", params.startDate);
  if (params.endDate) q.set("endDate", params.endDate);
  if (params.sort) q.set("sort", params.sort);
  if (params.order) q.set("order", params.order);
  return request(`/api/photos/index?${q.toString()}`);
}

/** 手动触发单张照片漫画化（可附画风描述），不入队 AI 决策流程、不受频率配额限制 */
export function cartoonizePhoto(id: number, cartoonPrompt?: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/photos/${id}/cartoonize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cartoonPrompt?.trim() ? { cartoonPrompt: cartoonPrompt.trim() } : {}),
  });
}

export function fetchQueue(): Promise<QueueStatus> {
  return request<QueueStatus>("/api/queue");
}

export function syncImmich(): Promise<{ ok: boolean; scanned?: number; upserted?: number; error?: string }> {
  return request("/api/sync", { method: "POST" });
}

export function regenerateBatch(body: {
  startDate?: string;
  endDate?: string;
  status?: StatusFilter;
}): Promise<{ ok: boolean; count: number }> {
  return request("/api/regenerate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function regeneratePhoto(id: number): Promise<{ ok: boolean; id: number }> {
  return request(`/api/photos/${id}/regenerate`, { method: "POST" });
}

/** 人工标记通过/淘汰：只改状态，不作为 AI 学习样本；返回更新后的照片 */
export function markPhotos(
  ids: number[],
  mark: "passed" | "rejected"
): Promise<{ ok: boolean; count: number; items: Photo[] }> {
  return request("/api/photos/mark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, mark }),
  });
}

/** 只重新打分（通过后自动进入装裱） */
export function reauditPhoto(id: number): Promise<{ ok: boolean; id: number }> {
  return request(`/api/photos/${id}/reaudit`, { method: "POST" });
}

/** 只重新装裱（仅限已通过的照片） */
export function recomposePhoto(id: number): Promise<{ ok: boolean; id: number }> {
  return request(`/api/photos/${id}/recompose`, { method: "POST" });
}

/** 拉单张照片最新状态（用于操作后就地更新列表，不整页重载） */
export function fetchPhoto(id: number): Promise<Photo> {
  return request<Photo>(`/api/photos/${id}`);
}

/** 轮播页信息卡：拍摄时间 / 地点 / 经纬度 / 文件路径（经纬度按需实时从 Immich 拉取） */
export interface PhotoInfo {
  id: number;
  fileName: string | null;
  takenAt: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  originalPath: string | null;
  /** true 表示 Immich 不可达，只返回了本地缓存字段（无经纬度/路径） */
  offline: boolean;
}

export function fetchPhotoInfo(id: number): Promise<PhotoInfo> {
  return request<PhotoInfo>(`/api/photos/${id}/info`);
}

export function fetchSettings(): Promise<Settings> {
  return request<Settings>("/api/settings");
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return request<Settings>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** 模型能力标注（服务端按模型名推断） */
export interface ModelInfo {
  id: string;
  vision: boolean;
  imageGen: boolean;
  thinking: boolean;
}

export interface CustomFont {
  id: string;
  family: string;
  url: string;
}

/** 拉取服务端自定义字体列表（server/data/fonts 目录） */
export function fetchFonts(): Promise<{ fonts: CustomFont[] }> {
  return request<{ fonts: CustomFont[] }>("/api/fonts");
}

/** 拉取 AI 提供方的模型列表（用服务端已保存的 baseUrl/apiKey），带能力标注 */
export function fetchModels(group: "audit" | "compose"): Promise<{ models: ModelInfo[] }> {
  return request<{ models: ModelInfo[] }>(`/api/models?group=${group}`);
}

/** 用最近的赞/踩记录让 AI 重新总结审美记忆（kind=compose 装裱 / audit 审核） */
export function regenerateMemory(kind: "compose" | "audit"): Promise<{ ok: boolean; memory: string }> {
  return request(`/api/settings/memory/${kind}/regenerate`, { method: "POST" });
}

/** 导出备份 zip（数据库 + 卡通画，deflate 压缩；服务端 Content-Disposition attachment） */
export function exportBackup(): void {
  const a = document.createElement("a");
  a.href = "/api/export/zip";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 导入备份 zip（body 为文件字节）；成功后服务自动重启。
 * overwriteSettings=true 时用备份里的设置整体覆盖（含 API Key），否则保留当前设置。
 */
export async function importBackup(
  file: File,
  overwriteSettings: boolean
): Promise<{ cartoons?: number }> {
  const res = await fetch(`/api/import/zip?overwriteSettings=${overwriteSettings}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: await file.arrayBuffer(),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      /* 保留默认 msg */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { cartoons?: number };
}

export type FrameFit = "contain" | "cover" | "stretch";

export interface QueueCounts {
  pending: number;
  running: number;
  failed: number;
  done: number;
}

export interface QueueDetail extends QueueInfo {
  counts: QueueCounts;
}

export interface QueueOverview {
  audit: QueueDetail;
  compose: QueueDetail;
  dhash: QueueDetail;
  cartoon: QueueDetail;
  /** 赞/踩审美学习状态（审核 / 装裱各一份） */
  memory?: Record<"audit" | "compose", MemoryQueueStatus>;
}

export interface MemoryQueueStatus {
  /** 待学习：尚未总结进记忆的赞/踩条数 */
  pending: number;
  /** 自动学习阈值 */
  threshold: number;
  /** 自动学习开关 */
  enabled: boolean;
  /** 是否正在总结 */
  running: boolean;
  /** 是否已有记忆 */
  learned: boolean;
}

export function fetchQueues(): Promise<QueueOverview> {
  return request<QueueOverview>("/api/queues");
}

export type QueueName = "audit" | "compose" | "dhash" | "cartoon";

export function runQueue(
  name: QueueName,
  mode: "all" | "missing"
): Promise<{ ok: boolean; queued: number }> {
  return request(`/api/queues/${name}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export function pauseQueue(name: QueueName): Promise<{ ok: boolean }> {
  return request(`/api/queues/${name}/pause`, { method: "POST" });
}

export function resumeQueue(name: QueueName): Promise<{ ok: boolean }> {
  return request(`/api/queues/${name}/resume`, { method: "POST" });
}

export function cancelQueue(name: QueueName): Promise<{ ok: boolean; cancelled: number }> {
  return request(`/api/queues/${name}/cancel`, { method: "POST" });
}
