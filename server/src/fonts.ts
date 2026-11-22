import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";

/**
 * 自定义字体：用户把字体文件（汉仪 / 方正 / Aa 字库等，.ttf/.otf/.woff/.woff2）
 * 放进 server/data/fonts/，服务端扫描后经 /fonts/<file> 提供下载，
 * 装裱提示词与前端渲染都可引用。字体 id 供 AI 在 text.font / overlay font-family 中使用。
 */

export const FONTS_DIR = path.join(DATA_DIR, "fonts");

const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

export interface CustomFont {
  /** 供 AI 与指令使用的标识：文件名 slug（小写字母数字与连字符） */
  id: string;
  /** 字体展示名（文件名去扩展名） */
  family: string;
  /** 静态访问路径 */
  url: string;
}

function slugify(base: string): string {
  return base
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** 扫描自定义字体目录（目录不存在/为空时返回空数组） */
export function listCustomFonts(): CustomFont[] {
  let files: string[];
  try {
    files = fs.readdirSync(FONTS_DIR).filter((f) => FONT_EXT.test(f));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: CustomFont[] = [];
  for (const f of files.sort()) {
    const id = slugify(f);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, family: f.replace(/\.[^.]+$/, ""), url: `/fonts/${encodeURIComponent(f)}` });
  }
  return out;
}
