<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ArtFrame from "../components/ArtFrame.vue";
import HudPanel from "../components/HudPanel.vue";
import {
  fetchPhotos,
  fetchSettings,
  votePhoto,
  fetchPhotoInfo,
  type FrameFit,
  type HudLayout,
  type Photo,
  type PhotoInfo,
  type Settings,
  type Vote,
} from "../api";
import { loadHudLayout, saveHudLayout } from "../hudLayout";
import { wgs84ToGcj02 } from "../gcj02";
import { initAMapApiLoader, ElAmap, ElAmapMarker } from "@vuemap/vue-amap";

/* ---------------- 拍摄地点地图（信息卡内） ----------------
 * 两种实现自动切换：
 * - 设置里填了高德 JS API key：用 vue-amap 渲染可交互地图（拖动/缩放），体验最好；
 * - 没填 key 或 SDK 加载失败：退回免 key 的高德静态栅格瓦片（单瓦片 CSS 定位 + 图钉）。
 * 坐标统一走 WGS-84 → GCJ-02 转换（EXIF 是 WGS-84，高德底图是 GCJ-02，不转国内会偏移几百米）。
 */

/** 是否配置了高德 key（settings 尚未加载完成时视为未配置） */
const amapEnabled = computed(() => !!settings.value?.amapKey);
/** 高德 SDK 加载完成；失败时保持 false，自然退回静态瓦片 */
const amapReady = ref(false);
let amapInitStarted = false;

/** 首次打开信息卡时才加载高德 SDK（loader 只会真正注入一次脚本） */
function ensureAmapLoaded(): void {
  if (!amapEnabled.value || amapInitStarted) return;
  amapInitStarted = true;
  try {
    // 高德 JS API 2.0 要求安全密钥先于 loader 挂到 window 上
    (window as unknown as { _AMapSecurityConfig?: { securityJsCode: string } })._AMapSecurityConfig = {
      securityJsCode: settings.value?.amapSecurityCode ?? "",
    };
    // 类型声明里返回值是 void，用 Promise.resolve 包一层以拿到加载完成时机
    Promise.resolve(initAMapApiLoader({ key: settings.value!.amapKey! }) as unknown)
      .then(() => (amapReady.value = true))
      .catch(() => {});
  } catch {
    /* SDK 注入失败：静态瓦片兜底 */
  }
}

const photos = ref<Photo[]>([]);
const settings = ref<Settings | null>(null);
const index = ref(0);
const paused = ref(false);
const visible = ref(false);
const error = ref("");
const loaded = ref(false);
const loadingCount = ref(0);
/** 当前张已播进度 0-1（JS 驱动，避免控制条重新挂载导致动画从头播放） */
const progress = ref(0);

const query = new URLSearchParams(location.search);
const queryFit = query.get("fit");
const queryInterval = Number(query.get("interval"));

const fit = computed<FrameFit>(() => {
  if (queryFit === "contain" || queryFit === "cover" || queryFit === "stretch") return queryFit;
  return settings.value?.frameFit ?? "contain";
});

const intervalMs = computed(() => {
  if (Number.isFinite(queryInterval) && queryInterval >= 2) return queryInterval * 1000;
  const sec = settings.value?.frameIntervalSec;
  return Number.isFinite(sec) && Number(sec) >= 2 ? Number(sec) * 1000 : 10000;
});

const showClock = computed(() => settings.value?.frameShowClock ?? false);
const showCalendar = computed(() => settings.value?.frameShowCalendar ?? false);

const current = computed<Photo | null>(
  () => photos.value[index.value % Math.max(1, photos.value.length)] ?? null
);

/* ---------------- 轮播位置记忆 ---------------- */

const POSITION_KEY = "aaf_frame_position";

/** 页面刷新/重载后回到之前那张，而不是从第一张重新开始 */
function restorePosition(): void {
  try {
    const saved = Number(sessionStorage.getItem(POSITION_KEY));
    if (!Number.isFinite(saved) || saved <= 0) return;
    const i = photos.value.findIndex((p) => p.id === saved);
    if (i >= 0) index.value = i;
  } catch {
    /* sessionStorage 不可用时忽略 */
  }
}

watch(
  () => current.value?.id,
  (id) => {
    if (!id) return;
    try {
      sessionStorage.setItem(POSITION_KEY, String(id));
    } catch {
      /* ignore */
    }
  }
);

/* ---------------- 时钟 / 日历布局编辑 ---------------- */

const editing = ref(false);
const clockLayout = ref<HudLayout | null>(null);
const calendarLayout = ref<HudLayout | null>(null);
const controlsLayout = ref<HudLayout | null>(null);
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");

let saveTimer: number | undefined;
let savedTimer: number | undefined;

function commitLayouts(): void {
  window.clearTimeout(saveTimer);
  saveState.value = "saving";
  saveTimer = window.setTimeout(() => {
    saveHudLayout("clock", clockLayout.value);
    saveHudLayout("calendar", calendarLayout.value);
    saveHudLayout("controls", controlsLayout.value);
    saveState.value = "saved";
    window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => {
      if (saveState.value === "saved") saveState.value = "idle";
    }, 2200);
  }, 450);
}

/** 兼容历史/手工写入的越界值，保证浮层至少有一部分留在屏幕内 */
function normalizeLayout(l: HudLayout | null | undefined): HudLayout | null {
  if (!l) return null;
  return {
    x: Math.min(0.97, Math.max(0.03, l.x)),
    y: Math.min(0.97, Math.max(0.03, l.y)),
    scale: Math.min(3, Math.max(0.4, l.scale)),
  };
}

function resetLayout(which: "clock" | "calendar" | "controls"): void {
  if (which === "clock") clockLayout.value = null;
  else if (which === "calendar") calendarLayout.value = null;
  else controlsLayout.value = null;
  commitLayouts();
}

/** 控制条自定义位置（默认仍为底部居中） */
const controlsStyle = computed(() => {
  const l = controlsLayout.value;
  if (!l) return undefined;
  return {
    left: `${l.x * 100}%`,
    top: `${l.y * 100}%`,
    bottom: "auto",
    transform: "translate(-50%, -50%)",
  };
});

let dragOffset = { dx: 0, dy: 0 };

function startControlsDrag(e: PointerEvent): void {
  if (!editing.value) return;
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  handle.setPointerCapture(e.pointerId);
  const bar = handle.closest(".controls") as HTMLElement | null;
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  dragOffset = {
    dx: e.clientX - (rect.left + rect.width / 2),
    dy: e.clientY - (rect.top + rect.height / 2),
  };

  const move = (ev: PointerEvent): void => {
    const x = Math.min(0.97, Math.max(0.03, (ev.clientX - dragOffset.dx) / window.innerWidth));
    const y = Math.min(0.97, Math.max(0.03, (ev.clientY - dragOffset.dy) / window.innerHeight));
    controlsLayout.value = { x, y, scale: controlsLayout.value?.scale ?? 1 };
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    commitLayouts();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function toggleEditing(): void {
  editing.value = !editing.value;
  if (editing.value) {
    visible.value = true;
    window.clearTimeout(hideTimer);
  } else {
    show();
  }
}

let timer: number | undefined;
let hideTimer: number | undefined;

function show(): void {
  visible.value = true;
  window.clearTimeout(hideTimer);
  // 编辑布局、投票目标浮层或照片信息卡打开时，控制条保持可见
  if (editing.value || voteChoice.value || infoHover.value) return;
  hideTimer = window.setTimeout(() => (visible.value = false), 3000);
}

const TICK_MS = 100;
let elapsed = 0;

/** 100ms 心跳：推进进度条，到点切下一张；暂停时静止 */
function tick(): void {
  if (paused.value || photos.value.length === 0) return;
  elapsed += TICK_MS;
  if (elapsed >= intervalMs.value) {
    next(1);
  } else {
    progress.value = elapsed / intervalMs.value;
  }
}

/** 一轮播完后是否正在刷新播放列表（防止重复触发） */
let refreshingList = false;

/**
 * 播完一轮不接着循环：重新拉一遍已装裱照片，刷新成一个新的随机列表再播。
 * 刷新失败时退回原地重洗，保证轮播不中断。
 */
async function refreshPlaylist(): Promise<void> {
  if (refreshingList) return;
  refreshingList = true;
  try {
    const all = await loadAllPassed();
    const fresh = buildPlaylist(all.filter((p) => p.composeStatus === "done" && p.instruction));
    if (fresh.length > 0) {
      photos.value = fresh;
    } else {
      photos.value = buildPlaylist(photos.value);
    }
  } catch {
    photos.value = buildPlaylist(photos.value);
  } finally {
    index.value = 0;
    refreshingList = false;
  }
}

function next(step = 1): void {
  if (photos.value.length === 0) return;
  const ni = index.value + step;
  // 播完一轮：重新拉取并生成一个全新的随机列表，而不是原地重洗接着播
  if (step > 0 && ni >= photos.value.length) {
    index.value = 0;
    void refreshPlaylist();
  } else {
    index.value = (ni + photos.value.length) % photos.value.length;
  }
  elapsed = 0;
  progress.value = 0;
}

function toggle(): void {
  paused.value = !paused.value;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && voteChoice.value) {
    closeVoteChoice();
    return;
  }
  if (e.key === "Escape" && editing.value) {
    editing.value = false;
    show();
    return;
  }
  if (editing.value) return;
  if (e.key === "ArrowLeft") next(-1);
  else if (e.key === "ArrowRight") next(1);
  else if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    toggle();
  } else return;
  show();
}

/* ---------------- 时钟 / 日历 ---------------- */

const now = ref(new Date());
let clockTimer: number | undefined;

const timeText = computed(() =>
  now.value.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
);
const secondText = computed(() => String(now.value.getSeconds()).padStart(2, "0"));
const dateText = computed(() =>
  now.value.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  })
);

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const monthTitle = computed(
  () => `${now.value.getFullYear()} 年 ${now.value.getMonth() + 1} 月`
);
const today = computed(() => now.value.getDate());
const calendarCells = computed<Array<number | null>>(() => {
  const y = now.value.getFullYear();
  const m = now.value.getMonth();
  const firstWeekday = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells: Array<number | null> = Array.from({ length: firstWeekday }, () => null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
});

// intervalMs 变化时无需重启定时器：tick 每跳实时读取 intervalMs，进度按比例自适应

/** 与 ArtFrame 一致的裁剪后宽高比（旋转 90/270 时宽高互换） */
function displayAspect(p: Photo): number {
  const c = p.instruction?.crop;
  const cw = c?.width ?? 1;
  const ch = c?.height ?? 1;
  const w = p.width;
  const h = p.height;
  let ar = w && h && w > 0 && h > 0 ? (w * cw) / (h * ch) : cw / ch;
  if (!Number.isFinite(ar) || ar <= 0) ar = 1;
  const rot = p.instruction?.rotate ?? 0;
  return rot === 90 || rot === 270 ? 1 / ar : ar;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

/**
 * 播放列表：按与屏幕比例的接近程度排序，较近的一半洗牌后先播，较远的一半随后。
 * 用相对排序而非固定阈值——竖屏手机上即使库大多是横图，竖图也一定能优先播。
 */
function buildPlaylist(items: Photo[]): Photo[] {
  if (!(settings.value?.framePreferAspect ?? true)) return shuffle(items);
  const sar = window.innerWidth / Math.max(1, window.innerHeight);
  const dist = (p: Photo): number => {
    const ar = displayAspect(p);
    return Math.max(ar / sar, sar / ar);
  };
  const ranked = [...items].sort((a, b) => dist(a) - dist(b));
  const half = Math.ceil(ranked.length / 2);
  return [...shuffle(ranked.slice(0, half)), ...shuffle(ranked.slice(half))];
}

/** 逐页拉取全部已审核照片（单页上限 200），边拉边进播放列表 */
async function loadAllPassed(): Promise<Photo[]> {
  const all: Photo[] = [];
  const PAGE = 200;
  for (let page = 1; ; page++) {
    const r = await fetchPhotos({ status: "passed", page, pageSize: PAGE });
    all.push(...r.items);
    loadingCount.value = all.length;
    if (r.items.length < PAGE || all.length >= r.total) break;
  }
  return all;
}

/* ---------------- 赞 / 踩（评分 / 装裱二选一） ---------------- */

const voting = ref(false);
/** 待评价目标：null 表示未弹出选择；值为本次要投的赞/踩 */
const voteChoice = ref<Vote | null>(null);
let voteTimer: number | undefined;

function voted(v: Vote): boolean {
  const p = current.value;
  return !!p && (p.auditVote === v || p.composeVote === v);
}

function voteState(v: Vote | null | undefined): string {
  if (v === "like") return "已赞";
  if (v === "dislike") return "已踩";
  return "未评价";
}

function openVoteChoice(v: Vote): void {
  voteChoice.value = v;
  visible.value = true;
  window.clearTimeout(hideTimer);
  window.clearTimeout(voteTimer);
  voteTimer = window.setTimeout(closeVoteChoice, 5000);
}

function closeVoteChoice(): void {
  if (!voteChoice.value) return;
  voteChoice.value = null;
  window.clearTimeout(voteTimer);
  show();
}

/** 赞/踩入口：评分与装裱结果都有时先选目标，只有一种时直接投 */
function onVote(v: Vote): void {
  const p = current.value;
  if (!p || voting.value) return;
  const audit = p.totalScore != null;
  const compose = p.instruction != null;
  if (audit && compose) {
    openVoteChoice(v);
    return;
  }
  if (audit) void submitVote("audit", v);
  else if (compose) void submitVote("compose", v);
}

function chooseVoteTarget(target: "audit" | "compose"): void {
  const v = voteChoice.value;
  if (!v) return;
  closeVoteChoice();
  void submitVote(target, v);
}

/** 同一目标重复点同一票取消（vote=null） */
async function submitVote(target: "audit" | "compose", vote: Vote): Promise<void> {
  const p = current.value;
  if (!p || voting.value) return;
  voting.value = true;
  const currentVote = target === "audit" ? p.auditVote : p.composeVote;
  const nextVote: Vote | null = currentVote === vote ? null : vote;
  try {
    const updated = await votePhoto(p.id, target, nextVote);
    const idx = photos.value.findIndex((x) => x.id === p.id);
    if (idx >= 0) {
      // 只同步投票相关字段：装裱踩 / 评分赞 会让服务端清空旧装裱指令并重排，
      // 若整条覆盖，当前这张会当场变成无框无字（像被刷新）。保留旧指令继续展示，
      // 新装裱完成后刷新页面才会更新。
      const prev = photos.value[idx]!;
      photos.value.splice(idx, 1, {
        ...prev,
        auditVote: updated.auditVote,
        composeVote: updated.composeVote,
        auditStatus: updated.auditStatus,
      });
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "投票失败";
  } finally {
    voting.value = false;
  }
  show();
}

/** 点浮层外部关闭；控制条上的赞/踩按钮除外，它们会重新打开浮层 */
function onPickerOutside(e: PointerEvent): void {
  if (!voteChoice.value) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest(".vote-picker, .ctrl--vote")) return;
  closeVoteChoice();
}

// 切到下一张照片时收起浮层，避免投票投到新照片上
watch(
  () => current.value?.id,
  () => closeVoteChoice()
);

/* ---------------- 照片信息卡（hover 信息按钮弹出） ----------------
 * 数据来源：GET /api/photos/:id/info。
 * 时间/城市/州/国直接用库内缓存即可；经纬度与 Immich 原始文件路径只有资产详情接口
 * 才有，服务端按需实时拉取（并顺手回填城市缓存）。详情按照片 id 缓存在本页内存，
 * 切走再切回不重复请求。
 */

/** 照片 id → 详情 的内存缓存 */
const infoCache = ref(new Map<number, PhotoInfo>());
/** 信息卡是否因 hover 展开（展开期间控制条常驻，不自动隐藏） */
const infoHover = ref(false);
const infoLoading = ref(false);
const infoError = ref(false);

/** 当前照片的详情；未加载时为 null（模板回退到列表自带的 takenAt/fileName） */
const info = computed<PhotoInfo | null>(() => {
  const p = current.value;
  return p ? infoCache.value.get(p.id) ?? null : null;
});

/** 拍摄时间格式化为本地可读形式；无法解析时原样展示 */
function fmtTaken(s: string | null | undefined): string {
  if (!s) return "未知";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

/** 地点文本：城市 · 省/州 · 国家，与 Immich 详情页一致（都来自 Immich 的逆地理编码） */
const infoLocation = computed(() => {
  const i = info.value;
  if (!i) return "";
  return [i.city, i.state, i.country].filter(Boolean).join(" · ");
});

/** WGS-84 经纬度展示文本（5 位小数 ≈ 1m 精度） */
const infoCoordText = computed(() => {
  const i = info.value;
  if (!i || i.latitude == null || i.longitude == null) return null;
  return `${i.latitude.toFixed(5)}, ${i.longitude.toFixed(5)}`;
});

/** 拍摄点 GCJ-02 坐标 [lng, lat]：vue-amap 的 center/position 与静态瓦片计算共用 */
const infoMapCenter = computed<[number, number] | null>(() => {
  const i = info.value;
  if (!i || i.latitude == null || i.longitude == null) return null;
  return wgs84ToGcj02(i.longitude, i.latitude);
});

/**
 * 静态瓦片兜底：按 GCJ-02 坐标算出缩放级别 14 下所在的 256px 瓦片与瓦片内偏移，
 * 模板里用 CSS 把瓦片定位到拍摄点居中，中央再叠一个图钉。
 */
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
  // 高德瓦片有 4 个子域做负载均衡，按瓦片序号取模分摊
  const sub = ((tileX + tileY) % 4) + 1;
  return {
    url: `https://webrd0${sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tileX}&y=${tileY}&z=${z}`,
    offX: (x - tileX) * 256,
    offY: (y - tileY) * 256,
  };
});

/** hover/点击信息按钮时按需拉取当前张详情（经纬度需实时请求 Immich） */
async function loadInfo(): Promise<void> {
  const p = current.value;
  if (!p || infoCache.value.has(p.id)) return;
  infoLoading.value = true;
  infoError.value = false;
  try {
    infoCache.value.set(p.id, await fetchPhotoInfo(p.id));
  } catch {
    infoError.value = true;
  } finally {
    infoLoading.value = false;
  }
}

function onInfoEnter(): void {
  infoHover.value = true;
  visible.value = true;
  window.clearTimeout(hideTimer);
  ensureAmapLoaded();
  void loadInfo();
}

function onInfoLeave(): void {
  infoHover.value = false;
  show();
}

/* ---------------- 邻居预载 ---------------- */

const preloaded = new Set<string>();

/** 只预载当前张前后各 2 张的预览图，其余照片保持按需加载 */
function preloadNeighbors(center: number): void {
  const len = photos.value.length;
  if (len === 0) return;
  for (let offset = -2; offset <= 2; offset++) {
    if (offset === 0) continue;
    const p = photos.value[(((center + offset) % len) + len) % len];
    if (!p || preloaded.has(p.imageUrl)) continue;
    preloaded.add(p.imageUrl);
    const img = new Image();
    img.src = p.imageUrl;
  }
}

watch(index, (i) => preloadNeighbors(i % Math.max(1, photos.value.length)));

onMounted(() => {
  loadAllPassed()
    .then(async (all) => {
      try {
        settings.value = await fetchSettings();
        // 布局按设备持久化；本设备没有记录时沿用旧的服务端设置（一次性迁移）
        clockLayout.value = loadHudLayout("clock", normalizeLayout(settings.value.frameClockLayout));
        calendarLayout.value = loadHudLayout("calendar", normalizeLayout(settings.value.frameCalendarLayout));
        controlsLayout.value = loadHudLayout("controls");
      } catch {
        /* 设置读取失败时使用默认轮播参数 */
      }
      // 轮播只播已完成装裱的照片（有装裱指令才好看）
      photos.value = buildPlaylist(
        all.filter((p) => p.composeStatus === "done" && p.instruction)
      );
      restorePosition();
      preloadNeighbors(index.value);
    })
    .catch((e: unknown) => (error.value = e instanceof Error ? e.message : "加载失败"))
    .finally(() => (loaded.value = true));
  timer = window.setInterval(tick, TICK_MS);
  window.addEventListener("mousemove", show);
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointerdown", onPickerOutside);
  clockTimer = window.setInterval(() => (now.value = new Date()), 1000);
  show();
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  window.clearInterval(clockTimer);
  window.clearTimeout(hideTimer);
  window.clearTimeout(saveTimer);
  window.clearTimeout(savedTimer);
  window.clearTimeout(voteTimer);
  window.removeEventListener("mousemove", show);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("pointerdown", onPickerOutside);
});
</script>

<template>
  <div class="frame-view" :class="{ 'is-idle': !visible }" @mousemove="show" @pointerdown="show">
    <Transition name="ambient">
      <div
        v-if="current"
        :key="current.id"
        class="ambient"
        :style="{ backgroundImage: `url(${current.imageUrl})` }"
      />
    </Transition>
    <div class="vignette" />

    <Transition name="slidefade">
      <div v-if="current" :key="current.id" class="slide" :class="`fit-${fit}`">
        <ArtFrame :photo="current" size="preview" eager :fit="fit" />
      </div>
    </Transition>

    <HudPanel
      v-if="showClock"
      placement="clock"
      :layout="clockLayout"
      :editing="editing"
      @update:layout="clockLayout = $event"
      @commit="commitLayouts"
      @reset="resetLayout('clock')"
    >
      <div class="clock">
        <div class="time">
          <b>{{ timeText }}</b><span>{{ secondText }}</span>
        </div>
        <div class="date">{{ dateText }}</div>
      </div>
    </HudPanel>

    <HudPanel
      v-if="showCalendar"
      placement="calendar"
      :layout="calendarLayout"
      :editing="editing"
      @update:layout="calendarLayout = $event"
      @commit="commitLayouts"
      @reset="resetLayout('calendar')"
    >
      <div class="calendar">
        <div class="cal-title">{{ monthTitle }}</div>
        <div class="cal-grid">
          <span v-for="(w, i) in weekdays" :key="`w${i}`" class="wd">{{ w }}</span>
          <span
            v-for="(d, i) in calendarCells"
            :key="`d${i}`"
            class="day"
            :class="{ empty: d === null, today: d === today }"
          >
            {{ d ?? "" }}
          </span>
        </div>
      </div>
    </HudPanel>

    <div v-if="editing && (showClock || showCalendar)" class="layout-hint">
      <span>拖动时钟 / 日历 / 控制条调整位置，拖动右下角圆点或滚轮缩放</span>
      <span v-if="saveState === 'saving'" class="hint-save">保存中…</span>
      <span v-else-if="saveState === 'saved'" class="hint-save ok">已保存</span>
      <span v-else-if="saveState === 'error'" class="hint-save err">保存失败</span>
    </div>

    <div v-if="error" class="state">{{ error }}</div>
    <div v-else-if="!loaded" class="state">加载中… {{ loadingCount }} 张</div>
    <div v-else-if="photos.length === 0" class="state">
      暂无已装裱的照片。先在照片墙中审核通过一些照片，等待装裱完成。
    </div>

    <Transition name="fade">
      <div v-if="visible" class="controls" :class="{ editing }" :style="controlsStyle">
        <Transition name="fade">
          <div v-if="voteChoice" class="vote-picker" role="dialog" aria-label="选择评价目标">
            <p class="vote-picker-title">
              评价{{ voteChoice === "like" ? "赞" : "踩" }}哪一项？
            </p>
            <p class="vote-picker-hint">
              {{
                voteChoice === "like"
                  ? "评分赞 = 直接通过并装裱"
                  : "评分踩 = 淘汰不展示 · 装裱踩 = 重新装裱"
              }}
            </p>
            <div class="vote-picker-actions">
              <button
                class="picker-btn"
                :disabled="voting"
                @click.stop="chooseVoteTarget('audit')"
              >
                <span>评价评分</span>
                <em :class="{ on: !!current?.auditVote }">{{ voteState(current?.auditVote) }}</em>
              </button>
              <button
                class="picker-btn"
                :disabled="voting"
                @click.stop="chooseVoteTarget('compose')"
              >
                <span>评价装裱</span>
                <em :class="{ on: !!current?.composeVote }">{{ voteState(current?.composeVote) }}</em>
              </button>
            </div>
          </div>
        </Transition>
        <div
          v-if="editing"
          class="ctrl-grip"
          title="拖动控制条"
          @pointerdown="startControlsDrag"
          @dblclick="resetLayout('controls')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="9" cy="7" r="1.3" />
            <circle cx="15" cy="7" r="1.3" />
            <circle cx="9" cy="12" r="1.3" />
            <circle cx="15" cy="12" r="1.3" />
            <circle cx="9" cy="17" r="1.3" />
            <circle cx="15" cy="17" r="1.3" />
          </svg>
        </div>
        <button class="ctrl" aria-label="上一张" @click="next(-1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5.5 8 12l7.5 6.5" /></svg>
        </button>
        <button
          class="ctrl ctrl--main"
          :aria-label="paused ? '播放' : '暂停'"
          @click="toggle"
        >
          <svg v-if="paused" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8.5 5.5v13M15.5 5.5v13" />
          </svg>
        </button>
        <button class="ctrl" aria-label="下一张" @click="next(1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5 16 12l-7.5 6.5" /></svg>
        </button>
        <button
          class="ctrl ctrl--vote"
          :class="{ 'vote-like': voted('like') }"
          :disabled="!current || voting"
          aria-label="喜欢这张（选择评价评分或装裱）"
          @click="onVote('like')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20.5C7 16.5 3.5 13.2 3.5 9.5 3.5 7 5.4 5 7.9 5c1.7 0 3.2 1 4.1 2.4C12.9 6 14.4 5 16.1 5c2.5 0 4.4 2 4.4 4.5 0 3.7-3.5 7-8.5 11z" />
          </svg>
        </button>
        <button
          class="ctrl ctrl--vote"
          :class="{ 'vote-dislike': voted('dislike') }"
          :disabled="!current || voting"
          aria-label="不喜欢这张（评分踩会淘汰，装裱踩会重新装裱）"
          @click="onVote('dislike')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17 14V4h2.5A1.5 1.5 0 0 1 21 5.5v6A1.5 1.5 0 0 1 19.5 13H17zm0 0-5.2 7.8a1.8 1.8 0 0 1-2.8-2.1l1-1.7H4.5a2 2 0 0 1-2-2.4l1.2-6A2 2 0 0 1 5.7 8H17z" />
          </svg>
        </button>
        <div class="info-wrap" @mouseenter="onInfoEnter" @mouseleave="onInfoLeave">
          <button class="ctrl" aria-label="照片信息" @click="loadInfo">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 11v5.5" />
              <circle cx="12" cy="7.8" r="0.4" fill="currentColor" stroke="currentColor" />
            </svg>
          </button>
          <Transition name="fade">
            <div v-if="infoHover && current" class="info-panel" role="dialog" aria-label="照片信息">
              <div class="info-row">
                <span class="info-label">拍摄时间</span>
                <span class="info-value">{{ fmtTaken(info?.takenAt ?? current.takenAt) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">地点</span>
                <span class="info-value">
                  {{ infoLocation || (infoLoading ? "加载中…" : "未知") }}
                </span>
              </div>
              <div v-if="infoCoordText" class="info-row">
                <span class="info-label">经纬度</span>
                <span class="info-value">{{ infoCoordText }}</span>
              </div>
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
              <div class="info-row">
                <span class="info-label">文件位置</span>
                <span class="info-value info-path">
                  {{ info?.originalPath ?? current.fileName ?? "未知" }}
                </span>
              </div>
              <p v-if="infoLoading" class="info-note">正在从 Immich 读取详情…</p>
              <p v-else-if="infoError" class="info-note err">详情加载失败</p>
              <p v-else-if="info?.offline" class="info-note">Immich 不可达，仅显示本地缓存</p>
            </div>
          </Transition>
        </div>
        <button
          class="ctrl ctrl--layout"
          :class="{ active: editing }"
          :aria-label="editing ? '完成布局' : '调整时钟/日历/控制条布局'"
          @click="toggleEditing"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v18M3 12h18" />
            <path d="M9 6.5 12 3.5l3 3M9 17.5l3 3 3-3M6.5 9l-3 3 3 3M17.5 9l3 3-3 3" />
          </svg>
        </button>
        <span v-if="photos.length" class="counter">
          {{ (index % photos.length) + 1 }} / {{ photos.length }}
        </span>
        <div class="progress">
          <span :style="{ width: `${progress * 100}%` }" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.frame-view {
  position: fixed;
  inset: 0;
  background: #060607;
  overflow: hidden;
}
.frame-view.is-idle {
  cursor: none;
}
/* 当前照片的模糊放大版作为环境光背景 */
.ambient {
  position: absolute;
  inset: -10%;
  z-index: 0;
  background-size: cover;
  background-position: center;
  filter: blur(56px) saturate(0.7) brightness(0.55);
  transform: scale(1.12);
  opacity: 0.6;
}
.vignette {
  position: absolute;
  inset: 0;
  z-index: 1;
  background:
    radial-gradient(120% 92% at 50% 40%, rgba(0, 0, 0, 0.08) 0%, rgba(0, 0, 0, 0.52) 62%, rgba(0, 0, 0, 0.88) 100%),
    linear-gradient(0deg, rgba(0, 0, 0, 0.45), transparent 30%);
}
.slide {
  position: absolute;
  inset: 0;
  z-index: 2;
  padding: clamp(14px, 4.5vmin, 64px);
  display: grid;
  place-items: center;
}
/* 三种模式都不留内边距：contain 光晕铺满、cover/stretch 本来就满屏 */
.slide.fit-cover,
.slide.fit-stretch,
.slide.fit-contain {
  padding: 0;
}
.slide :deep(.art-frame) {
  width: 100%;
  height: 100%;
}
.state {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.48);
  padding: 40px;
  text-align: center;
  letter-spacing: 0.04em;
}

/* 时钟与日历内容（浮层容器样式在 HudPanel 组件内） */
.clock {
  min-width: clamp(150px, 17vmin, 380px);
  text-align: right;
}
.clock .time {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: clamp(4px, 0.6vmin, 12px);
  font-variant-numeric: tabular-nums;
}
.clock .time b {
  font-size: clamp(26px, 5vmin, 116px);
  font-weight: 200;
  line-height: 1;
  letter-spacing: 0.02em;
}
.clock .time span {
  font-size: clamp(11px, 1.7vmin, 40px);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.clock .date {
  margin-top: clamp(3px, 0.5vmin, 12px);
  font-size: clamp(10px, 1.35vmin, 30px);
  color: rgba(255, 255, 255, 0.6);
  letter-spacing: 0.08em;
}
.calendar {
  width: clamp(180px, 20vmin, 470px);
}
.cal-title {
  font-size: clamp(11px, 1.3vmin, 30px);
  letter-spacing: 0.14em;
  color: var(--accent);
  margin-bottom: clamp(6px, 0.9vmin, 20px);
  text-align: center;
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: clamp(2px, 0.3vmin, 6px) 0;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.cal-grid .wd {
  font-size: clamp(9px, 1.05vmin, 24px);
  color: rgba(255, 255, 255, 0.42);
  padding-bottom: clamp(2px, 0.4vmin, 8px);
}
.cal-grid .day {
  font-size: clamp(10px, 1.2vmin, 28px);
  line-height: clamp(20px, 2.4vmin, 56px);
  color: rgba(255, 255, 255, 0.78);
  border-radius: 50%;
}
.cal-grid .day.empty {
  visibility: hidden;
}
.cal-grid .day.today {
  background: var(--accent);
  color: #17120a;
  font-weight: 700;
}

.layout-hint {
  position: absolute;
  z-index: 21;
  left: 50%;
  bottom: clamp(96px, 15vh, 150px);
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  max-width: calc(100vw - 32px);
  padding: 8px 18px;
  border-radius: 999px;
  background: rgba(14, 14, 16, 0.74);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.82);
  font-size: clamp(11px, 1.3vmin, 15px);
  letter-spacing: 0.03em;
  text-align: center;
  pointer-events: none;
}
.hint-save {
  color: rgba(255, 255, 255, 0.55);
}
.hint-save.ok {
  color: var(--ok);
}
.hint-save.err {
  color: var(--danger);
}

.controls {
  position: absolute;
  z-index: 20;
  bottom: clamp(18px, 4vh, 40px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 9px 18px 16px;
  border-radius: 999px;
  background: rgba(14, 14, 16, 0.55);
  backdrop-filter: blur(20px) saturate(1.3);
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
.controls.editing {
  outline: 1px dashed rgba(240, 216, 120, 0.55);
  outline-offset: 4px;
}
/* 评分 / 装裱 投票目标选择浮层：与控制条同风格的毛玻璃 */
.vote-picker {
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: calc(100% + 14px);
  transform: translateX(-50%);
  width: max-content;
  max-width: min(88vw, 340px);
  padding: clamp(7px, 1vmin, 11px);
  display: flex;
  flex-direction: column;
  gap: clamp(4px, 0.6vmin, 7px);
  border-radius: clamp(10px, 1.2vmin, 14px);
  background: rgba(14, 14, 16, 0.82);
  backdrop-filter: blur(20px) saturate(1.3);
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
  cursor: default;
}
.vote-picker::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 100%;
  transform: translateX(-50%);
  border: 8px solid transparent;
  border-top-color: rgba(14, 14, 16, 0.82);
  pointer-events: none;
}
.vote-picker-title {
  margin: 0;
  font-size: clamp(11px, 1.3vmin, 14px);
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.9);
}
.vote-picker-hint {
  margin: 0;
  font-size: clamp(9px, 1vmin, 11px);
  color: rgba(255, 255, 255, 0.5);
}
.vote-picker-actions {
  display: flex;
  flex-wrap: wrap;
  gap: clamp(4px, 0.6vmin, 6px);
}
.picker-btn {
  flex: 1;
  min-width: clamp(92px, 11vmin, 128px);
  min-height: clamp(32px, 4.2vmin, 40px);
  padding: clamp(4px, 0.7vmin, 8px) clamp(10px, 1.4vmin, 16px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: clamp(11px, 1.35vmin, 15px);
  letter-spacing: 0.03em;
  transition: background 0.15s, border-color 0.15s, transform 0.15s;
}
.picker-btn:hover:not(:disabled) {
  background: rgba(201, 162, 39, 0.22);
  border-color: rgba(240, 216, 120, 0.55);
}
.picker-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.picker-btn em {
  font-style: normal;
  font-size: 0.72em;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.45);
}
.picker-btn em.on {
  color: #f0d878;
  border-color: rgba(240, 216, 120, 0.45);
}
.ctrl-grip {
  display: grid;
  place-items: center;
  width: 26px;
  height: 38px;
  margin-right: -2px;
  color: rgba(240, 216, 120, 0.75);
  cursor: grab;
  touch-action: none;
}
.ctrl-grip:active {
  cursor: grabbing;
}
.ctrl-grip svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
  stroke: none;
}
.info-wrap {
  position: relative;
  display: grid;
  place-items: center;
}
/* 照片信息卡：hover 信息按钮弹出，风格与投票浮层一致 */
.info-panel {
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: calc(100% + 14px);
  transform: translateX(-50%);
  width: max-content;
  max-width: min(88vw, 420px);
  padding: clamp(10px, 1.2vmin, 14px) clamp(12px, 1.5vmin, 18px);
  display: flex;
  flex-direction: column;
  gap: clamp(5px, 0.7vmin, 9px);
  border-radius: clamp(10px, 1.2vmin, 14px);
  background: rgba(14, 14, 16, 0.82);
  backdrop-filter: blur(20px) saturate(1.3);
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
  cursor: default;
  text-align: left;
}
.info-panel::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 100%;
  transform: translateX(-50%);
  border: 8px solid transparent;
  border-top-color: rgba(14, 14, 16, 0.82);
  pointer-events: none;
}
.info-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: clamp(10px, 1.2vmin, 13px);
}
.info-label {
  flex-shrink: 0;
  width: 4.2em;
  color: rgba(255, 255, 255, 0.42);
  letter-spacing: 0.05em;
}
.info-value {
  color: rgba(255, 255, 255, 0.88);
  word-break: break-all;
}
.info-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
}
.info-map {
  position: relative;
  overflow: hidden;
  width: clamp(240px, 32vmin, 380px);
  height: clamp(140px, 20vmin, 230px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
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
.info-note {
  margin: 0;
  font-size: clamp(9px, 1vmin, 11px);
  color: rgba(255, 255, 255, 0.45);
}
.info-note.err {
  color: var(--danger);
}
.ctrl {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.78);
  transition: background 0.15s, color 0.15s, transform 0.15s;
}
.ctrl:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: transparent;
  color: #fff;
}
.ctrl:active {
  transform: scale(0.94);
}
.ctrl svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ctrl--main {
  width: 44px;
  height: 44px;
  margin: 0 2px;
  background: rgba(255, 255, 255, 0.92);
  color: #14100a;
}
.ctrl--main:hover:not(:disabled) {
  background: #fff;
  color: #14100a;
}
.ctrl.active {
  background: rgba(201, 162, 39, 0.24);
  color: #f0d878;
}
.ctrl--vote.vote-like {
  background: rgba(226, 88, 88, 0.22);
  color: #ff8f8f;
}
.ctrl--vote.vote-like svg {
  fill: #ff8f8f;
  stroke: #ff8f8f;
}
.ctrl--vote.vote-dislike {
  background: rgba(120, 130, 150, 0.28);
  color: #aab4c8;
}
.counter {
  margin-left: 8px;
  margin-right: 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.52);
}
.progress {
  position: absolute;
  left: 20px;
  right: 20px;
  bottom: 8px;
  height: 2px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #c9a227, #f0d878);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.ambient-enter-active,
.ambient-leave-active {
  transition: opacity 1.2s ease;
}
.ambient-enter-from,
.ambient-leave-to {
  opacity: 0;
}
.slidefade-enter-active,
.slidefade-leave-active {
  transition: opacity 0.8s ease, transform 0.9s ease;
}
.slidefade-enter-from {
  opacity: 0;
  transform: scale(1.015);
}
.slidefade-leave-to {
  opacity: 0;
  transform: scale(0.992);
}
</style>
