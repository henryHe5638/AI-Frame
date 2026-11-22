<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Instruction, Photo } from "../api";
import { renderFrame } from "../frameStyles";
import { sanitizeOverlaySvg } from "../sanitizeSvg";
import { customFontFamilies, loadCustomFonts } from "../customFonts";

loadCustomFonts();

const props = withDefaults(
  defineProps<{
    photo: Photo;
    size?: "thumbnail" | "preview";
    eager?: boolean;
    /** contain 适应留白 / cover 填充裁切 / stretch 拉伸铺满 */
    fit?: "contain" | "cover" | "stretch";
  }>(),
  { size: "thumbnail", eager: false, fit: "contain" }
);

const FONT_FAMILIES: Record<string, string> = {
  brush: '"Ma Shan Zheng", "LXGW WenKai", "Songti SC", serif',
  kai: '"LXGW WenKai", "Songti SC", serif',
  cute: '"ZCOOL KuaiLe", "LXGW WenKai", sans-serif',
  round: '"ZCOOL QingKe HuangYou", "LXGW WenKai", sans-serif',
  hand: '"Zhi Mang Xing", "LXGW WenKai", cursive',
  gentle: '"ZCOOL XiaoWei", "Songti SC", serif',
};
const FONT_STROKES: Record<string, string> = {
  brush: "0.06em",
  kai: "0.05em",
  cute: "0.06em",
  round: "0.06em",
  hand: "0.05em",
  gentle: "0.045em",
};

const FALLBACK: Instruction = {
  crop: { cx: 0.5, cy: 0.5, width: 1, height: 1 },
  rotate: 0,
  frame: { style: "none", widthPx: 0 },
  text: { content: "", position: "bottom", font: "brush", gradientFrom: "#ffffff", gradientTo: "#cccccc", strokeColor: "#000000" },
};

/** 默认题字配色：奶油白渐变 + 柔和深灰描边，小清新低饱和 */
const DEFAULT_FROM = "#fff8ec";
const DEFAULT_TO = "#f0dcc0";
const DEFAULT_STROKE = "#3d3630";

const ins = computed<Instruction>(() => props.photo.instruction ?? FALLBACK);
const crop = computed(() => ins.value.crop ?? FALLBACK.crop);
const rotate = computed(() => [0, 90, 180, 270].includes(ins.value.rotate) ? ins.value.rotate : 0);
const frame = computed(() => ins.value.frame ?? FALLBACK.frame);
const text = computed(() => ins.value.text ?? FALLBACK.text);
const content = computed(() => (text.value.content ?? "").trim());

/** 旧默认配色（白→灰渐变、旧亮金示例色、纯黑/深棕描边）视为未设置，替换为小清新默认 */
const isDefaultGradient = computed(() => {
  const t = text.value;
  if (!t.gradientFrom || !t.gradientTo) return true;
  const f = t.gradientFrom.toLowerCase();
  const to = t.gradientTo.toLowerCase();
  if ((f === "#ffffff" || f === "#fff") && (to === "#cccccc" || to === "#ccc")) return true;
  return f === "#f5e6c8" && to === "#b98a44";
});
const gradientFrom = computed(() =>
  isDefaultGradient.value ? DEFAULT_FROM : text.value.gradientFrom
);
const gradientTo = computed(() =>
  isDefaultGradient.value ? DEFAULT_TO : text.value.gradientTo
);
const strokeColor = computed(() => {
  const s = (text.value.strokeColor ?? "").toLowerCase();
  return !s || s === "#000000" || s === "#000" || s === "#3a2a12" || s === "#2a1608"
    ? DEFAULT_STROKE
    : s;
});

const src = computed(() =>
  props.size === "preview" ? props.photo.imageUrl : props.photo.thumbnailUrl
);

/** 裁剪舞台宽高比：照片像素 × 裁剪比例；旋转 90/270 时宽高互换 */
const stageAspect = computed(() => {
  const c = crop.value;
  const w = props.photo.width;
  const h = props.photo.height;
  let ar = w && h && w > 0 && h > 0 ? (w * c.width) / (h * c.height) : c.width / c.height;
  if (!Number.isFinite(ar) || ar <= 0) ar = 1;
  return rotate.value === 90 || rotate.value === 270 ? 1 / ar : ar;
});

/* ---------- 预览模式：按容器实测尺寸（≈屏幕）做数值布局 ---------- */

const rootEl = ref<HTMLElement | null>(null);
const box = ref<{ w: number; h: number } | null>(null);
let ro: ResizeObserver | undefined;

onMounted(() => {
  if (props.size !== "preview" || !rootEl.value) return;
  const rect = rootEl.value.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) box.value = { w: rect.width, h: rect.height };
  if (typeof ResizeObserver === "undefined") return;
  ro = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect;
    if (r && r.width > 0 && r.height > 0) box.value = { w: r.width, h: r.height };
  });
  ro.observe(rootEl.value);
});

onBeforeUnmount(() => {
  ro?.disconnect();
});

interface NumericLayout {
  artW: number;
  artH: number;
  outerPx: number;
  matPx: number;
  stageW: number;
  stageH: number;
  /** 设备屏幕（预览容器）最小边，用于把边框/字号换算成与屏幕成比例的大小 */
  screenMin: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 数值布局：相框/卡纸厚度跟随屏幕尺寸等比缩放（以 1000px 参考屏为基准），
 * 题字则完全按照片尺寸取相对字号（跨设备一致）。
 */
const layout = computed<NumericLayout | null>(() => {
  const b = box.value;
  if (props.size !== "preview" || !b) return null;
  const minDim = Math.min(b.w, b.h);
  const ar = stageAspect.value;
  let artW: number;
  let artH: number;
  if (props.fit === "stretch") {
    artW = b.w;
    artH = b.h;
  } else if (props.fit === "cover") {
    artW = Math.max(b.w, b.h * ar);
    artH = artW / ar;
  } else {
    artW = Math.min(b.w, b.h * ar);
    artH = artW / ar;
  }
  const artMin = Math.max(40, Math.min(artW, artH));
  // AI 给出的 widthPx 按 ~1000px 参考屏设计：小屏收窄、大屏加粗，始终保持相近的视觉比例
  const screenScale = clamp(minDim / 1000, 0.55, 3);
  const aiOuter = frameRender.value.outerWidthPx;
  const outerPx =
    aiOuter > 0 ? Math.min(aiOuter * screenScale, Math.max(3, 0.06 * artMin)) : 0;
  const aiMat = frameRender.value.matWidthPx;
  const matRatio = aiOuter > 0 ? aiMat / aiOuter : 0;
  const matPx =
    matRatio > 0 ? Math.min(Math.max(2, outerPx * matRatio), Math.max(2, 0.05 * artMin)) : 0;
  const stageW = Math.max(10, artW - 2 * (outerPx + matPx));
  const stageH = Math.max(10, artH - 2 * (outerPx + matPx));
  return { artW, artH, outerPx, matPx, stageW, stageH, screenMin: minDim };
});

/** 整幅画作按裁剪比例缩放并居中：contain 适应 / cover 填充裁切 / stretch 拉伸 */
const artworkStyle = computed(() => {
  const l = layout.value;
  if (l) return { width: `${l.artW}px`, height: `${l.artH}px` };
  const ar = stageAspect.value;
  if (props.fit === "stretch") {
    return { width: "100cqw", height: "100cqh" };
  }
  const size = `${props.fit === "cover" ? "max" : "min"}(100cqw, calc(100cqh * ${ar}))`;
  return { aspectRatio: String(ar), width: size };
});

const stageStyle = computed(() => {
  const l = layout.value;
  if (l) return { width: `${l.stageW}px`, height: `${l.stageH}px` };
  if (props.fit === "stretch") {
    return { width: "100cqw", height: "100cqh" };
  }
  return {
    width: `min(100cqw, calc(100cqh * ${stageAspect.value}))`,
    aspectRatio: String(stageAspect.value),
  };
});

/** 图片在舞台中的尺寸与偏移：让裁剪区中心对齐舞台中心 */
const imgStyle = computed(() => {
  const c = crop.value;
  return {
    width: `${100 / c.width}%`,
    height: `${100 / c.height}%`,
    left: `${50 - c.cx * (100 / c.width)}%`,
    top: `${50 - c.cy * (100 / c.height)}%`,
    transform: `rotate(${rotate.value}deg)`,
  };
});

const frameRender = computed(() => renderFrame(frame.value.style, frame.value.widthPx));

/** AI 直接写的 SVG 叠加层（客户端再清洗一轮，铺满照片区域） */
const overlaySvg = computed(() => {
  const o = ins.value.overlay;
  return typeof o === "string" && o ? sanitizeOverlaySvg(o) : "";
});

/** 相框与卡纸厚度：预览模式随展示尺寸数值收缩；缩略图按容器宽度收缩 */
const outerWidth = computed(() => {
  if (layout.value) return `${layout.value.outerPx}px`;
  return frameRender.value.outerWidthPx
    ? `min(${frameRender.value.outerWidthPx}px, 4cqw)`
    : "0px";
});
const matWidth = computed(() => {
  if (layout.value) return `${layout.value.matPx}px`;
  return frameRender.value.matWidthPx ? `min(${frameRender.value.matWidthPx}px, 3.2cqw)` : "0px";
});

const outerStyle = computed(() => ({
  ...frameRender.value.outerStyle,
  borderWidth: outerWidth.value,
}));
const matStyle = computed(() => ({
  ...frameRender.value.matStyle,
  padding: matWidth.value,
}));

const filletStyle = computed(() => ({
  inset: `calc(${matWidth.value} - 1px)`,
  borderColor: frameRender.value.fillet,
}));

/** 缩略图小尺寸：纯色 + 描边，避免渐变字号太小时糊掉 */
const simpleText = computed(() => props.size !== "preview");

/**
 * 填充（cover）模式下舞台比屏幕大、会被裁掉，题字若跟着舞台定位会显示不全；
 * 此时题字与衬底改为相对屏幕（组件根容器）定位。字号仍按舞台像素计算，跨设备一致。
 */
const captionAtScreen = computed(() => props.size === "preview" && props.fit === "cover");

/**
 * 预览模式数值字号：完全按照片（裁剪区）尺寸取相对字号，
 * 与屏幕/缩略图容器无关——同一条装裱指令在任何设备上的相对大小一致。
 */
const captionFontPx = computed<number | null>(() => {
  const l = layout.value;
  if (!l || !content.value) return null;
  const vertical =
    text.value.vertical === true ||
    text.value.position === "left" ||
    text.value.position === "right";
  const lines = content.value.split("\n");
  const lineCount = Math.max(1, lines.length);
  const len = Math.max(1, ...lines.map((x) => Array.from(x).length));
  const aiSize =
    typeof text.value.fontSize === "number" &&
    text.value.fontSize >= 2 &&
    text.value.fontSize <= 12
      ? text.value.fontSize
      : null;
  let cap: number;
  let desired: number;
  if (vertical) {
    const em = len * 1.28 + 1.7;
    cap = Math.min((0.8 * l.stageH) / em, (0.36 * l.stageW) / (lineCount * 1.4));
    const auto = Math.min(0.024 * l.stageW, cap);
    desired = aiSize !== null ? (aiSize / 100) * l.stageW : auto;
  } else {
    const em = len * 1.12 + 1.9;
    cap = Math.min((0.88 * l.stageW) / em, (0.4 * l.stageH) / (lineCount * 1.35));
    const auto = Math.min(0.028 * l.stageW, cap);
    desired = aiSize !== null ? (aiSize / 100) * l.stageH : auto;
  }
  const px = Math.min(desired, cap);
  return Math.min(Math.max(12, px), cap);
});

/** 题字：渐变填充 + 与字号成比例的细描边 + 柔和投影；支持竖排、换行、下划线 */
const textStyle = computed<Record<string, string>>(() => {
  const vertical =
    text.value.vertical === true ||
    text.value.position === "left" ||
    text.value.position === "right";
  // 换行：横排为多行，竖排为多列；按最长一行估算字号，并限制总高/总宽
  const lines = content.value.split("\n");
  const lineCount = Math.max(1, lines.length);
  const len = Math.max(1, ...lines.map((l) => Array.from(l).length));
  // 估算整行字宽（em）：字宽 + 字距 + 内边距，用来避免长句溢出画面
  const em = vertical ? len * 1.28 + 1.7 : len * 1.12 + 1.9;
  // AI 指定字号（字高占照片高度百分比）时以其为准，仅保留防溢出上限
  const aiSize =
    typeof text.value.fontSize === "number" && text.value.fontSize >= 2 && text.value.fontSize <= 12
      ? text.value.fontSize
      : null;
  const size = vertical
    ? aiSize !== null
      ? `min(${aiSize}cqw, calc(76cqh / ${em.toFixed(2)}))`
      : `min(2.2cqw, calc(76cqh / ${em.toFixed(2)}), calc(22cqw / ${(lineCount * 1.55).toFixed(2)}))`
    : aiSize !== null
      ? `min(${aiSize}cqh, calc(84cqw / ${em.toFixed(2)}))`
      : `min(2.6cqw, calc(84cqw / ${em.toFixed(2)}), calc(24cqh / ${(lineCount * 1.45).toFixed(2)}))`;

  const style: Record<string, string> = {
    "--stroke": strokeColor.value,
    "--cap-stroke": FONT_STROKES[text.value.font ?? "brush"] ?? "0.06em",
    fontFamily:
      FONT_FAMILIES[text.value.font ?? "brush"] ??
      customFontFamilies[text.value.font ?? ""] ??
      '"Ma Shan Zheng", serif',
    fontSize:
      captionFontPx.value !== null
        ? `${captionFontPx.value}px`
        : `clamp(${simpleText.value ? 9 : 12}px, ${size}, ${vertical ? 24 : 28}px)`,
    letterSpacing: vertical ? "0.26em" : "0.14em",
  };
  if (vertical) style.writingMode = "vertical-rl";
  if (text.value.underline) {
    style.textDecoration = "underline";
    style.textDecorationColor = gradientTo.value;
    style.textDecorationThickness = "0.055em";
    style.textUnderlineOffset = "0.24em";
  }

  if (simpleText.value) {
    style.color = gradientTo.value;
    style.textShadow = "0 1px 2px rgba(0,0,0,0.7), 0 0 6px rgba(0,0,0,0.4)";
    return style;
  }

  style["--cap-from"] = gradientFrom.value;
  style["--cap-to"] = gradientTo.value;
  style.textShadow = [
    "0 0.04em 0.02em rgba(0,0,0,0.42)",
    "0 0.13em 0.3em rgba(0,0,0,0.34)",
    "0 0.3em 0.85em rgba(0,0,0,0.26)",
    `0 0 0.7em ${gradientTo.value}40`,
  ].join(", ");
  return style;
});
</script>

<template>
  <div ref="rootEl" class="art-frame">
    <div
      v-if="size === 'thumbnail'"
      class="thumb-glow"
      :style="src ? { backgroundImage: `url(${src})` } : undefined"
    />
    <!-- 适应（contain）模式：图片一侧拉满，另一侧用同图虚化光晕填满，不再留白 -->
    <div
      v-if="size === 'preview' && fit === 'contain' && src"
      class="stage-glow"
      :style="{ backgroundImage: `url(${src})` }"
    />
    <div class="artwork" :style="[artworkStyle, outerStyle]">
      <div class="mat" :style="matStyle">
        <div class="stage" :style="stageStyle">
          <img
            class="photo"
            :src="src"
            :loading="eager ? 'eager' : 'lazy'"
            alt=""
            :style="imgStyle"
            draggable="false"
          />
          <div class="stage-shade" :style="{ boxShadow: frameRender.innerShade }" />
          <div v-if="frameRender.glass" class="glass" :style="{ background: frameRender.glass }" />
          <div
            v-if="content && !captionAtScreen"
            class="caption-shade"
            :class="`pos-${text.position}`"
          />
          <div
            v-if="content && !captionAtScreen"
            class="caption"
            :class="[`pos-${text.position}`, { 'caption--simple': simpleText }]"
            :data-text="content"
            :style="textStyle"
          >
            {{ content }}
          </div>
          <div v-if="overlaySvg" class="overlay-art" v-html="overlaySvg" />
        </div>
        <div v-if="frameRender.fillet && matWidth !== '0px'" class="fillet" :style="filletStyle" />
      </div>
    </div>
    <!-- cover 模式：题字相对屏幕定位，避免舞台超出屏幕时题字被裁掉 -->
    <div
      v-if="content && captionAtScreen"
      class="caption-shade"
      :class="`pos-${text.position}`"
    />
    <div
      v-if="content && captionAtScreen"
      class="caption"
      :class="`pos-${text.position}`"
      :data-text="content"
      :style="textStyle"
    >
      {{ content }}
    </div>
  </div>
</template>

<style scoped>
/* 父容器内按裁剪比例自适应居中，多余空间留给背景（画框墙/画廊氛围） */
.art-frame {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container-type: size;
}
/* 缩略图衬底：同图虚化，填满画框外的留白 */
.thumb-glow {
  position: absolute;
  inset: -10%;
  background-color: var(--glow-bg, #0d0e12);
  background-size: cover;
  background-position: center;
  filter: blur(26px) saturate(1.05) brightness(0.42);
  transform: scale(1.12);
  pointer-events: none;
}
/* 适应模式衬底：同图虚化光晕铺满屏幕，替代两侧留白 */
.stage-glow {
  position: absolute;
  inset: -6%;
  background-color: #0d0e12;
  background-size: cover;
  background-position: center;
  filter: blur(56px) saturate(1.2) brightness(0.5);
  transform: scale(1.12);
  pointer-events: none;
}
.artwork {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  border-style: solid;
  border-color: transparent;
  overflow: hidden;
}
.mat {
  position: relative;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  container-type: size;
}
.stage {
  position: relative;
  max-width: 100%;
  max-height: 100%;
  overflow: hidden;
  background: #000;
  container-type: size;
}
.photo {
  position: absolute;
  max-width: none;
  object-fit: fill;
  will-change: transform;
}
.stage-shade,
.glass {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.stage-shade {
  z-index: 1;
}
.glass {
  z-index: 2;
}
/* AI 直接写的 SVG 叠加层：铺满照片区域，居于题字之上 */
.overlay-art {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}
.overlay-art :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
/* 卡纸与照片之间的细饰条 */
.fillet {
  position: absolute;
  z-index: 3;
  border: 1px solid transparent;
  pointer-events: none;
}

/* 题字衬底：文字区域柔和的暖黑渐变，保证任何照片背景上可读 */
.caption-shade {
  position: absolute;
  z-index: 1;
  pointer-events: none;
}
.caption-shade.pos-bottom {
  left: 0;
  right: 0;
  bottom: 0;
  height: 42%;
  background: linear-gradient(
    to top,
    rgba(7, 5, 2, 0.5) 0%,
    rgba(7, 5, 2, 0.32) 26%,
    rgba(7, 5, 2, 0.13) 62%,
    transparent 100%
  );
}
.caption-shade.pos-top {
  left: 0;
  right: 0;
  top: 0;
  height: 42%;
  background: linear-gradient(
    to bottom,
    rgba(7, 5, 2, 0.5) 0%,
    rgba(7, 5, 2, 0.32) 26%,
    rgba(7, 5, 2, 0.13) 62%,
    transparent 100%
  );
}
.caption-shade.pos-left {
  left: 0;
  top: 0;
  bottom: 0;
  width: 28%;
  background: linear-gradient(
    to right,
    rgba(7, 5, 2, 0.46) 0%,
    rgba(7, 5, 2, 0.26) 34%,
    transparent 100%
  );
}
.caption-shade.pos-right {
  right: 0;
  top: 0;
  bottom: 0;
  width: 28%;
  background: linear-gradient(
    to left,
    rgba(7, 5, 2, 0.46) 0%,
    rgba(7, 5, 2, 0.26) 34%,
    transparent 100%
  );
}

.caption {
  position: absolute;
  z-index: 4;
  font-family: "Ma Shan Zheng", "LXGW WenKai", "Songti SC", "STSong", serif;
  font-weight: 400;
  color: transparent;
  -webkit-text-stroke: var(--cap-stroke, 0.06em) var(--stroke, #3d3630);
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  pointer-events: none;
  white-space: pre-line;
  text-align: center;
  line-height: 1.45;
}
/* 上层渐变填充：叠在描边层之上，保留亮金渐变与清晰外轮廓 */
.caption::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  padding: inherit;
  color: transparent;
  -webkit-text-stroke: 0;
  background-image: linear-gradient(
    176deg,
    var(--cap-from, #fff7e0) 0%,
    var(--cap-from, #fff7e0) 20%,
    var(--cap-to, #e8c477) 52%,
    var(--cap-from, #fff7e0) 74%,
    var(--cap-to, #e8c477) 100%
  );
  background-clip: text;
  -webkit-background-clip: text;
  pointer-events: none;
}
.caption--simple {
  -webkit-text-stroke-width: 0.045em;
}
.caption--simple::after {
  display: none;
}

.caption.pos-bottom {
  left: 50%;
  bottom: 4.5%;
  transform: translateX(-50%);
  padding: 0.1em 0.9em;
  /* 绝对定位 shrink-to-fit 的可用宽度受「left 到右边缘」限制（只剩半幅），
     竖屏窄舞台下长句会被迫换行；显式按内容取宽、上限整幅，由字号估算保证不溢出 */
  width: max-content;
  max-width: 100%;
  box-sizing: border-box;
}
.caption.pos-top {
  left: 50%;
  top: 4.5%;
  transform: translateX(-50%);
  padding: 0.1em 0.9em;
  width: max-content;
  max-width: 100%;
  box-sizing: border-box;
}
.caption.pos-left,
.caption.pos-right {
  writing-mode: vertical-rl;
  padding: 0.9em 0.1em;
  /* 同上：竖排文字 top:50% 时 shrink-to-fit 可用高度也只剩半幅 */
  height: max-content;
  max-height: 100%;
  box-sizing: border-box;
}
.caption.pos-left {
  left: 4%;
  top: 50%;
  transform: translateY(-50%);
}
.caption.pos-right {
  right: 4%;
  top: 50%;
  transform: translateY(-50%);
}
</style>
