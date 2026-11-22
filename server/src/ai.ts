import type { Settings } from "./config.js";
export { DEFAULT_CARTOON_PROMPT } from "./config.js";

const AI_TIMEOUT_MS = 1_800_000;
const AI_RETRIES = 1; // 失败后重试 1 次

export interface ChatMessage {
  role: "system" | "user";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}

export class AiError extends Error {}

interface ChatOptions {
  group: "audit" | "compose";
  messages: ChatMessage[];
  jsonMode?: boolean;
  settings: Settings;
  /** 覆盖默认 600s 超时（批量请求卡死时需要更快失败以触发降级） */
  timeoutMs?: number;
  /** 覆盖默认 1 次重试 */
  retries?: number;
}

/** 调用 OpenAI 兼容 chat completions 接口。jsonMode 时优先 response_format=json_object，400 时降级重试。 */
export async function chatCompletion(opts: ChatOptions): Promise<string> {
  const { group, messages, jsonMode, settings } = opts;
  const g = settings[group];
  if (!g.apiKey) throw new AiError(`AI 未配置 apiKey（${group}）`);
  if (!g.model) throw new AiError(`AI 未配置 model（${group}）`);
  const base = g.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const retries = opts.retries ?? AI_RETRIES;
  const timeoutMs = opts.timeoutMs ?? AI_TIMEOUT_MS;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await request(url, g.apiKey, g.model, messages, jsonMode ?? false, timeoutMs, g.thinking);
    } catch (e) {
      lastErr = e;
      if (e instanceof AiError && e.message.startsWith("HTTP 400") && jsonMode) {
        // 模型不支持 response_format，降级为普通请求再试
        try {
          return await request(url, g.apiKey, g.model, messages, false, timeoutMs, g.thinking);
        } catch (e2) {
          lastErr = e2;
        }
      }
      if (attempt < retries) await sleep(2000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new AiError(String(lastErr));
}

async function request(
  url: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  jsonMode: boolean,
  timeoutMs: number,
  thinking: "default" | "on" | "off"
): Promise<string> {
  const body: Record<string, unknown> = { model, messages, temperature: 0.4 };
  if (jsonMode) body.response_format = { type: "json_object" };
  // 思考模式：同时带上 OpenAI 兼容生态里常见的几种字段，不识别的提供方会忽略
  if (thinking !== "default") {
    const enabled = thinking === "on";
    body.enable_thinking = enabled;
    body.thinking = { type: enabled ? "enabled" : "disabled" };
    body.chat_template_kwargs = { enable_thinking: enabled };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AiError(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new AiError("AI 返回内容为空");
  return content;
}

/** 容错解析：提取第一个 { 到最后一个 } 之间的子串再 JSON.parse */
export function extractJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AiError("AI 返回中未找到 JSON 对象");
  }
  const raw = text.slice(start, end + 1);
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new AiError(`JSON 解析失败: ${(e as Error).message}；原文: ${raw.slice(0, 300)}`);
  }
}

/** 模型能力（按模型名推断；提供方 /models 接口通常不含能力信息） */
export interface ModelCaps {
  /** 支持图片输入（视觉） */
  vision: boolean;
  /** 支持图像生成/编辑 */
  imageGen: boolean;
  /** 支持思考模式开关 */
  thinking: boolean;
}

const IMAGE_GEN_RE =
  /gpt-image|qwen-image|dall-?e|seededit|seedream|flux|stable.?diffusion|sdxl|sd3|kolors|wanx|cogview|hunyuan-?(image|di?t)|image-?gen|imagen|flash-image|banana/i;
const VISION_RE =
  /gpt-4o|gpt-4\.1|gpt-5|vision|qwen.*vl|omni|glm-?4v|glm-4\.[56]|gemini|claude|llava|minicpm-?v|pixtral|internvl|deepseek-?vl|kimi.*(vision|latest)|step.*v|hunyuan-?vision|abab.*vision|moonshot-v1-.*vision/i;
const THINKING_RE =
  /qwen3|qwq|deepseek-?r1|deepseek-?v3\.[12]|reasoner|^o[134]|gpt-5|thinking|glm-4\.[56]|hunyuan-?t1|kimi.*thinking|seed-?oss|doubao.*1\.6|ernie-?x1/i;
/** 纯文本/非视觉模型（无图片输入能力）的否定特征，避免 VISION_RE 误命中 */
const TEXT_ONLY_RE = /embed|bge|rerank|whisper|tts|tts-|moderation|asr|livetranslate/i;

export function inferModelCaps(id: string): ModelCaps {
  const imageGen = IMAGE_GEN_RE.test(id);
  return {
    vision: imageGen ? false : VISION_RE.test(id) && !TEXT_ONLY_RE.test(id),
    imageGen,
    thinking: THINKING_RE.test(id),
  };
}

/** 从 /models 条目的 capabilities / type 等字段提取能力（LM Studio 等提供方会返回；取不到则交给名称推断兜底） */
function capsFromFields(m: Record<string, unknown>): Partial<ModelCaps> {
  const caps: Partial<ModelCaps> = {};
  const c = m.capabilities;
  if (Array.isArray(c)) {
    const arr = c.map(String);
    if (arr.includes("vision")) caps.vision = true;
    if (arr.some((x) => /image.*(gen|creat|edit)/i.test(x))) caps.imageGen = true;
    if (arr.some((x) => /think|reason/i.test(x))) caps.thinking = true;
  } else if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (typeof o.vision === "boolean") caps.vision = o.vision;
    for (const k of ["image_generation", "imageGeneration", "image_gen"]) {
      if (typeof o[k] === "boolean") caps.imageGen = o[k] as boolean;
    }
    for (const k of ["thinking", "reasoning"]) {
      const v = o[k];
      if (typeof v === "boolean") caps.thinking = v;
      // LM Studio：reasoning: { allowed_options: ["off","on"], default: "on" }
      else if (v && typeof v === "object") {
        const opts = (v as Record<string, unknown>).allowed_options;
        if (Array.isArray(opts)) caps.thinking = opts.some((x) => String(x) !== "off");
      }
    }
  }
  // LM Studio 原生 /api/v1/models 的 type：vlm / llm / embeddings / image
  if (typeof m.type === "string") {
    const t = m.type.toLowerCase();
    if (t === "image" || /image/.test(t)) caps.imageGen = true;
    if (t === "vlm") caps.vision = true;
    if ((t === "llm" || /embed/.test(t)) && caps.vision === undefined) caps.vision = false;
  }
  return caps;
}

interface ListedModel extends ModelCaps {
  id: string;
}

/**
 * 拉取模型列表（GET {baseUrl}/models，OpenAI 兼容）。
 * 条目自带 capabilities/type 字段时优先使用；否则若提供方是 LM Studio
 * （baseUrl 以 /v1 结尾），再试原生 /api/v1/models 取 capabilities；
 * 都取不到则按模型名推断。
 */
export async function listModels(
  group: "audit" | "compose",
  settings: Settings
): Promise<ListedModel[]> {
  const g = settings[group];
  if (!g.apiKey) throw new AiError(`AI 未配置 apiKey（${group}），请先保存设置`);
  const base = g.baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${g.apiKey}` };

  const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AiError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const rawList = (
    Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
  ) as Array<Record<string, unknown>>;

  const byId = new Map<string, ListedModel>();
  for (const m of rawList) {
    if (typeof m?.id !== "string" || !m.id) continue;
    byId.set(m.id, { id: m.id, ...inferModelCaps(m.id), ...capsFromFields(m) });
  }

  // LM Studio：OpenAI 兼容端点不带 capabilities，原生 /api/v1/models 才带
  if (/\/v1$/.test(base) && rawList.every((m) => m.capabilities === undefined)) {
    try {
      const nativeRes = await fetch(`${base.slice(0, -3)}/api/v1/models`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (nativeRes.ok) {
        const native = (await nativeRes.json()) as Record<string, unknown>;
        const list = (Array.isArray(native.models) ? native.models : []) as Array<
          Record<string, unknown>
        >;
        for (const m of list) {
          // LM Studio 原生端点的模型 id 字段是 key 而不是 id
          const id = typeof m?.key === "string" ? m.key : typeof m?.id === "string" ? m.id : "";
          if (!id) continue;
          const existing = byId.get(id);
          byId.set(id, {
            id,
            ...inferModelCaps(id),
            ...(existing ?? {}),
            ...capsFromFields(m),
          });
        }
      }
    } catch {
      // 原生端点不可用则忽略，沿用名称推断
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 漫画化默认风格提示已移至 config.ts（成为可配置的 cartoonPrompt 设置项），此处保留 re-export 兼容引用 */

/**
 * 漫画化：把照片转成漫画风格。两种通道按提供方能力自动选择：
 * 1. 优先 POST {baseUrl}/images/edits（multipart 上传原图，OpenAI 标准图生图）；
 * 2. 提供方不支持 edits 时，若给了 imageUrl（公网临时签名 URL），改用
 *    POST {baseUrl}/images/generations 并以 image 字段传 URL（阿里云 MaaS 网关形态）。
 * 返回兼容 b64_json 与 url 两种形态。
 */
export async function cartoonizeImage(
  settings: Settings,
  image: Buffer,
  prompt: string,
  imageUrl?: string | null
): Promise<Buffer> {
  const g = settings.compose;
  if (!g.apiKey) throw new AiError("AI 未配置 apiKey（compose）");
  if (!g.cartoonModel) throw new AiError("未配置漫画化模型（compose.cartoonModel）");
  const base = g.baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${g.apiKey}` };

  // 通道 1：images/edits（multipart 上传）
  let editsErr: Error | null = null;
  try {
    const form = new FormData();
    form.append("model", g.cartoonModel);
    form.append("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "photo.jpg");
    form.append("prompt", prompt);
    form.append("response_format", "b64_json");
    const res = await fetch(`${base}/images/edits`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return await parseImageResult(res);
  } catch (e) {
    editsErr = e as Error;
  }

  // 通道 2：images/generations + image URL（需要公网可访问的签名 URL）
  if (imageUrl) {
    try {
      const res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model: g.cartoonModel, prompt, image: imageUrl }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new AiError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      return await parseImageResult(res);
    } catch (e) {
      throw new AiError(`图像生成失败（edits: ${editsErr.message}；generations: ${(e as Error).message}）`);
    }
  }
  throw new AiError(`图像生成失败（images/edits: ${editsErr.message}；未配置公网访问地址，无法改用 URL 拉图通道）`);
}

async function parseImageResult(res: Response): Promise<Buffer> {
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = data.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, "base64");
  if (first?.url) {
    const imgRes = await fetch(first.url, { signal: AbortSignal.timeout(120_000) });
    if (!imgRes.ok) throw new AiError(`下载生成的图像失败: HTTP ${imgRes.status}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  throw new AiError("图像生成接口返回为空");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
