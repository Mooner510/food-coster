import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, execute, rows } from "@/lib/turso";

export const runtime = "nodejs";

const SESSION_COOKIE = "food-coster-session";
const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

const normalize = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const validUser = (value: string) => /^[a-z0-9._-]{3,32}$/.test(value);
const validVerifier = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validVault = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2_000_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => {
  try { return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
  catch { return false; }
};

type AuthSession = {
  username: string;
  token: string;
  refreshCookie: boolean;
};

async function user(username: string) {
  const result = await execute("SELECT username, verifier_hash, vault, revision, updated_at FROM food_coster_users WHERE username = ? LIMIT 1", [username]);
  return rows(result)[0] ?? null;
}

function requestIp(request: Request) {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 96);
}

function originAllowed(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

async function checkRateLimit(key: string, maxAttempts: number, windowMs: number) {
  const now = Date.now();
  const current = rows(await execute("SELECT attempts, reset_at FROM food_coster_rate_limits WHERE rate_key = ? LIMIT 1", [key]))[0];
  const resetAt = Number(current?.reset_at ?? 0);
  const attempts = Number(current?.attempts ?? 0);
  if (resetAt > now && attempts >= maxAttempts) return { allowed: false, retryAfter: Math.ceil((resetAt - now) / 1000) };
  if (resetAt <= now) {
    await execute("INSERT INTO food_coster_rate_limits (rate_key, attempts, reset_at) VALUES (?, 1, ?) ON CONFLICT(rate_key) DO UPDATE SET attempts = 1, reset_at = excluded.reset_at", [key, now + windowMs]);
    return { allowed: true, retryAfter: 0 };
  }
  await execute("UPDATE food_coster_rate_limits SET attempts = attempts + 1 WHERE rate_key = ?", [key]);
  return { allowed: true, retryAfter: 0 };
}

async function clearRateLimit(key: string) {
  await execute("DELETE FROM food_coster_rate_limits WHERE rate_key = ?", [key]).catch(() => undefined);
}

function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

function clearSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

function json(data: Record<string, unknown>, status = 200, auth?: AuthSession | null) {
  const response = NextResponse.json(data, { status });
  if (auth?.refreshCookie) setSessionCookie(response, auth.token);
  return response;
}

async function createSession(username: string): Promise<AuthSession> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await execute("DELETE FROM food_coster_sessions WHERE expires_at <= ?", [now]).catch(() => undefined);
  await execute(
    "INSERT INTO food_coster_sessions (token_hash, username, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [hash(token), username, now, now, now + SESSION_TTL_MS],
  );
  return { username, token, refreshCookie: true };
}

async function cookieSession(request: NextRequest): Promise<AuthSession | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const now = Date.now();
  const row = rows(await execute(
    `SELECT s.username, s.last_seen_at, s.expires_at
     FROM food_coster_sessions s
     INNER JOIN food_coster_users u ON u.username = s.username
     WHERE s.token_hash = ? LIMIT 1`,
    [hash(token)],
  ))[0];
  if (!row) return null;

  const expiresAt = Number(row.expires_at ?? 0);
  if (expiresAt <= now) {
    await execute("DELETE FROM food_coster_sessions WHERE token_hash = ?", [hash(token)]).catch(() => undefined);
    return null;
  }

  const username = String(row.username ?? "");
  const lastSeenAt = Number(row.last_seen_at ?? 0);
  const shouldRefresh = now - lastSeenAt >= SESSION_REFRESH_MS;
  if (shouldRefresh) {
    await execute(
      "UPDATE food_coster_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
      [now, now + SESSION_TTL_MS, hash(token)],
    );
  }
  return { username, token, refreshCookie: shouldRefresh };
}

async function authenticate(request: NextRequest, body: Record<string, unknown>): Promise<AuthSession | null> {
  const session = await cookieSession(request);
  if (session) return session;

  // One-release compatibility path for an already-open older client. A valid
  // legacy verifier immediately upgrades itself to a cookie session.
  const username = normalize(body.username);
  if (!validUser(username) || !validVerifier(body.verifier)) return null;
  const existing = await user(username);
  if (!existing || typeof existing.verifier_hash !== "string" || !same(existing.verifier_hash, hash(body.verifier))) return null;
  return createSession(username);
}

async function conflict(username: string, auth: AuthSession) {
  const latest = await user(username);
  return json({
    error: "다른 기기에서 더 최신 데이터가 저장되었습니다.",
    conflict: true,
    vault: latest?.vault,
    revision: Number(latest?.revision ?? 1),
    updatedAt: latest?.updated_at,
  }, 409, auth);
}

export async function POST(request: NextRequest) {
  try {
    if (!originAllowed(request)) return NextResponse.json({ error: "허용되지 않은 요청입니다." }, { status: 403 });
    await ensureSchema();
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;

    if (action === "logout") {
      const token = request.cookies.get(SESSION_COOKIE)?.value ?? "";
      if (token) await execute("DELETE FROM food_coster_sessions WHERE token_hash = ?", [hash(token)]).catch(() => undefined);
      const response = NextResponse.json({ loggedOut: true });
      clearSessionCookie(response);
      return response;
    }

    if (action === "register" || action === "login") {
      const username = normalize(body.username);
      const verifier = body.verifier;
      if (!validUser(username)) return NextResponse.json({ error: "사용자명은 영문 소문자, 숫자, ., _, - 조합 3~32자로 입력해 주세요." }, { status: 400 });
      if (!validVerifier(verifier)) return NextResponse.json({ error: "인증 정보가 올바르지 않습니다." }, { status: 400 });

      const rateKey = `${requestIp(request)}:${username}`;
      const limit = await checkRateLimit(rateKey, 20, 15 * 60_000);
      if (!limit.allowed) return NextResponse.json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." }, { status: 429, headers: { "retry-after": String(limit.retryAfter) } });

      const existing = await user(username);
      if (action === "register") {
        if (existing) return NextResponse.json({ error: "이미 사용 중인 사용자명입니다." }, { status: 409 });
        if (!validVault(body.vault)) return NextResponse.json({ error: "저장 데이터가 올바르지 않습니다." }, { status: 400 });
        const now = Date.now();
        await execute("INSERT INTO food_coster_users (username, verifier_hash, vault, revision, updated_at) VALUES (?, ?, ?, 1, ?)", [username, hash(verifier), body.vault, now]);
        const auth = await createSession(username);
        await clearRateLimit(rateKey);
        return json({ vault: body.vault, revision: 1, updatedAt: now }, 200, auth);
      }

      if (!existing || typeof existing.verifier_hash !== "string" || !same(existing.verifier_hash, hash(verifier))) {
        return NextResponse.json({ error: "사용자명 또는 암호가 올바르지 않습니다." }, { status: 401 });
      }
      const auth = await createSession(username);
      await clearRateLimit(rateKey);
      return json({ vault: existing.vault, revision: Math.max(1, Number(existing.revision ?? 1)), updatedAt: existing.updated_at }, 200, auth);
    }

    const auth = await authenticate(request, body);
    if (!auth) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const username = auth.username;
    const existing = await user(username);
    if (!existing) return NextResponse.json({ error: "계정을 찾을 수 없습니다." }, { status: 401 });
    const revision = Math.max(1, Number(existing.revision ?? 1));

    if (action === "resume" || action === "pull") {
      return json({ vault: existing.vault, revision, updatedAt: existing.updated_at }, 200, auth);
    }

    if (action === "push") {
      if (!validVault(body.vault)) return json({ error: "저장 데이터가 올바르지 않습니다." }, 400, auth);
      const baseRevision = Math.max(0, Number(body.baseRevision ?? 0));
      if (baseRevision !== revision) return conflict(username, auth);
      const now = Date.now();
      const nextRevision = revision + 1;
      const result = await execute("UPDATE food_coster_users SET vault = ?, revision = ?, updated_at = ? WHERE username = ? AND revision = ?", [body.vault, nextRevision, now, username, revision]);
      if (result.affected_row_count !== 1) return conflict(username, auth);
      return json({ vault: body.vault, revision: nextRevision, updatedAt: now }, 200, auth);
    }

    if (action === "change_credentials") {
      if (!validVerifier(body.newVerifier) || !validVault(body.vault)) return json({ error: "새 인증 정보가 올바르지 않습니다." }, 400, auth);
      const baseRevision = Math.max(0, Number(body.baseRevision ?? 0));
      if (baseRevision !== revision) return conflict(username, auth);
      const now = Date.now();
      const nextRevision = revision + 1;
      const result = await execute("UPDATE food_coster_users SET verifier_hash = ?, vault = ?, revision = ?, updated_at = ? WHERE username = ? AND revision = ?", [hash(body.newVerifier), body.vault, nextRevision, now, username, revision]);
      if (result.affected_row_count !== 1) return conflict(username, auth);

      await execute("DELETE FROM food_coster_sessions WHERE username = ?", [username]);
      const replacement = await createSession(username);
      return json({ revision: nextRevision, updatedAt: now }, 200, replacement);
    }

    if (action === "delete") {
      await execute("DELETE FROM food_coster_sessions WHERE username = ?", [username]);
      await execute("DELETE FROM food_coster_users WHERE username = ?", [username]);
      const response = NextResponse.json({ deleted: true });
      clearSessionCookie(response);
      return response;
    }

    return json({ error: "지원하지 않는 요청입니다." }, 400, auth);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "저장소 연결에 실패했습니다." }, { status: 500 });
  }
}
