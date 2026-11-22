import type { HudLayout } from "./api";

/** 时钟 / 日历浮层布局按设备持久化（localStorage），不同相框设备可各自调整 */
const KEYS = {
  clock: "aaf_hud_clock_layout",
  calendar: "aaf_hud_calendar_layout",
  controls: "aaf_hud_controls_layout",
} as const;

export type HudKind = keyof typeof KEYS;

function valid(l: unknown): l is HudLayout {
  if (!l || typeof l !== "object") return false;
  const v = l as Record<string, unknown>;
  return (
    typeof v.x === "number" && v.x >= 0 && v.x <= 1 &&
    typeof v.y === "number" && v.y >= 0 && v.y <= 1 &&
    typeof v.scale === "number" && v.scale >= 0.4 && v.scale <= 3
  );
}

/** 读取本设备保存的布局；没有时返回 fallback（用于从旧的服务端设置迁移） */
export function loadHudLayout(kind: HudKind, fallback: HudLayout | null = null): HudLayout | null {
  try {
    const raw = localStorage.getItem(KEYS[kind]);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 保存布局到本设备；传 null 恢复默认（删除本地记录） */
export function saveHudLayout(kind: HudKind, layout: HudLayout | null): void {
  try {
    if (layout) localStorage.setItem(KEYS[kind], JSON.stringify(layout));
    else localStorage.removeItem(KEYS[kind]);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function resetHudLayouts(): void {
  saveHudLayout("clock", null);
  saveHudLayout("calendar", null);
  saveHudLayout("controls", null);
}
