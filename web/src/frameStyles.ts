/**
 * 相框样式预设库：纯 CSS 多层渐变 / box-shadow 模拟经典相框。
 * 新增样式只需在 FRAME_PRESETS 里加一个预设，ArtFrame 自动生效。
 */

export type FrameStyleName = "none" | "wood" | "black" | "white" | "gold";

export interface FramePreset {
  /** 外框（边框区域）样式：背景渐变 + 投影，作用在 .artwork 上 */
  outer: Record<string, string>;
  /** 卡纸内衬（mat）区域样式，作用在 .mat 上 */
  mat: Record<string, string>;
  /** 内衬阴影（照片落进卡纸的凹陷感），渲染为 .stage 上的叠加层 */
  innerShade: string;
  /** 卡纸宽度占外框宽度的比例（0-1） */
  matRatio: number;
  /** 照片与卡纸之间的细饰条颜色（金/黑细线），无则不画 */
  fillet?: string;
  /** 玻璃反光：叠在照片上的低透明度斜向高光 */
  glass?: string;
}

/** 柔和自然的外投影：大范围低透明度 + 小范围接触影 */
const softDrop = (a: number, y: number, b: number): string =>
  `0 ${y}px ${b}px rgba(0,0,0,${a})`;

/** 通用玻璃反光：从左上到右下的两道光带，透明度很低，只提亮质感 */
const GLASS =
  "linear-gradient(114deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.035) 14%, transparent 34%, transparent 62%, rgba(255,255,255,0.045) 78%, rgba(255,255,255,0.012) 88%, transparent 100%)";

export const FRAME_PRESETS: Record<FrameStyleName, FramePreset> = {
  none: { outer: {}, mat: {}, innerShade: "none", matRatio: 0 },

  wood: {
    // 浅色原木：细密木纹（两层低对比 repeating 叠加）+ 立体倒角
    outer: {
      background:
        "repeating-linear-gradient(93deg, rgba(255,232,196,0.07) 0 2px, rgba(60,38,18,0.05) 2px 3px, transparent 3px 9px)," +
        "repeating-linear-gradient(87deg, rgba(60,38,18,0.04) 0 1px, transparent 1px 7px)," +
        "linear-gradient(158deg, #a07a52 0%, #8f6a44 22%, #ab835c 40%, #7d5c3a 58%, #9c7850 76%, #6d4f31 100%)",
      boxShadow: [
        softDrop(0.42, 16, 40),
        softDrop(0.26, 5, 12),
        "inset 0 1px 1px rgba(255,238,208,0.55)",
        "inset 0 -1px 2px rgba(40,26,10,0.45)",
        "inset 0 0 7px rgba(50,32,14,0.26)",
        "inset 0 0 0 1px rgba(255,232,190,0.2)",
      ].join(", "),
    },
    mat: {
      // 米色棉纸：极淡的纤维纹理
      background:
        "repeating-linear-gradient(45deg, rgba(120,90,45,0.03) 0 1px, transparent 1px 3px)," +
        "repeating-linear-gradient(-45deg, rgba(120,90,45,0.02) 0 1px, transparent 1px 4px)," +
        "linear-gradient(160deg, #faf5e9 0%, #f2e9d4 60%, #eadcc0 100%)",
      boxShadow:
        "inset 0 0 0 1px rgba(60,40,15,0.12), inset 0 1px 3px rgba(60,40,15,0.16)",
    },
    innerShade:
      "inset 0 0 2px rgba(40,25,8,0.45), inset 0 2px 4px rgba(40,25,8,0.32), inset 0 -1px 0 rgba(255,235,200,0.08)",
    matRatio: 0.4,
    fillet: "rgba(196, 158, 100, 0.55)",
    glass: GLASS,
  },

  gold: {
    // 淡香槟金：柔和三色金属渐变 + 竖向拉丝 + 高光倒角
    outer: {
      background:
        "repeating-linear-gradient(90deg, rgba(255,252,232,0.08) 0 1px, rgba(120,95,30,0.04) 1px 3px)," +
        "linear-gradient(135deg, #b39a52 0%, #d6c184 14%, #f7f0d8 30%, #e2d3a2 42%, #bfa763 54%, #efe5c0 71%, #d6c184 85%, #a8914a 100%)",
      boxShadow: [
        softDrop(0.42, 16, 38),
        softDrop(0.24, 5, 12),
        "inset 0 0 0 1px rgba(255,250,224,0.7)",
        "inset 0 1px 1px rgba(255,252,235,0.9)",
        "inset 0 -1px 2px rgba(100,80,20,0.5)",
        "inset 0 0 7px rgba(110,90,20,0.32)",
      ].join(", "),
    },
    mat: {
      background:
        "repeating-linear-gradient(45deg, rgba(120,90,20,0.025) 0 1px, transparent 1px 3px)," +
        "linear-gradient(160deg, #fbf6e8 0%, #f3ebd4 58%, #e9dcba 100%)",
      boxShadow:
        "inset 0 0 0 1px rgba(120,90,20,0.16), inset 0 1px 3px rgba(120,90,20,0.2)",
    },
    innerShade:
      "inset 0 0 2px rgba(90,65,10,0.45), inset 0 2px 4px rgba(90,65,10,0.32), inset 0 -1px 0 rgba(255,244,205,0.1)",
    matRatio: 0.4,
    fillet: "rgba(220, 188, 116, 0.7)",
    glass: GLASS,
  },

  black: {
    // 博物馆风：哑光黑细框 + 拉丝质感 + 宽白卡纸
    outer: {
      background:
        "repeating-linear-gradient(0deg, rgba(255,255,255,0.022) 0 1px, transparent 1px 2px)," +
        "linear-gradient(135deg, #2e2e30 0%, #1a1a1c 48%, #0c0c0e 100%)",
      boxShadow: [
        softDrop(0.55, 16, 40),
        softDrop(0.3, 4, 10),
        "inset 0 0 0 1px rgba(255,255,255,0.1)",
        "inset 0 1px 1px rgba(255,255,255,0.16)",
        "inset 0 -1px 2px rgba(0,0,0,0.65)",
        "inset 0 0 6px rgba(0,0,0,0.5)",
      ].join(", "),
    },
    mat: {
      background:
        "repeating-linear-gradient(45deg, rgba(0,0,0,0.02) 0 1px, transparent 1px 3px)," +
        "linear-gradient(160deg, #f8f7f3 0%, #efede7 62%, #e7e5de 100%)",
      boxShadow:
        "inset 0 0 0 1px rgba(0,0,0,0.09), inset 0 1px 3px rgba(0,0,0,0.14)",
    },
    innerShade:
      "inset 0 0 2px rgba(0,0,0,0.45), inset 0 2px 4px rgba(0,0,0,0.34), inset 0 -1px 0 rgba(255,255,255,0.06)",
    matRatio: 0.4,
    fillet: "rgba(24, 24, 26, 0.7)",
    glass: GLASS,
  },

  white: {
    // 博物馆风：暖白细框 + 浅灰卡纸
    outer: {
      background:
        "repeating-linear-gradient(0deg, rgba(0,0,0,0.014) 0 1px, transparent 1px 2px)," +
        "linear-gradient(135deg, #ffffff 0%, #f3f1ea 55%, #e2ded2 100%)",
      boxShadow: [
        softDrop(0.42, 14, 32),
        softDrop(0.2, 4, 10),
        "inset 0 0 0 1px rgba(255,255,255,0.9)",
        "inset 0 -1px 2px rgba(0,0,0,0.16)",
        "inset 0 1px 1px rgba(255,255,255,0.7)",
      ].join(", "),
    },
    mat: {
      background:
        "repeating-linear-gradient(45deg, rgba(0,0,0,0.016) 0 1px, transparent 1px 3px)," +
        "linear-gradient(160deg, #ebeae5 0%, #dddbd2 100%)",
      boxShadow:
        "inset 0 0 0 1px rgba(0,0,0,0.07), inset 0 1px 3px rgba(0,0,0,0.12)",
    },
    innerShade:
      "inset 0 0 2px rgba(60,60,55,0.32), inset 0 2px 4px rgba(60,60,55,0.26), inset 0 -1px 0 rgba(255,255,255,0.1)",
    matRatio: 0.38,
    fillet: "rgba(150, 146, 134, 0.6)",
    glass: GLASS,
  },
};

export interface FrameRender {
  /** 外框像素宽度（0-80 clamp） */
  outerWidthPx: number;
  /** 内衬宽度：随外框自适应 */
  matWidthPx: number;
  outerStyle: Record<string, string>;
  matStyle: Record<string, string>;
  innerShade: string;
  fillet: string;
  glass: string;
}

export function renderFrame(style: string, widthPx: number): FrameRender {
  const name = (style in FRAME_PRESETS ? style : "none") as FrameStyleName;
  const preset = FRAME_PRESETS[name];
  const outerWidthPx = Math.max(0, Math.min(80, widthPx || 0));
  const matWidthPx =
    name === "none" || outerWidthPx === 0
      ? 0
      : Math.max(3, Math.round(outerWidthPx * preset.matRatio));
  return {
    outerWidthPx,
    matWidthPx,
    outerStyle:
      outerWidthPx === 0 ? {} : { borderWidth: `${outerWidthPx}px`, ...preset.outer },
    matStyle: matWidthPx === 0 ? {} : { padding: `${matWidthPx}px`, ...preset.mat },
    innerShade: matWidthPx === 0 ? "none" : preset.innerShade,
    fillet: preset.fillet ?? "",
    glass: preset.glass ?? "",
  };
}
