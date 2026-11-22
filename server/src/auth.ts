import crypto from "node:crypto";
import { db, getSyncState, setSyncState } from "./db.js";

/**
 * 用户登录鉴权：用户存 users 表（scrypt 加盐哈希），登录成功后签发
 * HMAC 签名会话 cookie（httpOnly，30 天有效，token 内含用户 id 与用户名）。
 * 只要存在用户就强制登录；没有任何用户时（首次使用）全部放行，
 * 在设置页创建第一个用户后立即进入需要登录的状态。
 */

const SESSION_COOKIE = "aaf_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SECRET_KEY = "authSecret";

function secret(): string {
  let s = getSyncState(SECRET_KEY);
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    setSyncState(SECRET_KEY, s);
  }
  return s;
}

export interface UserRow {
  id: number;
  username: string;
  passHash: string;
  createdAt: string;
}

export function listUsers(): Array<{ id: number; username: string; createdAt: string }> {
  return db
    .prepare("SELECT id, username, createdAt FROM users ORDER BY id")
    .all() as Array<{ id: number; username: string; createdAt: string }>;
}

export function userCount(): number {
  return (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
}

/** 是否需要登录：存在任一用户即强制登录 */
export function authRequired(): boolean {
  return userCount() > 0;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** 创建用户；用户名重复或密码为空返回错误信息 */
export function createUser(username: string, password: string): { error?: string } {
  const name = username.trim();
  if (!name) return { error: "用户名不能为空" };
  if (name.length > 64) return { error: "用户名过长" };
  if (!password) return { error: "密码不能为空" };
  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(name);
  if (exists) return { error: "用户名已存在" };
  db.prepare("INSERT INTO users (username, passHash) VALUES (?, ?)").run(name, hashPassword(password));
  return {};
}

/** 删除用户；不允许删除最后一个用户 */
export function deleteUser(id: number): { error?: string } {
  if (userCount() <= 1) return { error: "至少保留一个用户" };
  const r = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return r.changes > 0 ? {} : { error: "用户不存在" };
}

/** 校验用户名密码，成功返回用户行 */
export function authenticate(username: string, password: string): UserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | UserRow
    | undefined;
  if (!row || !verifyPassword(password, row.passHash)) return null;
  return row;
}

/** 修改自己的密码 */
export function changePassword(userId: number, password: string): { error?: string } {
  if (!password) return { error: "密码不能为空" };
  db.prepare("UPDATE users SET passHash = ? WHERE id = ?").run(hashPassword(password), userId);
  return {};
}

function signPayload(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("hex");
}

export interface Session {
  userId: number;
  username: string;
}

/** 签发会话 token（userId.username.exp.sig）与 cookie 有效期 */
export function issueSession(user: UserRow): { token: string; maxAgeSec: number } {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${user.id}.${user.username}.${exp}`;
  return { token: `${payload}.${signPayload(payload)}`, maxAgeSec: SESSION_TTL_MS / 1000 };
}

export function verifySession(token: string | undefined): Session | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userIdStr, username, expStr, sig] = parts as [string, string, string, string];
  const expNum = Number(expStr);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return null;
  const payload = `${userIdStr}.${username}.${expStr}`;
  const expected = Buffer.from(signPayload(payload));
  const actual = Buffer.from(sig);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  const userId = Number(userIdStr);
  if (!Number.isInteger(userId)) return null;
  // 用户被删除后其会话立即失效
  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  return exists ? { userId, username } : null;
}

/** 从请求头里取会话 cookie（无 cookie-parser 依赖） */
export function sessionFromCookieHeader(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const kv = part.trim();
    const eq = kv.indexOf("=");
    if (eq > 0 && kv.slice(0, eq) === SESSION_COOKIE) return decodeURIComponent(kv.slice(eq + 1));
  }
  return undefined;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
