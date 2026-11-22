import { reactive } from "vue";
import { fetchFonts } from "./api";

/** 自定义字体（server/data/fonts 下的字体文件），key 为字体 id（文件名 slug） */
export const customFontFamilies = reactive<Record<string, string>>({});
/** 用于设置页展示 */
export const customFontList = reactive<{ id: string; family: string }[]>([]);

let loaded = false;
let loading: Promise<void> | null = null;

export async function loadCustomFonts(): Promise<void> {
  // 成功后才标记 loaded；失败（如未登录 401）允许下次重试
  if (loaded) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const { fonts } = await fetchFonts();
      for (const f of fonts) {
        // 只注册 @font-face，不主动 load：CJK 字体动辄 10MB+，
        // 全量预加载会长时间卡死渲染进程；浏览器会在真正用到该字体时才下载
        const face = new FontFace(f.family, `url(${f.url})`);
        document.fonts.add(face);
        customFontFamilies[f.id] = `"${f.family}", "LXGW WenKai", serif`;
        customFontList.push({ id: f.id, family: f.family });
      }
      loaded = true;
    } catch {
      // 接口失败（未登录/网络）保持未加载状态，下次调用重试
    } finally {
      loading = null;
    }
  })();
  return loading;
}
