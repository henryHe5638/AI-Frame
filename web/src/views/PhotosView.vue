<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import ArtFrame from "../components/ArtFrame.vue";
import {
  cartoonizePhoto,
  fetchPhoto,
  fetchPhotoIndex,
  fetchPhotoInfo,
  fetchSettings,
  fetchPhotos,
  fetchQueue,
  fetchStats,
  markPhotos,
  regeneratePhoto,
  reauditPhoto,
  recomposePhoto,
  syncImmich,
  votePhoto,
  type Photo,
  type PhotoIndexItem,
  type PhotoInfo,
  type PhotoSort,
  type QueueStatus,
  type Settings,
  type Stats,
  type Vote,
} from "../api";
import { downloadComposed } from "../renderExport";
import { wgs84ToGcj02 } from "../gcj02";
import { initAMapApiLoader, ElAmap, ElAmapMarker } from "@vuemap/vue-amap";

/* ---------------- 拍摄地点地图（与轮播页一致） ----------------
 * 设置里填了高德 key 用 vue-amap 可交互地图；否则退回免 key 的高德静态瓦片。
 * EXIF 坐标是 WGS-84，高德底图是 GCJ-02，统一转换避免国内偏移。
 */

const settings = ref<Settings | null>(null);
const amapEnabled = computed(() => !!settings.value?.amapKey);
const amapReady = ref(false);
let amapInitStarted = false;

/** 首次打开信息面板时才加载高德 SDK（loader 只会真正注入一次脚本） */
function ensureAmapLoaded(): void {
  if (!amapEnabled.value || amapInitStarted) return;
  amapInitStarted = true;
  try {
    (window as unknown as { _AMapSecurityConfig?: { securityJsCode: string } })._AMapSecurityConfig = {
      securityJsCode: settings.value?.amapSecurityCode ?? "",
    };
    Promise.resolve(initAMapApiLoader({ key: settings.value!.amapKey! }) as unknown)
      .then(() => (amapReady.value = true))
      .catch(() => {});
  } catch {
    /* SDK 注入失败：静态瓦片兜底 */
  }
}

/** 详情按页回拉（与索引同序），页大小 */
const PAGE = 100;

/* ---------------- 筛选条件持久化（localStorage） ---------------- */

const FILTER_KEY = "photosView.filters";
const LAYOUT_KEY = "photosView.layout";

/** 合并后的单一筛选值：状态 / 漫画化 / 赞踩互斥，只能选一个 */
type PhotoFilter =
  | "all"
  | "passed"
  | "rejected"
  | "duplicate"
  | "pending"
  | "cartoonDone"
  | "cartoonRunning"
  | "cartoonFailed"
  | "cartoonNone"
  | "liked"
  | "disliked";

const PHOTO_FILTERS: readonly PhotoFilter[] = [
  "all",
  "passed",
  "rejected",
  "duplicate",
  "pending",
  "cartoonDone",
  "cartoonRunning",
  "cartoonFailed",
  "cartoonNone",
  "liked",
  "disliked",
];

/** 合并筛选 → 后端 status / cartoon / vote 参数（三组互斥，每次只带一组） */
const FILTER_PARAMS: Record<PhotoFilter, { status: string; cartoon: string; vote: string }> = {
  all: { status: "all", cartoon: "all", vote: "all" },
  passed: { status: "passed", cartoon: "all", vote: "all" },
  rejected: { status: "rejected", cartoon: "all", vote: "all" },
  duplicate: { status: "duplicate", cartoon: "all", vote: "all" },
  pending: { status: "pending", cartoon: "all", vote: "all" },
  cartoonDone: { status: "all", cartoon: "done", vote: "all" },
  cartoonRunning: { status: "all", cartoon: "running", vote: "all" },
  cartoonFailed: { status: "all", cartoon: "failed", vote: "all" },
  cartoonNone: { status: "all", cartoon: "none", vote: "all" },
  liked: { status: "all", cartoon: "all", vote: "liked" },
  disliked: { status: "all", cartoon: "all", vote: "disliked" },
};

interface SavedFilters {
  filter?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortOrder?: string;
}

function loadFilters(): SavedFilters {
  try {
    return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") as SavedFilters;
  } catch {
    return {};
  }
}

function savedPhotoFilter(s: SavedFilters): PhotoFilter {
  return PHOTO_FILTERS.includes(s.filter as PhotoFilter) ? (s.filter as PhotoFilter) : "all";
}

const savedFilters = loadFilters();
const SORT_VALUES = ["taken", "audited", "composed", "cartooned"];

const photoFilter = ref<PhotoFilter>(savedPhotoFilter(savedFilters));
const startDate = ref(typeof savedFilters.startDate === "string" ? savedFilters.startDate : "");
const endDate = ref(typeof savedFilters.endDate === "string" ? savedFilters.endDate : "");
const sortBy = ref<PhotoSort>(
  SORT_VALUES.includes(savedFilters.sortBy ?? "") ? (savedFilters.sortBy as PhotoSort) : "taken"
);
const sortOrder = ref<"asc" | "desc">(savedFilters.sortOrder === "asc" ? "asc" : "desc");

watch([photoFilter, startDate, endDate, sortBy, sortOrder], () => {
  localStorage.setItem(
    FILTER_KEY,
    JSON.stringify({
      filter: photoFilter.value,
      startDate: startDate.value,
      endDate: endDate.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
    })
  );
});

/* ---------------- 布局偏好（模式 + 缩放） ---------------- */

type LayoutMode = "uniform" | "justified";

interface SavedLayout {
  mode?: string;
  zoom?: number;
}

function loadLayout(): SavedLayout {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as SavedLayout;
  } catch {
    return {};
  }
}

const savedLayout = loadLayout();
const layoutMode = ref<LayoutMode>(savedLayout.mode === "uniform" ? "uniform" : "justified");
/** 网格缩放：0.5（小图密排）~ 2.2（大图） */
const zoom = ref(
  typeof savedLayout.zoom === "number" && savedLayout.zoom >= 0.5 && savedLayout.zoom <= 2.2
    ? savedLayout.zoom
    : 1
);

watch([layoutMode, zoom], () => {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ mode: layoutMode.value, zoom: zoom.value }));
});

/* ---------------- 全量轻量索引 + 按窗口加载详情 ---------------- */

const index = ref<PhotoIndexItem[]>([]);
/** 详情缓存：索引位置 → Photo，随窗口滚动加载 / 卸载 */
const detailMap = reactive(new Map<number, Photo>());
const loadedPages = new Set<number>();
const pendingPages = new Set<number>();
const loadingIndex = ref(false);
const error = ref("");
const loaded = ref(false);

const stats = ref<Stats | null>(null);
const queue = ref<QueueStatus | null>(null);
const syncing = ref(false);
/** 移动端筛选面板展开状态 */
const filtersOpen = ref(false);

const detail = ref<Photo | null>(null);
const detailLoading = ref(false);
const detailMsg = ref("");

let pollTimer: number | undefined;

/** 当前筛选条件对应的列表参数（索引与详情分页必须完全一致，保证顺序对齐） */
function listParams() {
  const filter = FILTER_PARAMS[photoFilter.value];
  return {
    status: filter.status as never,
    cartoon: filter.cartoon as never,
    vote: filter.vote as never,
    startDate: startDate.value ? new Date(startDate.value).toISOString() : undefined,
    endDate: endDate.value
      ? new Date(new Date(endDate.value).getTime() + 24 * 3600 * 1000 - 1).toISOString()
      : undefined,
    sort: sortBy.value,
    order: sortOrder.value,
  };
}

async function loadIndex(): Promise<void> {
  loadingIndex.value = true;
  error.value = "";
  clearSelection();
  try {
    const res = await fetchPhotoIndex(listParams());
    index.value = res.items;
    detailMap.clear();
    loadedPages.clear();
    pendingPages.clear();
    window.scrollTo({ top: 0 });
    updateScrollState();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    loadingIndex.value = false;
    loaded.value = true;
  }
}

/** 按需加载 [lo, hi] 索引范围内的详情页，并卸载远离窗口的页 */
function ensureRange(lo: number, hi: number): void {
  const len = index.value.length;
  if (len === 0) return;
  lo = Math.max(0, lo);
  hi = Math.min(len - 1, hi);
  if (hi < lo) return;
  const p0 = Math.floor(lo / PAGE);
  const p1 = Math.floor(hi / PAGE);
  for (let p = p0; p <= p1; p++) {
    if (loadedPages.has(p) || pendingPages.has(p)) continue;
    pendingPages.add(p);
    fetchPhotos({ ...listParams(), page: p + 1, pageSize: PAGE })
      .then((res) => {
        loadedPages.add(p);
        res.items.forEach((photo, j) => {
          const idx = p * PAGE + j;
          // 索引与分页同序；id 对不上说明期间数据变了，丢弃等索引重载
          if (idx < index.value.length && index.value[idx]!.id === photo.id) {
            detailMap.set(idx, photo);
          }
        });
      })
      .catch(() => {
        /* 失败不记 loaded，下次滚动自动重试 */
      })
      .finally(() => pendingPages.delete(p));
  }
  // 卸载：窗口上下各保留 3 页，之外的全部释放（滚动回去会重新拉取）
  for (const p of [...loadedPages]) {
    if (p < p0 - 3 || p > p1 + 3) {
      loadedPages.delete(p);
      for (let i = p * PAGE; i < (p + 1) * PAGE; i++) detailMap.delete(i);
    }
  }
}

async function loadStats(): Promise<void> {
  try {
    stats.value = await fetchStats();
  } catch {
    stats.value = null;
  }
}

async function loadQueue(): Promise<void> {
  try {
    queue.value = await fetchQueue();
  } catch {
    queue.value = null;
  }
}

function search(): void {
  void loadIndex();
}

function onSync(): void {
  syncing.value = true;
  syncImmich()
    .then((r) => {
      if (r && typeof r === "object" && "error" in r && r.error) alert(`同步失败：${r.error}`);
      void loadIndex();
      void loadStats();
    })
    .catch((e: unknown) => alert(e instanceof Error ? e.message : "同步失败"))
    .finally(() => (syncing.value = false));
}

/* ---------------- 日期分组与虚拟布局 ---------------- */

interface CellBox {
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface HeaderBox {
  label: string;
  y: number;
}

interface MonthBucket {
  key: string;
  label: string;
  firstIdx: number;
  count: number;
  /** 该月第一张照片在墙里的 y（布局后填入） */
  y: number;
}

interface WallLayout {
  boxes: CellBox[];
  headers: HeaderBox[];
  totalH: number;
  months: MonthBucket[];
}

const GAP = 6;
const HEADER_H = 38;

const wallEl = ref<HTMLElement | null>(null);
const wallWidth = ref(0);
/** 墙顶相对文档的偏移（滚动时刷新） */
const wallTop = ref(0);
const scrollY = ref(0);
const viewportH = ref(window.innerHeight);

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function dayLabel(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
}

function monthLabel(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** 整面墙的一次性布局：纯函数，索引 / 宽度 / 模式 / 缩放变化时重算 */
const wallLayout = computed<WallLayout>(() => {
  const items = index.value;
  const W = wallWidth.value;
  const empty: WallLayout = { boxes: [], headers: [], totalH: 0, months: [] };
  if (items.length === 0 || W <= 0) return empty;

  // 按拍摄日期分组（仅拍摄时间排序时分组；其它排序一整组无表头）
  const groupByDay = sortBy.value === "taken";
  interface Group {
    label: string | null;
    monthKey: string | null;
    monthLbl: string | null;
    start: number;
    end: number;
  }
  const groups: Group[] = [];
  let cur: Group | null = null;
  for (let i = 0; i < items.length; i++) {
    const t = items[i]!.t;
    const d = t ? new Date(t) : null;
    const valid = d && !Number.isNaN(d.getTime());
    const label = groupByDay ? (valid ? dayLabel(d) : "未知日期") : null;
    const mKey = valid ? `${d.getFullYear()}-${d.getMonth()}` : "未知";
    const mLbl = valid ? monthLabel(d) : "未知日期";
    if (!cur || cur.label !== label) {
      cur = { label, monthKey: mKey, monthLbl: mLbl, start: i, end: i };
      groups.push(cur);
    }
    cur.end = i;
  }

  const boxes: CellBox[] = [];
  const headers: HeaderBox[] = [];
  const months: MonthBucket[] = [];
  let y = 0;
  let curMonth: MonthBucket | null = null;

  const pushMonth = (g: Group, atY: number): void => {
    if (!groupByDay || !g.monthKey) return;
    if (!curMonth || curMonth.key !== g.monthKey) {
      curMonth = { key: g.monthKey, label: g.monthLbl ?? "", firstIdx: g.start, count: 0, y: atY };
      months.push(curMonth);
    }
    curMonth.count += g.end - g.start + 1;
  };

  if (layoutMode.value === "uniform") {
    // 统一大小：单元格固定 4:3，列宽随缩放变化
    const minCol = 200 * zoom.value;
    const cols = Math.max(1, Math.floor((W + GAP) / (minCol + GAP)));
    const cw = (W - (cols - 1) * GAP) / cols;
    const ch = (cw * 3) / 4;
    for (const g of groups) {
      pushMonth(g, y);
      if (g.label) {
        headers.push({ label: g.label, y });
        y += HEADER_H;
      }
      const n = g.end - g.start + 1;
      for (let k = 0; k < n; k++) {
        const row = Math.floor(k / cols);
        const col = k % cols;
        boxes.push({ i: g.start + k, x: col * (cw + GAP), y: y + row * (ch + GAP), w: cw, h: ch });
      }
      y += Math.ceil(n / cols) * (ch + GAP);
    }
  } else {
    // 按图片宽高比逐行排布（类 immich）：目标行高随缩放变化
    const targetH = Math.min(480, Math.max(90, 190 * zoom.value));
    for (const g of groups) {
      pushMonth(g, y);
      if (g.label) {
        headers.push({ label: g.label, y });
        y += HEADER_H;
      }
      let rowStart = g.start;
      let sumAr = 0;
      let rowY = y;
      const flush = (rowEnd: number, stretch: boolean): void => {
        const n = rowEnd - rowStart + 1;
        if (n <= 0) return;
        let h = stretch ? (W - (n - 1) * GAP) / sumAr : targetH;
        // 防止个别超宽图把一行拉得过高
        h = Math.min(h, targetH * 1.6);
        let x = 0;
        for (let i = rowStart; i <= rowEnd; i++) {
          const it = items[i]!;
          const ar = it.w && it.h && it.w > 0 && it.h > 0 ? it.w / it.h : 4 / 3;
          const w = h * ar;
          boxes.push({ i, x, y: rowY, w: Math.max(20, w), h });
          x += w + GAP;
        }
        rowY += h + GAP;
      };
      for (let i = g.start; i <= g.end; i++) {
        const it = items[i]!;
        const ar = it.w && it.h && it.w > 0 && it.h > 0 ? it.w / it.h : 4 / 3;
        if (sumAr > 0 && (sumAr + ar) * targetH > W + GAP) {
          flush(i - 1, true);
          rowStart = i;
          sumAr = 0;
        }
        sumAr += ar;
      }
      flush(g.end, false);
      y = rowY;
    }
  }

  return { boxes, headers, totalH: Math.max(0, y - GAP), months };
});

/** 可视窗口（相对墙的坐标）上下各多渲染一屏 */
const overscan = computed(() => viewportH.value);

/** 首个底边超过 target 的盒子下标（二分） */
function firstBottomAfter(boxes: CellBox[], target: number): number {
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    const b = boxes[m]!;
    if (b.y + b.h <= target) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const visibleRange = computed<{ start: number; end: number }>(() => {
  const boxes = wallLayout.value.boxes;
  if (boxes.length === 0) return { start: 0, end: 0 };
  const relTop = scrollY.value - wallTop.value - overscan.value;
  const relBot = scrollY.value - wallTop.value + viewportH.value + overscan.value;
  const start = firstBottomAfter(boxes, Math.max(0, relTop));
  let end = start;
  while (end < boxes.length && boxes[end]!.y < relBot) end++;
  return { start, end };
});

const visibleBoxes = computed(() =>
  wallLayout.value.boxes.slice(visibleRange.value.start, visibleRange.value.end)
);

const visibleHeaders = computed(() => {
  const relTop = scrollY.value - wallTop.value - overscan.value;
  const relBot = scrollY.value - wallTop.value + viewportH.value + overscan.value;
  return wallLayout.value.headers.filter((h) => h.y + HEADER_H > relTop && h.y < relBot);
});

/** 可见盒子对应的详情加载窗口（索引位置） */
watch([visibleRange], () => {
  const boxes = wallLayout.value.boxes;
  const { start, end } = visibleRange.value;
  if (end <= start || boxes.length === 0) return;
  const firstIdx = boxes[start]!.i;
  const lastIdx = boxes[Math.min(end, boxes.length) - 1]!.i;
  const margin = Math.max(50, (end - start) * 2);
  ensureRange(firstIdx - margin, lastIdx + margin);
});

/* ---------------- 滚动 ---------------- */

const showBackTop = ref(false);
let scrollRaf = 0;

function updateScrollState(): void {
  scrollY.value = window.scrollY;
  viewportH.value = window.innerHeight;
  showBackTop.value = window.scrollY > 600;
  const el = wallEl.value;
  if (el) {
    const rect = el.getBoundingClientRect();
    wallTop.value = rect.top + window.scrollY;
    if (Math.abs(rect.width - wallWidth.value) > 0.5) wallWidth.value = rect.width;
  }
}

function onScroll(): void {
  if (scrollRaf) return;
  scrollRaf = window.requestAnimationFrame(() => {
    scrollRaf = 0;
    updateScrollState();
    indicateScrub();
  });
}

function backToTop(): void {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------------- 右侧时间轴 ---------------- */

const scrubberEl = ref<HTMLElement | null>(null);
const scrubbing = ref(false);
/** 鼠标悬停时突出显示的刻度（月份 key + 像素位置） */
const hoverTick = ref<string | null>(null);
/** 滚动 / 拖动时短暂显示的当前月份气泡 */
const scrubBubble = ref<{ label: string; top: number } | null>(null);
let scrubHideTimer: number | undefined;

const months = computed(() => wallLayout.value.months);
const showTimeline = computed(
  () => sortBy.value === "taken" && months.value.length >= 2 && wallLayout.value.totalH > 0
);

/** 当前滚动位置所在的月份 */
const activeMonth = computed<MonthBucket | null>(() => {
  const list = months.value;
  if (list.length === 0) return null;
  const probe = scrollY.value - wallTop.value + viewportH.value * 0.25;
  let cur = list[0]!;
  for (const m of list) {
    if (m.y <= probe) cur = m;
    else break;
  }
  return cur;
});

/** 刻度标签抽稀：年份交界必标，其余按月数均分到 ~14 个 */
const tickMonths = computed(() => {
  const list = months.value;
  const totalH = wallLayout.value.totalH;
  if (totalH <= 0) return [];
  const step = Math.max(1, Math.ceil(list.length / 14));
  let prevYear = "";
  return list
    .map((m, k) => {
      const year = m.key.split("-")[0] ?? "";
      const yearBoundary = year !== prevYear;
      prevYear = year;
      return { m, show: yearBoundary || k % step === 0, top: (m.y / totalH) * 100 };
    })
    .filter((t) => t.show);
});

function indicateScrub(): void {
  if (scrubbing.value || !showTimeline.value) return;
  const m = activeMonth.value;
  if (!m) return;
  showBubble(m.label, null);
}

function showBubble(label: string, clientY: number | null): void {
  const el = scrubberEl.value;
  let top: number;
  if (clientY !== null && el) {
    top = clientY;
  } else if (el) {
    // 非拖动：气泡贴在被虚拟滚动条“Thumb”应在的位置
    const totalH = wallLayout.value.totalH;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (scrollY.value - wallTop.value) / Math.max(1, totalH - viewportH.value)));
    top = rect.top + frac * rect.height;
  } else {
    return;
  }
  scrubBubble.value = { label, top };
  if (scrubHideTimer) window.clearTimeout(scrubHideTimer);
  if (!scrubbing.value) {
    scrubHideTimer = window.setTimeout(() => (scrubBubble.value = null), 900);
  }
}

function scrubTo(clientY: number): void {
  const el = scrubberEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  const totalH = wallLayout.value.totalH;
  const target = wallTop.value + frac * Math.max(0, totalH - viewportH.value);
  window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
  updateScrollState();
  const m = activeMonth.value;
  if (m) showBubble(m.label, clientY);
}

function onScrubDown(e: PointerEvent): void {
  if (!showTimeline.value) return;
  e.preventDefault();
  scrubbing.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  if (scrubHideTimer) window.clearTimeout(scrubHideTimer);
  scrubTo(e.clientY);
}

function onScrubMove(e: PointerEvent): void {
  if (scrubbing.value) {
    scrubTo(e.clientY);
    return;
  }
  // 非拖动：只突出离鼠标最近的那个刻度
  const el = scrubberEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const frac = (e.clientY - rect.top) / rect.height;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of tickMonths.value) {
    const d = Math.abs(t.top / 100 - frac);
    if (d < bestDist) {
      bestDist = d;
      best = t.m.key;
    }
  }
  hoverTick.value = best;
}

function onScrubLeave(): void {
  hoverTick.value = null;
}

function onScrubUp(): void {
  if (!scrubbing.value) return;
  scrubbing.value = false;
  if (scrubHideTimer) window.clearTimeout(scrubHideTimer);
  scrubHideTimer = window.setTimeout(() => (scrubBubble.value = null), 900);
}

/* ---------------- 详情弹窗 ---------------- */

function openDetail(p: Photo): void {
  detail.value = p;
  detailMsg.value = "";
  infoOpen.value = false;
  photoInfo.value = null;
  navDir.value = 0;
}

/* ---------------- 详情信息面板（右上角 i 开关，位置信息按需拉取） ---------------- */

const infoOpen = ref(false);
const photoInfo = ref<PhotoInfo | null>(null);
const infoLoading = ref(false);

function toggleInfo(): void {
  infoOpen.value = !infoOpen.value;
  const p = detail.value;
  if (!infoOpen.value || !p) return;
  ensureAmapLoaded();
  loadPhotoInfo();
}

/** 按需从 Immich 实时拉经纬度/路径（本地无缓存） */
function loadPhotoInfo(): void {
  const p = detail.value;
  if (!p) return;
  infoLoading.value = true;
  photoInfo.value = null;
  const id = p.id;
  fetchPhotoInfo(id)
    .then((info) => {
      if (detail.value?.id === id) photoInfo.value = info;
    })
    .catch(() => {
      if (detail.value?.id === id) photoInfo.value = null;
    })
    .finally(() => {
      if (detail.value?.id === id) infoLoading.value = false;
    });
}

/* ---------------- 详情翻页（顺序与照片墙一致） ---------------- */

/** 当前详情在索引中的位置；不在索引里（刚被投票移除等）为 -1 */
const detailIndex = computed(() =>
  detail.value ? index.value.findIndex((x) => x.id === detail.value!.id) : -1
);
const hasPrev = computed(() => detailIndex.value > 0);
const hasNext = computed(() => detailIndex.value >= 0 && detailIndex.value < index.value.length - 1);

/** 翻页方向：1 下一张 / -1 上一张 / 0 初次打开（淡入） */
const navDir = ref(0);

/** 翻到相邻照片：缓存命中直接切换，否则按页拉取后切换 */
async function gotoOffset(off: number): Promise<void> {
  const i = detailIndex.value;
  if (i < 0) return;
  const j = i + off;
  if (j < 0 || j >= index.value.length) return;
  let p = detailMap.get(j);
  if (!p) {
    const page = Math.floor(j / PAGE);
    try {
      const res = await fetchPhotos({ ...listParams(), page: page + 1, pageSize: PAGE });
      loadedPages.add(page);
      res.items.forEach((photo, k) => {
        const idx = page * PAGE + k;
        if (idx < index.value.length && index.value[idx]!.id === photo.id) {
          detailMap.set(idx, photo);
        }
      });
      p = detailMap.get(j);
    } catch {
      return;
    }
  }
  if (!p) return;
  const keepInfo = infoOpen.value;
  openDetail(p);
  navDir.value = off;
  if (keepInfo) {
    infoOpen.value = true;
    loadPhotoInfo();
  }
}

/* 触摸滑动翻页：水平位移超过 60px 且主导方向为水平时触发 */
let swipeX = 0;
let swipeY = 0;
let swiping = false;

function onViewerPointerDown(e: PointerEvent): void {
  if ((e.target as HTMLElement).closest("button, .viewer-info")) return;
  swipeX = e.clientX;
  swipeY = e.clientY;
  swiping = true;
}

function onViewerPointerUp(e: PointerEvent): void {
  if (!swiping) return;
  swiping = false;
  const dx = e.clientX - swipeX;
  const dy = e.clientY - swipeY;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
  void gotoOffset(dx < 0 ? 1 : -1);
}

/** 位置行：城市/省/国 + 经纬度（都没有则 null） */
const locationText = computed<string | null>(() => {
  const i = photoInfo.value;
  if (!i) return null;
  const place = [i.city ?? i.state, i.country].filter((x) => x && x.trim() !== "");
  const parts: string[] = [];
  if (place.length > 0) parts.push(place.join("，"));
  if (i.latitude != null && i.longitude != null) {
    parts.push(`${i.latitude.toFixed(5)}, ${i.longitude.toFixed(5)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
});

/** 拍摄点 GCJ-02 坐标 [lng, lat]：vue-amap 的 center/position 与静态瓦片计算共用 */
const infoMapCenter = computed<[number, number] | null>(() => {
  const i = photoInfo.value;
  if (!i || i.latitude == null || i.longitude == null) return null;
  return wgs84ToGcj02(i.longitude, i.latitude);
});

/** 静态瓦片兜底：缩放 14 级下拍摄点所在 256px 瓦片与瓦片内偏移（CSS 居中 + 图钉） */
const infoMapTile = computed(() => {
  const c = infoMapCenter.value;
  if (!c) return null;
  const [lon, lat] = c;
  const z = 14;
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(x);
  const tileY = Math.floor(y);
  const sub = ((tileX + tileY) % 4) + 1;
  return {
    url: `https://webrd0${sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tileX}&y=${tileY}&z=${z}`,
    offX: (x - tileX) * 256,
    offY: (y - tileY) * 256,
  };
});

/** 全屏查看器照片框：按装裱后宽高比贴合，限制在视口内（四周留白） */
const modalArtStyle = computed((): Record<string, string> => {
  const p = detail.value;
  if (!p) return {};
  const c = p.instruction?.crop;
  const cw = c?.width ?? 1;
  const ch = c?.height ?? 1;
  let ar =
    p.width && p.height && p.width > 0 && p.height > 0 ? (p.width * cw) / (p.height * ch) : cw / ch;
  if (!Number.isFinite(ar) || ar <= 0) ar = 1;
  const rot = p.instruction?.rotate ?? 0;
  if (rot === 90 || rot === 270) ar = 1 / ar;
  return {
    aspectRatio: String(ar),
    width: "100%",
    maxHeight: "100%",
    maxWidth: `min(100%, calc((100vh - 32px) * ${ar.toFixed(4)}))`,
  };
});

/* ---------------- 赞 / 踩 ---------------- */

const voting = ref("");

/**
 * 再点一次取消（vote=null）。审核赞 → 直接通过并进入装裱；审核踩 → 淘汰不展示；
 * 装裱踩 → 立即重新装裱。两种投票都会快照进反馈表，供 AI 学习偏好。
 */
async function onVote(p: Photo, target: "audit" | "compose", vote: Vote): Promise<void> {
  const current = target === "audit" ? p.auditVote : p.composeVote;
  const next = current === vote ? null : vote;
  voting.value = `${p.id}-${target}`;
  try {
    const updated = await votePhoto(p.id, target, next);
    // 只同步投票相关字段：服务端在「装裱踩 / 评分赞」后会清空装裱指令并重排，
    // 整条覆盖会让当前卡片/弹窗当场变成无框无字（观感像刷新）。旧装裱先继续展示。
    const votePatch = {
      auditVote: updated.auditVote,
      composeVote: updated.composeVote,
      auditStatus: updated.auditStatus,
    };
    Object.assign(p, votePatch);
    if (detail.value?.id === p.id) Object.assign(detail.value, votePatch);
    void loadStats();
    // 投票可能改变状态/赞踩，与当前筛选不匹配时从索引移除（不打断滚动位置）
    if (!matchesPhotoFilter(updated, photoFilter.value)) removeFromIndex(p.id);
  } catch (e) {
    alert(e instanceof Error ? e.message : "操作失败");
  } finally {
    voting.value = "";
  }
}

/** 从索引中移除一张照片并清空详情缓存（位置全变，重拉当前窗口即可） */
function removeFromIndex(id: number): void {
  index.value = index.value.filter((x) => x.id !== id);
  detailMap.clear();
  loadedPages.clear();
  pendingPages.clear();
  const { start, end } = visibleRange.value;
  const boxes = wallLayout.value.boxes;
  if (end > start && boxes.length > 0) {
    ensureRange(boxes[start]!.i, boxes[Math.min(end, boxes.length) - 1]!.i);
  }
}

/** 照片是否符合合并后的筛选条件（与后端 buildWhere 保持一致） */
function matchesPhotoFilter(p: Photo, f: PhotoFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "passed":
      return p.auditStatus === "passed";
    case "rejected":
      return p.auditStatus === "rejected";
    case "duplicate":
      return p.auditStatus === "duplicate";
    case "pending":
      return (
        p.auditStatus === "pending" || p.auditStatus === "auditing" || p.auditStatus === "failed"
      );
    case "cartoonDone":
      return p.cartoonStatus === "done";
    case "cartoonRunning":
      return p.cartoonStatus === "pending" || p.cartoonStatus === "cartoonizing";
    case "cartoonFailed":
      return p.cartoonStatus === "failed";
    case "cartoonNone":
      return !p.cartoonStatus || p.cartoonStatus === "failed";
    case "liked":
      return p.auditVote === "like" || p.composeVote === "like";
    case "disliked":
      return p.auditVote === "dislike" || p.composeVote === "dislike";
  }
}

/* ---------------- 人工标记（批量 / 详情页切换，均不参与 AI 学习） ---------------- */

const selected = ref<Set<number>>(new Set());
const marking = ref(false);
/** 选择模式：勾选任意一张即进入；清空选择或按 Esc 退出 */
const selectMode = ref(false);

function toggleSelect(p: Photo): void {
  const next = new Set(selected.value);
  if (next.has(p.id)) next.delete(p.id);
  else next.add(p.id);
  selected.value = next;
  selectMode.value = next.size > 0;
  if (!selectMode.value) dragTarget = null;
}

let dragTarget: boolean | null = null;

function applyDrag(p: Photo): void {
  if (dragTarget === null) return;
  const has = selected.value.has(p.id);
  if (has === dragTarget) return;
  const next = new Set(selected.value);
  if (dragTarget) next.add(p.id);
  else next.delete(p.id);
  selected.value = next;
}

function onCellPointerDown(p: Photo, e: PointerEvent): void {
  if (!selectMode.value || e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button, .select-box")) return;
  dragTarget = !selected.value.has(p.id);
  applyDrag(p);
}

function onCellPointerEnter(p: Photo): void {
  if (dragTarget !== null) applyDrag(p);
}

function onCellClick(p: Photo): void {
  if (selectMode.value) return;
  openDetail(p);
}

function selectAllLoaded(): void {
  const next = new Set(selected.value);
  for (const p of detailMap.values()) next.add(p.id);
  selected.value = next;
}

/** 清空选择并退出选择模式（批量条「全不选」与 Esc 共用） */
function clearSelection(): void {
  selected.value = new Set();
  selectMode.value = false;
  dragTarget = null;
}

function onKeydown(e: KeyboardEvent): void {
  if (detail.value) {
    if (e.key === "Escape") detail.value = null;
    else if (e.key === "ArrowLeft") void gotoOffset(-1);
    else if (e.key === "ArrowRight") void gotoOffset(1);
    return;
  }
  if (e.key === "Escape" && selectMode.value) clearSelection();
}

/** 把服务端返回的照片合并回缓存与详情，并在不再匹配筛选时移除 */
function applyUpdated(items: Photo[]): void {
  const remove: number[] = [];
  for (const p of items) {
    if (!matchesPhotoFilter(p, photoFilter.value)) {
      remove.push(p.id);
      continue;
    }
    for (const [idx, old] of detailMap) {
      if (old.id === p.id) detailMap.set(idx, p);
    }
    if (detail.value?.id === p.id) detail.value = p;
  }
  for (const id of remove) removeFromIndex(id);
}

/** 批量标记（勾选）或详情页切换（单张）；只改状态，不写入 AI 学习反馈 */
async function onMark(ids: number[], mark: "passed" | "rejected"): Promise<void> {
  if (marking.value || ids.length === 0) return;
  marking.value = true;
  try {
    const res = await markPhotos(ids, mark);
    applyUpdated(res.items);
    clearSelection();
    void loadStats();
  } catch (e) {
    alert(e instanceof Error ? e.message : "操作失败");
  } finally {
    marking.value = false;
  }
}

function onDetailToggle(mark: "passed" | "rejected"): void {
  const p = detail.value;
  if (!p || p.auditStatus === mark) return;
  void onMark([p.id], mark);
}

function onRegenerateOne(): void {
  runDetailAction("已重新排队（评分 + 装裱）", regeneratePhoto);
}

/** 重新打分 / 重新装裱共用入口 */
function runDetailAction(okText: string, fn: (id: number) => Promise<unknown>): void {
  if (!detail.value) return;
  const id = detail.value.id;
  detailLoading.value = true;
  fn(id)
    .then(() => {
      detailMsg.value = okText;
      void fetchPhoto(id)
        .then((p) => applyUpdated([p]))
        .catch(() => {
          /* 拉取失败也不影响列表位置 */
        });
      void loadStats();
      setTimeout(() => {
        if (detail.value?.id === id) detail.value = null;
      }, 1200);
    })
    .catch((e: unknown) => (detailMsg.value = e instanceof Error ? e.message : "操作失败"))
    .finally(() => (detailLoading.value = false));
}

function cartoonLabel(p: Photo): string | null {
  if (p.cartoon || p.cartoonStatus === "done") return "漫画";
  if (p.cartoonStatus === "pending" || p.cartoonStatus === "cartoonizing") return "漫画化中";
  if (p.cartoonStatus === "failed") return "漫画失败";
  return null;
}

function statusLabel(p: Photo): string {
  const map: Record<string, string> = {
    pending: "待处理",
    auditing: "审核中",
    passed: "已通过",
    rejected: "已淘汰",
    failed: "失败",
    duplicate: "重复",
  };
  return map[p.auditStatus] ?? p.auditStatus;
}

/* ---------------- 装裱图下载 ---------------- */

const downloading = ref(false);

async function onDownload(): Promise<void> {
  const p = detail.value;
  if (!p || downloading.value) return;
  downloading.value = true;
  detailMsg.value = "";
  try {
    await downloadComposed(p);
  } catch (e) {
    detailMsg.value = e instanceof Error ? e.message : "下载失败";
  } finally {
    downloading.value = false;
  }
}

function endDragSelect(): void {
  dragTarget = null;
  if (selectMode.value && selected.value.size === 0) selectMode.value = false;
}

/* ---------------- 手动漫画化 ---------------- */

const cartoonizing = ref(false);
const cartoonPromptInput = ref("");

async function onCartoonize(): Promise<void> {
  const p = detail.value;
  if (!p || cartoonizing.value) return;
  cartoonizing.value = true;
  detailMsg.value = "";
  try {
    await cartoonizePhoto(p.id, cartoonPromptInput.value);
    p.cartoonStatus = "pending";
    detailMsg.value = "已加入漫画化队列，生成后自动展示漫画图";
  } catch (e) {
    detailMsg.value = e instanceof Error ? e.message : "操作失败";
  } finally {
    cartoonizing.value = false;
  }
}

/* ---------------- 挂载 ---------------- */

let resizeObserver: ResizeObserver | undefined;

onMounted(() => {
  void loadIndex();
  void loadStats();
  void loadQueue();
  fetchSettings()
    .then((s) => (settings.value = s))
    .catch(() => {});
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pointerup", endDragSelect);
  window.addEventListener("pointercancel", endDragSelect);
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", updateScrollState);
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => updateScrollState());
  }
  watch(wallEl, (el) => {
    resizeObserver?.disconnect();
    if (el) {
      wallWidth.value = el.clientWidth;
      resizeObserver?.observe(el);
      updateScrollState();
    }
  });
  pollTimer = window.setInterval(() => {
    void loadQueue();
    void loadStats();
  }, 5000);
});

watch([photoFilter, sortBy, sortOrder], () => search());

onBeforeUnmount(() => {
  window.clearInterval(pollTimer);
  if (scrubHideTimer) window.clearTimeout(scrubHideTimer);
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("pointerup", endDragSelect);
  window.removeEventListener("pointercancel", endDragSelect);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", updateScrollState);
  if (scrollRaf) window.cancelAnimationFrame(scrollRaf);
  resizeObserver?.disconnect();
});
</script>

<template>
  <div class="photos-view">
    <section class="stats-bar card">
      <div v-if="stats" class="stats">
        <span>总数 <b>{{ stats.total }}</b></span>
        <span>通过 <b class="ok">{{ stats.passed }}</b></span>
        <span>淘汰 <b class="bad">{{ stats.rejected }}</b></span>
        <span>重复 <b class="dup">{{ stats.duplicate ?? 0 }}</b></span>
        <span v-if="stats.dhashDone != null && stats.dhashDone < stats.total"
          >相似分析 <b>{{ stats.dhashDone }}/{{ stats.total }}</b></span
        >
        <span>待处理 <b>{{ stats.pending }}</b></span>
        <span>已构图 <b>{{ stats.composed }}</b></span>
      </div>
      <div v-if="queue" class="queues">
        <span>
          审核队列
          <b v-if="queue.audit.paused" class="paused-tag">已暂停 · {{ queue.audit.pending }} 待</b>
          <b v-else>{{ queue.audit.pending }} 待 / {{ queue.audit.running }} 运行</b>
          <i>并发 {{ queue.audit.concurrency }}</i></span
        >
        <span>
          构图队列
          <b v-if="queue.compose.paused" class="paused-tag"
            >已暂停 · {{ queue.compose.pending }} 待</b
          >
          <b v-else>{{ queue.compose.pending }} 待 / {{ queue.compose.running }} 运行</b>
          <i>并发 {{ queue.compose.concurrency }}</i></span
        >
        <router-link class="queue-link" to="/queue">管理队列 →</router-link>
      </div>
    </section>

    <button class="filter-toggle card" @click="filtersOpen = !filtersOpen">
      {{ filtersOpen ? "收起筛选 ▴" : "筛选 / 视图 ▾" }}
    </button>

    <section class="filter-bar card" :class="{ open: filtersOpen }">
      <label>
        状态
        <select v-model="photoFilter">
          <option value="all">全部</option>
          <option value="passed">已通过</option>
          <option value="rejected">已淘汰</option>
          <option value="duplicate">重复</option>
          <option value="pending">待处理</option>
          <option value="cartoonDone">已漫画化</option>
          <option value="cartoonRunning">漫画化中</option>
          <option value="cartoonFailed">漫画化失败</option>
          <option value="cartoonNone">未漫画化</option>
          <option value="liked">已赞</option>
          <option value="disliked">已踩</option>
        </select>
      </label>
      <label>
        开始日期
        <input v-model="startDate" type="date" />
      </label>
      <label>
        结束日期
        <input v-model="endDate" type="date" />
      </label>
      <label>
        排序
        <select v-model="sortBy">
          <option value="taken">拍摄时间</option>
          <option value="audited">评分时间</option>
          <option value="composed">装裱时间</option>
          <option value="cartooned">漫画化时间</option>
        </select>
      </label>
      <label>
        顺序
        <select v-model="sortOrder">
          <option value="desc">新 → 旧</option>
          <option value="asc">旧 → 新</option>
        </select>
      </label>
      <button class="primary" @click="search">查询</button>
      <button :disabled="syncing" @click="onSync">同步 Immich</button>
      <span v-if="syncing" class="hint">同步中…</span>

      <div class="view-opts">
        <div class="mode-switch" role="group" aria-label="布局模式">
          <button
            :class="{ active: layoutMode === 'justified' }"
            title="按图片宽高比排布（类 immich）"
            @click="layoutMode = 'justified'"
          >自适应</button>
          <button
            :class="{ active: layoutMode === 'uniform' }"
            title="全部按相同大小展示"
            @click="layoutMode = 'uniform'"
          >统一</button>
        </div>
        <div class="zoom-ctl" title="网格缩放">
          <button :disabled="zoom <= 0.5" @click="zoom = Math.max(0.5, +(zoom - 0.15).toFixed(2))">−</button>
          <input v-model.number="zoom" type="range" min="0.5" max="2.2" step="0.05" />
          <button :disabled="zoom >= 2.2" @click="zoom = Math.min(2.2, +(zoom + 0.15).toFixed(2))">＋</button>
        </div>
      </div>
    </section>

    <section v-if="selectMode" class="batch-bar card">
      <span>已选 <b>{{ selected.size }}</b> 张</span>
      <button class="primary" :disabled="marking || selected.size === 0" @click="onMark([...selected], 'passed')">
        标记通过
      </button>
      <button class="danger" :disabled="marking || selected.size === 0" @click="onMark([...selected], 'rejected')">
        标记淘汰
      </button>
      <button :disabled="marking" @click="selectAllLoaded">全选</button>
      <button :disabled="marking" @click="clearSelection">全不选</button>
      <span class="hint">按住拖动可连续圈选，Esc 退出；人工标记只改状态，不作为 AI 学习样本</span>
    </section>

    <section v-if="loadingIndex" class="state">加载中…</section>
    <section v-else-if="error && index.length === 0" class="state error">{{ error }}</section>
    <section v-else-if="loaded && index.length === 0" class="state">
      暂无照片，试试「同步 Immich」。
    </section>

    <section
      v-else
      ref="wallEl"
      class="wall"
      :class="{ padded: showTimeline }"
      :style="{ height: `${wallLayout.totalH}px` }"
    >
      <div
        v-for="h in visibleHeaders"
        :key="`h-${h.y}`"
        class="day-header"
        :style="{ transform: `translateY(${h.y}px)` }"
      >{{ h.label }}</div>
      <template v-for="b in visibleBoxes" :key="index[b.i]?.id ?? b.i">
        <div
          v-if="detailMap.get(b.i)"
          class="cell"
          :class="{ selected: selected.has(detailMap.get(b.i)!.id), 'select-mode': selectMode }"
          :style="{
            transform: `translate(${b.x}px, ${b.y}px)`,
            width: `${b.w}px`,
            height: `${b.h}px`,
          }"
          @click="onCellClick(detailMap.get(b.i)!)"
          @pointerdown="onCellPointerDown(detailMap.get(b.i)!, $event)"
          @pointerenter="onCellPointerEnter(detailMap.get(b.i)!)"
        >
          <label class="select-box" @click.stop>
            <input
              type="checkbox"
              :checked="selected.has(detailMap.get(b.i)!.id)"
              @change="toggleSelect(detailMap.get(b.i)!)"
            />
          </label>
          <div class="thumb">
            <ArtFrame :photo="detailMap.get(b.i)!" />
          </div>
          <div class="overlay">
            <p v-if="detailMap.get(b.i)!.totalScore != null">总分 {{ detailMap.get(b.i)!.totalScore }} / 30</p>
            <p v-if="detailMap.get(b.i)!.clarity != null">
              清晰 {{ detailMap.get(b.i)!.clarity }} · 美观 {{ detailMap.get(b.i)!.beauty }} · 故事 {{ detailMap.get(b.i)!.story }}
            </p>
            <p v-if="detailMap.get(b.i)!.reason" class="reason">{{ detailMap.get(b.i)!.reason }}</p>
            <p v-if="detailMap.get(b.i)!.error" class="err">{{ detailMap.get(b.i)!.error }}</p>
          </div>
          <span class="badge" :class="detailMap.get(b.i)!.auditStatus">{{ statusLabel(detailMap.get(b.i)!) }}</span>
          <span
            v-if="cartoonLabel(detailMap.get(b.i)!)"
            class="badge cartoon-badge"
            :class="{ done: detailMap.get(b.i)!.cartoon || detailMap.get(b.i)!.cartoonStatus === 'done' }"
          >
            {{ cartoonLabel(detailMap.get(b.i)!) }}
          </span>
        </div>
        <div
          v-else
          class="cell placeholder"
          :style="{
            transform: `translate(${b.x}px, ${b.y}px)`,
            width: `${b.w}px`,
            height: `${b.h}px`,
          }"
        />
      </template>
    </section>

    <!-- 右侧时间轴（类 immich 滚动条） -->
    <div
      v-if="showTimeline"
      ref="scrubberEl"
      class="scrubber"
      :class="{ scrubbing }"
      @pointerdown="onScrubDown"
      @pointermove="onScrubMove"
      @pointerup="onScrubUp"
      @pointercancel="onScrubUp"
      @pointerleave="onScrubLeave"
    >
      <div
        v-for="t in tickMonths"
        :key="t.m.key"
        class="tick"
        :class="{ active: hoverTick === t.m.key }"
        :style="{ top: `${t.top}%` }"
        @pointerdown.stop="onScrubDown"
      >
        <span class="tick-label">{{ t.m.label }}</span>
      </div>
    </div>
    <Transition name="fade">
      <div
        v-if="scrubBubble"
        class="scrub-bubble"
        :style="{ top: `${scrubBubble.top}px` }"
      >{{ scrubBubble.label }}</div>
    </Transition>

    <Transition name="fade">
      <button v-if="showBackTop" class="back-top" title="回到顶部" @click="backToTop">
        ↑ 顶部
      </button>
    </Transition>

    <Teleport to="body">
      <div
        v-if="detail"
        class="viewer"
        @pointerdown="onViewerPointerDown"
        @pointerup="onViewerPointerUp"
      >
        <Transition :name="navDir === 0 ? 'img-fade' : navDir > 0 ? 'img-next' : 'img-prev'" mode="out-in">
          <div :key="detail.id" class="viewer-art" :style="modalArtStyle">
            <ArtFrame :photo="detail" size="preview" eager />
          </div>
        </Transition>
        <button
          v-if="hasPrev"
          class="viewer-btn viewer-nav prev"
          title="上一张"
          @click.stop="gotoOffset(-1)"
        >‹</button>
        <button
          v-if="hasNext"
          class="viewer-btn viewer-nav next"
          title="下一张"
          @click.stop="gotoOffset(1)"
        >›</button>
        <span class="viewer-name">{{ detail.fileName ?? `照片 #${detail.id}` }}</span>
        <div class="viewer-topbar">
          <button
            class="viewer-btn"
            :class="{ active: infoOpen }"
            title="详细信息"
            @click="toggleInfo"
          >i</button>
          <button class="viewer-btn" title="关闭" @click="detail = null">×</button>
        </div>
        <Transition name="slide">
          <div v-if="infoOpen" class="viewer-info" @click.stop>
            <header class="viewer-info-head">
              <h3>{{ detail.fileName ?? `照片 #${detail.id}` }}</h3>
              <button class="viewer-btn" title="收起" @click="infoOpen = false">×</button>
            </header>
            <div class="modal-info">
              <template v-if="detail.totalScore != null">
                <p>
                  总分 <b>{{ detail.totalScore }}</b> / 30（清晰 {{ detail.clarity }} ·
                  美观 {{ detail.beauty }} · 故事 {{ detail.story }}）
                </p>
                <p v-if="detail.reason" class="reason">{{ detail.reason }}</p>
              </template>
              <p v-else>尚未评分（{{ statusLabel(detail) }}）</p>
              <p v-if="detail.takenAt" class="dim">
                拍摄于 {{ new Date(detail.takenAt).toLocaleString() }}
              </p>
              <p v-if="infoLoading" class="dim">位置信息加载中…</p>
              <template v-else-if="photoInfo">
                <p v-if="locationText" class="dim">📍 {{ locationText }}</p>
                <p v-else class="dim">无位置信息</p>
                <div v-if="infoMapCenter" class="info-map" title="拍摄地点（高德地图）">
                  <ElAmap
                    v-if="amapEnabled && amapReady"
                    :center="infoMapCenter"
                    :zoom="14"
                    view-mode="2D"
                  >
                    <ElAmapMarker :position="infoMapCenter" />
                  </ElAmap>
                  <template v-else>
                    <img
                      v-if="infoMapTile"
                      :src="infoMapTile.url"
                      :style="{
                        left: `calc(50% - ${infoMapTile.offX}px)`,
                        top: `calc(50% - ${infoMapTile.offY}px)`,
                      }"
                      alt=""
                      draggable="false"
                    />
                    <span class="info-map-pin" />
                  </template>
                  <span class="info-map-attr">© 高德地图</span>
                </div>
                <p v-if="photoInfo.originalPath" class="dim path">{{ photoInfo.originalPath }}</p>
                <p v-if="photoInfo.offline" class="hint">Immich 暂不可达，仅显示本地缓存信息</p>
              </template>
              <p v-if="detail.auditedAt" class="dim">
                评分于 {{ new Date(detail.auditedAt + "Z").toLocaleString() }}
              </p>
              <p v-if="detail.composedAt" class="dim">
                装裱于 {{ new Date(detail.composedAt + "Z").toLocaleString() }}
              </p>
              <p v-if="detail.cartoonedAt" class="dim">
                漫画化于 {{ new Date(detail.cartoonedAt + "Z").toLocaleString() }}
              </p>
              <p v-if="detail.error" class="err">{{ detail.error }}</p>
              <details v-if="detail.instruction" open>
                <summary>构图指令 JSON</summary>
                <pre>{{ JSON.stringify(detail.instruction, null, 2) }}</pre>
              </details>
              <p v-else class="dim">暂无构图指令</p>
              <div v-if="detail.totalScore != null || detail.instruction" class="votes detail-votes">
                <template v-if="detail.totalScore != null">
                  <span class="vote-label">审核</span>
                  <button
                    class="vote-btn"
                    :class="{ active: detail.auditVote === 'like' }"
                    :disabled="voting !== ''"
                    title="赞：直接通过并进入装裱（不再受阈值限制）"
                    @click="onVote(detail, 'audit', 'like')"
                  >赞</button>
                  <button
                    class="vote-btn"
                    :class="{ active: detail.auditVote === 'dislike' }"
                    :disabled="voting !== ''"
                    title="踩：淘汰，不再展示"
                    @click="onVote(detail, 'audit', 'dislike')"
                  >踩</button>
                </template>
                <template v-if="detail.instruction">
                  <span class="vote-label">装裱</span>
                  <button
                    class="vote-btn"
                    :class="{ active: detail.composeVote === 'like' }"
                    :disabled="voting !== ''"
                    @click="onVote(detail, 'compose', 'like')"
                  >赞</button>
                  <button
                    class="vote-btn"
                    :class="{ active: detail.composeVote === 'dislike' }"
                    :disabled="voting !== ''"
                    title="踩后先让 AI 总结学习，再立即重新装裱"
                    @click="onVote(detail, 'compose', 'dislike')"
                  >踩</button>
                </template>
                <span class="hint">审核：赞 = 直接通过并装裱，踩 = 淘汰不展示；装裱：踩 = 立即重做。赞/踩都会成为 AI 的学习样本</span>
              </div>
              <div class="votes">
                <span class="vote-label">人工标记</span>
                <button
                  class="vote-btn"
                  :class="{ active: detail.auditStatus === 'passed' }"
                  :disabled="marking"
                  title="手动标记为通过并进入装裱（不参与 AI 学习）"
                  @click="onDetailToggle('passed')"
                >通过</button>
                <button
                  class="vote-btn"
                  :class="{ active: detail.auditStatus === 'rejected' }"
                  :disabled="marking"
                  title="手动标记为淘汰（不参与 AI 学习）"
                  @click="onDetailToggle('rejected')"
                >淘汰</button>
                <span class="hint">人工标记只改状态，不会作为 AI 学习样本</span>
              </div>
              <div
                v-if="detail.instruction && detail.auditStatus === 'passed'"
                class="votes cartoon-box"
              >
                <span class="vote-label">漫画化</span>
                <input
                  v-model="cartoonPromptInput"
                  class="cartoon-input"
                  placeholder="画风（可空，如：吉卜力水彩风）"
                  :disabled="cartoonizing || detail.cartoonStatus === 'pending' || detail.cartoonStatus === 'cartoonizing'"
                />
                <button
                  class="vote-btn"
                  :disabled="cartoonizing || detail.cartoonStatus === 'pending' || detail.cartoonStatus === 'cartoonizing'"
                  @click="onCartoonize"
                >
                  {{
                    detail.cartoonStatus === "pending" || detail.cartoonStatus === "cartoonizing"
                      ? "漫画化中…"
                      : detail.cartoon
                        ? "重新生成漫画图"
                        : "生成漫画图"
                  }}
                </button>
                <span v-if="detail.cartoon" class="hint">已生成，轮播与下载均使用漫画图</span>
                <span v-else-if="detail.cartoonStatus === 'failed'" class="err">
                  上次漫画化失败{{ detail.error ? `：${detail.error}` : "" }}
                </span>
              </div>
              <div class="actions">
                <button
                  :disabled="detailLoading"
                  @click="runDetailAction('已重新排队打分', reauditPhoto)"
                >
                  重新打分
                </button>
                <button
                  :disabled="detailLoading || detail.auditStatus !== 'passed'"
                  :title="detail.auditStatus !== 'passed' ? '只有审核通过的照片才能重新装裱' : ''"
                  @click="runDetailAction('已重新排队装裱', recomposePhoto)"
                >
                  重新装裱
                </button>
                <button class="primary" :disabled="detailLoading" @click="onRegenerateOne">
                  全部重做
                </button>
                <button
                  :disabled="downloading"
                  title="按装裱指令（裁剪/题字/装饰，漫画化照片带漫画效果）渲染并下载 JPEG"
                  @click="onDownload"
                >
                  {{ downloading ? "渲染中…" : "下载装裱图" }}
                </button>
                <span v-if="detailMsg" class="hint">{{ detailMsg }}</span>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.photos-view {
  padding: 16px 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.stats-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 32px;
  padding: 12px 16px;
  align-items: center;
}
.stats,
.queues {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.stats b {
  font-size: 16px;
}
.stats b.ok {
  color: var(--ok);
}
.stats b.bad {
  color: var(--danger);
}
.stats b.dup {
  color: var(--text-dim);
}
.queues {
  color: var(--text-dim);
  font-size: 13px;
  margin-left: auto;
}
.queues i {
  font-style: normal;
  opacity: 0.7;
  margin-left: 4px;
}
.queues b.paused-tag {
  color: var(--accent);
}
.queue-link {
  color: var(--accent);
  white-space: nowrap;
}
.filter-toggle {
  display: none;
  padding: 10px 16px;
  text-align: left;
  color: var(--text-dim);
}
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 16px;
  align-items: center;
}
.filter-bar label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
}
.view-opts {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-left: auto;
  flex-wrap: wrap;
}
.mode-switch {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.mode-switch button {
  border: none;
  border-radius: 0;
  padding: 5px 14px;
  background: transparent;
  color: var(--text-dim);
}
.mode-switch button.active {
  background: var(--accent);
  color: var(--accent-on);
  font-weight: 600;
}
.zoom-ctl {
  display: flex;
  align-items: center;
  gap: 6px;
}
.zoom-ctl button {
  padding: 2px 10px;
  line-height: 1.2;
}
.zoom-ctl input[type="range"] {
  width: 110px;
  padding: 0;
  accent-color: var(--accent);
}
.hint {
  color: var(--text-dim);
  font-size: 13px;
}
.state {
  padding: 60px;
  text-align: center;
  color: var(--text-dim);
}
.state.error {
  color: var(--danger);
}

/* ---------------- 虚拟照片墙 ---------------- */

.wall {
  position: relative;
}
/* 给右侧时间轴让位 */
.wall.padded {
  margin-right: 34px;
}
.day-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 38px;
  display: flex;
  align-items: center;
  font-weight: 600;
  font-size: 14px;
  color: var(--text);
  pointer-events: none;
}
.cell {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  cursor: pointer;
  border-radius: 4px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.cell:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow);
  z-index: 2;
}
.cell.placeholder {
  background: var(--bg-softer);
  border: none;
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
.thumb {
  width: 100%;
  height: 100%;
  background: var(--thumb-bg);
}
.thumb :deep(.art-frame) {
  height: 100%;
}
.overlay {
  position: absolute;
  z-index: 2;
  inset: auto 0 0 0;
  padding: 24px 12px 10px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.85));
  color: #e6e8ee;
  opacity: 0;
  transition: opacity 0.2s;
  font-size: 12px;
  line-height: 1.5;
}
.overlay p {
  margin: 0;
}
.cell:hover .overlay {
  opacity: 1;
}
/* 触屏没有 hover：选择模式下也需要能看到角标，保持 overlay 隐藏即可 */
.votes {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.vote-label {
  color: rgba(230, 232, 238, 0.7);
  font-size: 11px;
}
.vote-btn {
  padding: 2px 10px;
  font-size: 12px;
  border-radius: 999px;
}
.vote-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-on);
  font-weight: 600;
}
.reason {
  color: rgba(230, 232, 238, 0.75);
}
.err {
  color: var(--danger);
}
.badge {
  position: absolute;
  z-index: 3;
  top: 8px;
  right: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.6);
  color: #e6e8ee;
  border: 1px solid var(--border);
}
.batch-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px;
  align-items: center;
  position: sticky;
  top: 52px;
  z-index: 20;
}
.select-box {
  position: absolute;
  z-index: 4;
  top: 6px;
  left: 6px;
  padding: 4px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  cursor: pointer;
  line-height: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
.cell:hover .select-box,
.cell.select-mode .select-box {
  opacity: 1;
  pointer-events: auto;
}
.select-box input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.cell.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}
.cell.select-mode {
  cursor: crosshair;
  user-select: none;
  -webkit-user-select: none;
  touch-action: pan-y;
}
.cell.select-mode .thumb {
  pointer-events: none;
}
.cartoon-badge {
  top: 34px;
  color: var(--text-dim);
}
.cartoon-badge.done {
  color: var(--accent);
  border-color: rgba(232, 180, 120, 0.5);
}
.badge.passed {
  color: var(--ok);
  border-color: rgba(108, 201, 143, 0.5);
}
.badge.rejected {
  color: var(--danger);
  border-color: rgba(224, 108, 108, 0.5);
}
.badge.duplicate {
  color: var(--text-dim);
  border-color: rgba(154, 161, 175, 0.5);
  background: rgba(60, 63, 70, 0.65);
}

/* ---------------- 右侧时间轴 ---------------- */

.scrubber {
  position: fixed;
  right: 0;
  top: 52px;
  bottom: 0;
  width: 34px;
  z-index: 30;
  touch-action: none;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.scrubber::before {
  content: "";
  position: absolute;
  right: 6px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--border);
  opacity: 0.7;
}
.tick {
  position: absolute;
  right: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  transform: translateY(-50%);
}
.tick::after {
  content: "";
  width: 8px;
  height: 2px;
  border-radius: 2px;
  background: var(--text-dim);
  opacity: 0.45;
  transition: opacity 0.15s, width 0.15s, background 0.15s;
}
.tick-label {
  font-size: 11px;
  color: var(--text);
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
/* 只突出鼠标所在的那个刻度 */
.tick.active .tick-label {
  opacity: 1;
}
.tick.active::after {
  width: 12px;
  opacity: 1;
  background: var(--accent);
}
.scrub-bubble {
  position: fixed;
  right: 40px;
  transform: translateY(-50%);
  z-index: 31;
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  box-shadow: var(--shadow);
  pointer-events: none;
  white-space: nowrap;
}

.back-top {
  position: fixed;
  right: 48px;
  bottom: 28px;
  z-index: 50;
  padding: 10px 16px;
  border-radius: 999px;
  background: var(--nav-bg);
  border: 1px solid var(--border);
  color: var(--text);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
}
.back-top:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ---------------- 全屏查看器 ---------------- */

.viewer {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: radial-gradient(120% 100% at 50% 38%, #14161c 0%, #0b0c10 70%);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 纵向滚动交给浏览器，横向滑动留给翻页手势 */
  touch-action: pan-y;
}
.viewer-art {
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  margin: 0 auto;
  padding: 12px;
  border-radius: 12px;
  background: radial-gradient(120% 100% at 50% 38%, #23262e 0%, #121419 60%, #0b0c10 100%);
}
.viewer-art :deep(.art-frame) {
  width: 100%;
  height: 100%;
}
/* 翻页切换动画：下一张从右进/向左出，上一张反向，初次打开淡入 */
.img-fade-enter-active {
  transition: opacity 0.2s ease;
}
.img-fade-enter-from {
  opacity: 0;
}
.img-next-enter-active,
.img-next-leave-active,
.img-prev-enter-active,
.img-prev-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}
.img-next-enter-from {
  transform: translateX(72px);
  opacity: 0;
}
.img-next-leave-to {
  transform: translateX(-72px);
  opacity: 0;
}
.img-prev-enter-from {
  transform: translateX(-72px);
  opacity: 0;
}
.img-prev-leave-to {
  transform: translateX(72px);
  opacity: 0;
}
.viewer-name {
  position: absolute;
  top: 12px;
  left: 16px;
  /* 低于信息面板（z-index 2）：面板全屏覆盖时不会透出重影标题 */
  z-index: 1;
  font-size: 13px;
  color: rgba(230, 232, 238, 0.75);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}
.viewer-topbar {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 3;
  display: flex;
  gap: 8px;
}
.viewer-btn {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.55);
  color: #e6e8ee;
  font-size: 17px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
}
.viewer-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.viewer-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-on);
}
.viewer-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  font-size: 24px;
  width: 42px;
  height: 42px;
}
.viewer-nav.prev {
  left: 14px;
}
.viewer-nav.next {
  right: 14px;
}
/* 信息面板打开（桌面）时右箭头会被面板挡住，挪到面板左侧 */
.viewer:has(.viewer-info) .viewer-nav.next {
  right: calc(min(420px, 92vw) + 14px);
}
@media (max-width: 800px) {
  .viewer:has(.viewer-info) .viewer-nav {
    display: none;
  }
}
.viewer-info {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  width: min(420px, 92vw);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 18px 20px;
  background: var(--bg-soft);
  border-left: 1px solid var(--border);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.45);
}
.viewer-info-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.viewer-info-head h3 {
  margin: 0;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* vote-label / reason 的浅色是为照片墙上的深色浮层设计的；
   信息面板是普通卡片背景，需要按主题文字色显示（否则亮色下看不清） */
.viewer-info .vote-label {
  color: var(--text-dim);
}
.viewer-info .reason {
  color: var(--text);
  opacity: 0.85;
}
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
.modal-info .path {
  font-size: 12px;
  word-break: break-all;
}
/* 拍摄地点地图（与轮播页一致：可交互高德 / 静态瓦片兜底） */
.info-map {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 180px;
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
.info-map img {
  position: absolute;
  width: 256px;
  height: 256px;
  max-width: none;
  max-height: none;
  user-select: none;
  pointer-events: none;
}
.info-map :deep(.el-vue-amap-container),
.info-map :deep(.el-vue-amap) {
  width: 100%;
  height: 100%;
}
.info-map-pin {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 14px;
  height: 14px;
  transform: translate(-50%, -100%);
  background: var(--accent);
  border: 2px solid #fff;
  border-radius: 50% 50% 50% 0;
  rotate: -45deg;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
}
.info-map-attr {
  position: absolute;
  right: 4px;
  bottom: 2px;
  font-size: 10px;
  color: rgba(0, 0, 0, 0.55);
  background: rgba(255, 255, 255, 0.6);
  padding: 0 4px;
  border-radius: 3px;
}
.modal-info p {
  margin: 6px 0;
}
.modal-info .dim {
  color: var(--text-dim);
}
.modal-info pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  font-size: 12px;
  overflow-x: hidden;
  overflow-y: auto;
  max-height: 260px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.modal-info summary {
  cursor: pointer;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.cartoon-box {
  margin-top: 10px;
}
.cartoon-input {
  flex: 1;
  min-width: 140px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
}
.actions {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* ---------------- 移动端 ---------------- */

@media (max-width: 800px) {
  .photos-view {
    padding: 10px 10px 60px;
    gap: 10px;
  }
  .stats-bar {
    gap: 6px 14px;
    padding: 10px 12px;
    font-size: 13px;
  }
  .stats {
    gap: 12px;
  }
  .queues {
    margin-left: 0;
    font-size: 12px;
  }
  .filter-toggle {
    display: block;
  }
  .filter-bar {
    display: none;
    padding: 12px;
    gap: 10px;
  }
  .filter-bar.open {
    display: flex;
  }
  .filter-bar label {
    width: 100%;
    justify-content: space-between;
  }
  .filter-bar label input,
  .filter-bar label select {
    flex: 1;
    max-width: 220px;
  }
  .view-opts {
    margin-left: 0;
    width: 100%;
    justify-content: space-between;
  }
  .batch-bar {
    top: 46px;
  }
  .wall.padded {
    margin-right: 22px;
  }
  .scrubber {
    top: 46px;
    width: 24px;
  }
  .tick-label {
    display: none;
  }
  .scrub-bubble {
    right: 30px;
  }
  .day-header {
    font-size: 13px;
  }
  .back-top {
    right: 34px;
    bottom: 20px;
  }
  /* 手机竖屏：信息面板全屏覆盖，赞踩优先露出 */
  .viewer-info {
    width: 100vw;
    border-left: none;
  }
  .modal-info {
    display: flex;
    flex-direction: column;
  }
  .detail-votes {
    order: -1;
  }
}
</style>
