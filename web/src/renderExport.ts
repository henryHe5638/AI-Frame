import type { Instruction, Photo } from "./api";
import { sanitizeOverlaySvg } from "./sanitizeSvg";
import { customFontFamilies, loadCustomFonts } from "./customFonts";

/**
 * 装裱图导出：在 canvas 上复刻 ArtFrame 的预览渲染（裁剪/旋转/题字/SVG 叠加层），
 * 输出 JPEG。漫画化照片的图片代理本身返回漫画图，因此导出天然带漫画效果。
 * 相框（wood/gold 等旧样式）用近似纯色替代 CSS 多层渐变，题字落款走 SVG 时用系统字体。
 */

const FONT_FAMILIES: Record<string, string> = {
  brush: '"Ma Shan Zheng", "LXGW WenKai", "Songti SC", serif',
  kai: '"LXGW WenKai", "Songti SC", serif',
  cute: '"ZCOOL KuaiLe", "LXGW WenKai", sans-serif',
  round: '"ZCOOL QingKe HuangYou", "LXGW WenKai", sans-serif',
  hand: '"Zhi Mang Xing", "LXGW WenKai", cursive',
  gentle: '"ZCOOL XiaoWei", "Songti SC", serif',
};
const FONT_STROKES: Record<string, number> = {
  brush: 0.06, kai: 0.05, cute: 0.06, round: 0.06, hand: 0.05, gentle: 0.045,
};

const DEFAULT_FROM = "#fff8ec";
const DEFAULT_TO = "#f0dcc0";
const DEFAULT_STROKE = "#3d3630";

const FRAME_COLORS: Record<string, { outer: string; mat: string }> = {
  wood: { outer: "#8f6a44", mat: "#f2e9d4" },
  gold: { outer: "#d6c184", mat: "#f3ebd4" },
  black: { outer: "#1a1a1c", mat: "#efede7" },
  white: { outer: "#f3f1ea", mat: "#e3e1d8" },
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

function resolveTextStyle(ins: Instruction): {
  from: string; to: string; stroke: string; family: string; strokeEm: number;
} {
  const t = ins.text;
  let from = t.gradientFrom || DEFAULT_FROM;
  let to = t.gradientTo || DEFAULT_TO;
  const f = from.toLowerCase();
  const tl = to.toLowerCase();
  if ((f === "#ffffff" || f === "#fff") && (tl === "#cccccc" || tl === "#ccc")) {
    from = DEFAULT_FROM; to = DEFAULT_TO;
  } else if (f === "#f5e6c8" && tl === "#b98a44") {
    from = DEFAULT_FROM; to = DEFAULT_TO;
  }
  let stroke = (t.strokeColor ?? "").toLowerCase();
  if (!stroke || stroke === "#000000" || stroke === "#000" || stroke === "#3a2a12" || stroke === "#2a1608") {
    stroke = DEFAULT_STROKE;
  } else {
    stroke = t.strokeColor!;
  }
  const family =
    FONT_FAMILIES[t.font ?? ""] ??
    customFontFamilies[t.font ?? ""] ??
    '"Ma Shan Zheng", "LXGW WenKai", serif';
  const strokeEm = FONT_STROKES[t.font ?? ""] ?? 0.06;
  return { from, to, stroke, family, strokeEm };
}

/** 与 ArtFrame 预览一致的字号计算（相对舞台像素） */
function captionFontPx(
  ins: Instruction, stageW: number, stageH: number, vertical: boolean, lines: string[]
): number {
  const lineCount = Math.max(1, lines.length);
  const len = Math.max(1, ...lines.map((x) => Array.from(x).length));
  const aiSize =
    typeof ins.text.fontSize === "number" && ins.text.fontSize >= 2 && ins.text.fontSize <= 12
      ? ins.text.fontSize : null;
  let cap: number;
  let desired: number;
  if (vertical) {
    const em = len * 1.28 + 1.7;
    cap = Math.min((0.8 * stageH) / em, (0.36 * stageW) / (lineCount * 1.4));
    const auto = Math.min(0.024 * stageW, cap);
    desired = aiSize !== null ? (aiSize / 100) * stageW : auto;
  } else {
    const em = len * 1.12 + 1.9;
    cap = Math.min((0.88 * stageW) / em, (0.4 * stageH) / (lineCount * 1.35));
    const auto = Math.min(0.028 * stageW, cap);
    desired = aiSize !== null ? (aiSize / 100) * stageH : auto;
  }
  return Math.min(Math.max(12, Math.min(desired, cap)), cap);
}

async function drawOverlaySvg(
  ctx: CanvasRenderingContext2D, svg: string, x: number, y: number, w: number, h: number
): Promise<void> {
  const clean = sanitizeOverlaySvg(svg);
  if (!clean) return;
  // 显式给定像素宽高，让 SVG 内 font-size 等按 0-100 viewBox 正确缩放
  const sized = clean.replace(/<svg\b/, `<svg width="${Math.round(w)}" height="${Math.round(h)}"`);
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
  try {
    const img = await loadImage(url);
    ctx.drawImage(img, x, y, w, h);
  } catch {
    /* 叠加层渲染失败则跳过，不影响主体导出 */
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawCaptionShade(
  ctx: CanvasRenderingContext2D, pos: string, x: number, y: number, w: number, h: number
): void {
  let g: CanvasGradient;
  if (pos === "top") {
    g = ctx.createLinearGradient(0, y, 0, y + h * 0.42);
    g.addColorStop(0, "rgba(7,5,2,0.5)"); g.addColorStop(0.26, "rgba(7,5,2,0.32)");
    g.addColorStop(0.62, "rgba(7,5,2,0.13)"); g.addColorStop(1, "transparent");
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h * 0.42);
  } else if (pos === "left" || pos === "right") {
    const x0 = pos === "left" ? x : x + w;
    const x1 = pos === "left" ? x + w * 0.28 : x + w * 0.72;
    g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, "rgba(7,5,2,0.46)"); g.addColorStop(0.34, "rgba(7,5,2,0.26)");
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g; ctx.fillRect(Math.min(x0, x1), y, w * 0.28, h);
  } else {
    g = ctx.createLinearGradient(0, y + h, 0, y + h * 0.58);
    g.addColorStop(0, "rgba(7,5,2,0.5)"); g.addColorStop(0.26, "rgba(7,5,2,0.32)");
    g.addColorStop(0.62, "rgba(7,5,2,0.13)"); g.addColorStop(1, "transparent");
    ctx.fillStyle = g; ctx.fillRect(x, y + h * 0.58, w, h * 0.42);
  }
}

function makeTextGradient(
  ctx: CanvasRenderingContext2D, from: string, to: string,
  x: number, y: number, w: number, h: number
): CanvasGradient {
  // 176deg ≈ 自上而下微倾斜
  const g = ctx.createLinearGradient(x + w * 0.02, y, x + w * 0.02, y + h);
  g.addColorStop(0, from); g.addColorStop(0.2, from); g.addColorStop(0.52, to);
  g.addColorStop(0.74, from); g.addColorStop(1, to);
  return g;
}

async function drawCaption(
  ctx: CanvasRenderingContext2D, ins: Instruction, x: number, y: number, w: number, h: number
): Promise<void> {
  const content = (ins.text.content ?? "").trim();
  if (!content) return;
  // 自定义字体是懒加载的，导出前确保题字用到的字体已就绪
  try {
    const { family } = resolveTextStyle(ins);
    await Promise.race([
      document.fonts.load(`16px ${family}`, content),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  } catch { /* 加载失败则用回退字体 */ }
  const vertical = ins.text.vertical === true || ins.text.position === "left" || ins.text.position === "right";
  const lines = content.split("\n");
  const px = captionFontPx(ins, w, h, vertical, lines);
  const { from, to, stroke, family, strokeEm } = resolveTextStyle(ins);

  ctx.save();
  ctx.font = `${px}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      `${(vertical ? 0.26 : 0.14) * px}px`;
  } catch { /* 老浏览器无 letterSpacing，忽略 */ }
  ctx.shadowColor = "rgba(0,0,0,0.42)";
  ctx.shadowBlur = px * 0.15;
  ctx.shadowOffsetY = px * 0.04;

  const fill = makeTextGradient(ctx, from, to, x, y, w, h);
  const paint = (text: string, cx: number, cy: number): void => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeEm * px;
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = fill;
    ctx.fillText(text, cx, cy);
  };

  const lineH = px * 1.45;
  if (!vertical) {
    const totalH = lines.length * lineH;
    const cx = x + w / 2;
    const edge = ins.text.position === "top" ? y + h * 0.045 + px * 0.1 : y + h * 0.955 - px * 0.1;
    const startY = ins.text.position === "top" ? edge + lineH / 2 : edge - totalH + lineH / 2;
    lines.forEach((line, i) => paint(line, cx, startY + i * lineH));
    if (ins.text.underline) {
      const uy = startY + (lines.length - 1) * lineH + px * 0.5 + px * 0.24;
      const halfW = Math.max(...lines.map((l) => ctx.measureText(l).width)) / 2;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = to;
      ctx.lineWidth = Math.max(1, 0.055 * px);
      ctx.beginPath(); ctx.moveTo(cx - halfW, uy); ctx.lineTo(cx + halfW, uy); ctx.stroke();
    }
  } else {
    // vertical-rl：每行一列，首列在最右；字符自上而下
    const advance = px * 1.26;
    const maxLen = Math.max(...lines.map((l) => Array.from(l).length));
    const blockH = maxLen * advance;
    const colGap = px * 1.45;
    const blockW = lines.length * colGap;
    const rightEdge = ins.text.position === "left"
      ? x + w * 0.04 + px * 0.1 + blockW : x + w * 0.96 - px * 0.1;
    lines.forEach((line, li) => {
      const colX = rightEdge - colGap / 2 - li * colGap;
      const chars = Array.from(line);
      const colH = chars.length * advance;
      let cy = y + h / 2 - blockH / 2 + (blockH - colH) / 2 + advance / 2;
      for (const ch of chars) {
        paint(ch, colX, cy);
        cy += advance;
      }
    });
  }
  ctx.restore();
}

/** 渲染装裱结果为 JPEG Blob */
export async function renderComposed(photo: Photo): Promise<Blob> {
  await loadCustomFonts();
  try { await document.fonts.ready; } catch { /* ignore */ }

  const img = await loadImage(photo.imageUrl);
  const raw = photo.instruction;
  const ins: Instruction = {
    crop: raw?.crop ?? { cx: 0.5, cy: 0.5, width: 1, height: 1 },
    rotate: raw?.rotate ?? 0,
    frame: raw?.frame ?? { style: "none", widthPx: 0 },
    text: {
      gradientFrom: "", gradientTo: "", strokeColor: "",
      content: "", position: "bottom", ...(raw?.text ?? {}),
    },
    overlay: raw?.overlay ?? null,
  };
  const c = ins.crop ?? { cx: 0.5, cy: 0.5, width: 1, height: 1 };
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  let cw = clamp(c.width, 0.05, 1) * iw;
  let ch = clamp(c.height, 0.05, 1) * ih;
  let sx = clamp(c.cx, 0, 1) * iw - cw / 2;
  let sy = clamp(c.cy, 0, 1) * ih - ch / 2;
  sx = clamp(sx, 0, Math.max(0, iw - cw));
  sy = clamp(sy, 0, Math.max(0, ih - ch));

  const rotate = [0, 90, 180, 270].includes(ins.rotate) ? ins.rotate : 0;
  const swapped = rotate === 90 || rotate === 270;
  const stageW0 = swapped ? ch : cw;
  const stageH0 = swapped ? cw : ch;

  // 导出尺寸：按裁剪后的原始像素出图；不足 2560 时放大到 2560，保证清晰度
  const k = Math.max(1, 2560 / Math.max(stageW0, stageH0));
  const stageW = Math.round(stageW0 * k);
  const stageH = Math.round(stageH0 * k);

  // 相框（旧样式近似纯色；现代指令均为 none）
  const style = ins.frame?.style ?? "none";
  const aiOuter = clamp(ins.frame?.widthPx ?? 0, 0, 80);
  const artMin = Math.max(40, Math.min(stageW, stageH));
  const screenScale = clamp(Math.min(stageW, stageH) / 1000, 0.55, 3);
  const outerPx = style !== "none" && aiOuter > 0
    ? Math.min(aiOuter * screenScale, Math.max(3, 0.06 * artMin)) : 0;
  const matPx = outerPx > 0 ? Math.min(Math.max(2, outerPx * 0.4), Math.max(2, 0.05 * artMin)) : 0;
  const off = Math.round(outerPx + matPx);

  const canvas = document.createElement("canvas");
  canvas.width = stageW + off * 2;
  canvas.height = stageH + off * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");

  const colors = FRAME_COLORS[style];
  ctx.fillStyle = colors?.outer ?? "#101114";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (colors && matPx > 0) {
    ctx.fillStyle = colors.mat;
    ctx.fillRect(outerPx, outerPx, canvas.width - outerPx * 2, canvas.height - outerPx * 2);
  }

  // 照片（裁剪 + 旋转）
  ctx.save();
  ctx.beginPath();
  ctx.rect(off, off, stageW, stageH);
  ctx.clip();
  ctx.fillStyle = "#000";
  ctx.fillRect(off, off, stageW, stageH);
  ctx.translate(off + stageW / 2, off + stageH / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(img, sx, sy, cw, ch, (-cw * k) / 2, (-ch * k) / 2, cw * k, ch * k);
  ctx.restore();

  const pos = ins.text?.position ?? "bottom";
  if ((ins.text?.content ?? "").trim()) drawCaptionShade(ctx, pos, off, off, stageW, stageH);
  await drawCaption(ctx, ins, off, off, stageW, stageH);
  if (typeof ins.overlay === "string" && ins.overlay) {
    await drawOverlaySvg(ctx, ins.overlay, off, off, stageW, stageH);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("导出失败"))),
      "image/jpeg",
      0.92
    );
  });
}

/** 渲染并触发浏览器下载 */
export async function downloadComposed(photo: Photo): Promise<void> {
  const blob = await renderComposed(photo);
  const base = (photo.fileName ?? `photo-${photo.id}`).replace(/\.[a-z0-9]+$/i, "");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}-framed.jpg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
