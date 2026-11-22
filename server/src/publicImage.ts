import crypto from "node:crypto";
import { getSyncState, setSyncState } from "./db.js";
import type { Settings } from "./config.js";

/**
 * 公网临时签名图片 URL：部分图像提供方（如阿里云 MaaS 兼容网关）的图像编辑
 * 只接受 HTTP(S) 图片地址、不支持上传，需要一个公网可拉取的临时 URL。
 * 签名 = HMAC-SHA256(secret, "<photoId>:<exp>")，secret 为本地随机生成并存 sync_state，
 * URL 默认 30 分钟有效，过期即失效。
 */

const SECRET_KEY = "publicImageSecret";
const URL_TTL_MS = 30 * 60 * 1000;

function secret(): string {
  let s = getSyncState(SECRET_KEY);
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    setSyncState(SECRET_KEY, s);
  }
  return s;
}

function sign(photoId: number, exp: number): string {
  return crypto.createHmac("sha256", secret()).update(`${photoId}:${exp}`).digest("hex");
}

/** 生成漫画化用的公网临时图片 URL；未配置 publicBaseUrl 时返回 null */
export function signPublicImageUrl(settings: Settings, photoId: number): string | null {
  const base = settings.publicBaseUrl.replace(/\/+$/, "");
  if (!base) return null;
  const exp = Date.now() + URL_TTL_MS;
  return `${base}/api/public/image/${photoId}?exp=${exp}&sig=${sign(photoId, exp)}`;
}

/** 校验公网临时图片 URL 的签名与有效期 */
export function verifyPublicImageUrl(photoId: number, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(photoId, exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
