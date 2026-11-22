<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { HudLayout } from "../api";

const props = withDefaults(
  defineProps<{
    layout: HudLayout | null;
    placement: "clock" | "calendar";
    editing?: boolean;
    minScale?: number;
    maxScale?: number;
  }>(),
  { editing: false, minScale: 0.4, maxScale: 3 }
);

const emit = defineEmits<{
  (e: "update:layout", value: HudLayout): void;
  (e: "commit"): void;
  (e: "reset"): void;
}>();

const el = ref<HTMLElement | null>(null);
const dragging = ref(false);

let mode: "move" | "scale" | null = null;
let base: HudLayout | null = null;
let startX = 0;
let startY = 0;
let startDist = 1;
let latest: HudLayout | null = null;
let commitTimer: number | undefined;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const frameStyle = computed((): Record<string, string> => {
  const l = props.layout;
  if (!l) return {};
  return {
    left: `${l.x * 100}%`,
    top: `${l.y * 100}%`,
    transform: `translate(-50%, -50%) scale(${l.scale})`,
  };
});

function clampLayout(l: HudLayout): HudLayout {
  return {
    x: clamp(l.x, 0.03, 0.97),
    y: clamp(l.y, 0.03, 0.97),
    scale: clamp(l.scale, props.minScale, props.maxScale),
  };
}

/** 首次拖动时没有持久化布局：用当前（CSS 默认位置）的中心换算成相对坐标 */
function baseLayout(): HudLayout {
  if (props.layout) return { ...props.layout };
  const r = el.value?.getBoundingClientRect();
  if (!r) return { x: 0.5, y: 0.5, scale: 1 };
  return {
    x: (r.left + r.width / 2) / Math.max(1, window.innerWidth),
    y: (r.top + r.height / 2) / Math.max(1, window.innerHeight),
    scale: 1,
  };
}

function push(next: HudLayout): void {
  latest = next;
  emit("update:layout", next);
}

function onPointerDown(e: PointerEvent): void {
  if (!props.editing || e.button !== 0) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  mode = "move";
  dragging.value = true;
  base = baseLayout();
  startX = e.clientX;
  startY = e.clientY;
  push(base);
}

function onResizeDown(e: PointerEvent): void {
  if (!props.editing || e.button !== 0) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  mode = "scale";
  dragging.value = true;
  base = baseLayout();
  const r = el.value?.getBoundingClientRect();
  if (r) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    startDist = Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy));
  }
  push(base);
}

function onPointerMove(e: PointerEvent): void {
  if (!mode || !base) return;
  e.preventDefault();
  if (mode === "move") {
    push(
      clampLayout({
        x: base.x + (e.clientX - startX) / Math.max(1, window.innerWidth),
        y: base.y + (e.clientY - startY) / Math.max(1, window.innerHeight),
        scale: base.scale,
      })
    );
    return;
  }
  const r = el.value?.getBoundingClientRect();
  if (!r) return;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
  push(clampLayout({ ...base, scale: base.scale * (dist / startDist) }));
}

function onPointerUp(): void {
  if (!mode) return;
  mode = null;
  dragging.value = false;
  base = null;
  if (latest) emit("commit");
}

function onWheel(e: WheelEvent): void {
  if (!props.editing) return;
  e.preventDefault();
  const current = latest ?? props.layout ?? baseLayout();
  push(clampLayout({ ...current, scale: current.scale * (1 - e.deltaY * 0.0012) }));
  window.clearTimeout(commitTimer);
  commitTimer = window.setTimeout(() => emit("commit"), 400);
}

onBeforeUnmount(() => window.clearTimeout(commitTimer));

watch(
  () => props.layout,
  (v) => {
    if (!v) latest = null;
  }
);
</script>

<template>
  <div
    ref="el"
    class="hud"
    :class="[
      layout ? 'is-positioned' : `placement-${placement}`,
      { 'is-editing': editing, 'is-dragging': dragging },
    ]"
    :style="frameStyle"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
  >
    <slot />
    <template v-if="editing">
      <button
        class="hud-btn hud-reset"
        type="button"
        aria-label="恢复默认位置与大小"
        @pointerdown.stop
        @click.stop="emit('reset')"
      >
        ↺
      </button>
      <button
        class="hud-btn hud-resize"
        type="button"
        aria-label="拖动缩放"
        @pointerdown.stop="onResizeDown"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 21H3v-6M15 3h6v6" />
        </svg>
      </button>
    </template>
  </div>
</template>

<style scoped>
.hud {
  position: absolute;
  z-index: 15;
  color: #fff;
  padding: clamp(10px, 1.35vmin, 26px) clamp(12px, 1.75vmin, 34px);
  border-radius: clamp(12px, 1.6vmin, 30px);
  background: rgba(12, 12, 14, 0.42);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  transform-origin: center center;
  will-change: transform, left, top;
}
.hud.placement-clock {
  right: clamp(18px, 3vw, 44px);
  bottom: clamp(18px, 4.5vh, 48px);
}
.hud.placement-calendar {
  left: clamp(18px, 3vw, 44px);
  bottom: clamp(18px, 4.5vh, 48px);
}
.hud.is-editing {
  pointer-events: auto;
  cursor: grab;
  user-select: none;
  touch-action: none;
  outline: 1px dashed rgba(255, 255, 255, 0.55);
  outline-offset: 6px;
}
.hud.is-dragging {
  cursor: grabbing;
}
.hud-btn {
  position: absolute;
  z-index: 2;
  display: grid;
  place-items: center;
  width: clamp(24px, 3vmin, 40px);
  height: clamp(24px, 3vmin, 40px);
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.45);
  border-radius: 50%;
  background: rgba(20, 20, 24, 0.92);
  color: #fff;
  font-size: clamp(14px, 1.8vmin, 22px);
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
}
.hud-btn:hover {
  background: rgba(40, 40, 46, 0.98);
  border-color: rgba(255, 255, 255, 0.7);
}
.hud-reset {
  left: calc(-1 * clamp(12px, 1.5vmin, 20px));
  top: calc(-1 * clamp(12px, 1.5vmin, 20px));
}
.hud-resize {
  right: calc(-1 * clamp(12px, 1.5vmin, 20px));
  bottom: calc(-1 * clamp(12px, 1.5vmin, 20px));
  cursor: nwse-resize;
  touch-action: none;
}
.hud-resize svg {
  width: clamp(12px, 1.5vmin, 20px);
  height: clamp(12px, 1.5vmin, 20px);
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
