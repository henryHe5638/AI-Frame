/**
 * 拍摄时间统一处理：Immich 的 fileCreatedAt 是 UTC 时刻（带 Z），
 * localDateTime 是拍摄地墙钟时间（无时区后缀）。库内混存会导致传给 AI 的
 * 时间与实际差 8 小时，统一换算成 Asia/Shanghai 墙钟时间存储与展示。
 */

const TZ_SUFFIX_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const shanghaiFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** 规范化为上海时区墙钟时间 "YYYY-MM-DDTHH:MM:SS"（无时区后缀）；无法解析时原样返回 */
export function normalizeTakenAt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (TZ_SUFFIX_RE.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return shanghaiFmt.format(d).replace(" ", "T");
    }
  }
  // 裸墙钟时间：统一分隔符为 T
  return s.replace(" ", "T");
}

/**
 * 直接取墙钟部分 "YYYY-MM-DDTHH:MM:SS"，忽略任何时区后缀。
 * 用于 Immich localDateTime：它是拍摄地当地时间被当作 UTC 存储的（墙钟 + Z），
 * 再换算时区会多加 8 小时。
 */
export function wallClock(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : null;
}

/** 展示用（AI 提示词 / 前端）："YYYY-MM-DD HH:mm"（上海时区） */
export function formatTakenAt(raw: string | null | undefined): string | null {
  const n = normalizeTakenAt(raw);
  return n ? n.replace("T", " ").slice(0, 16) : null;
}
