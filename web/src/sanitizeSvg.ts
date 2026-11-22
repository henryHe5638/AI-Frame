/**
 * 清洗 AI 写的 SVG 叠加层：移除脚本/事件/外部资源，强制铺满画布。
 * 服务端已做一轮保守校验，这里用 DOMParser 再做一轮（防御纵深）。
 */
export function sanitizeOverlaySvg(raw: string): string {
  try {
    const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
    if (doc.querySelector("parsererror")) return "";
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return "";
    const bannedTags = new Set([
      "script",
      "foreignobject",
      "iframe",
      "object",
      "embed",
      "link",
      "style",
      "image",
      "use",
      "a",
      "audio",
      "video",
    ]);
    const walk = (el: Element): void => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "href" || name === "xlink:href") {
          el.removeAttribute(attr.name);
        } else if (/url\(\s*['"]?\s*(https?:|data:|javascript:)/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
      for (const child of Array.from(el.children)) {
        if (bannedTags.has(child.tagName.toLowerCase())) {
          el.removeChild(child);
          continue;
        }
        walk(child);
      }
    };
    walk(root);
    root.setAttribute("width", "100%");
    root.setAttribute("height", "100%");
    root.setAttribute("preserveAspectRatio", "none");
    if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", "0 0 100 100");
    return new XMLSerializer().serializeToString(root);
  } catch {
    return "";
  }
}
