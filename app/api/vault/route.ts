import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureSchema, execute, rows } from "@/lib/turso";

export const runtime = "nodejs";

const normalize = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const validUser = (value: string) => /^[a-z0-9._-]{3,32}$/.test(value);
const validVerifier = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validVault = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2_000_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => {
  try { return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
  catch { return false; }
};

async function user(username: string) {
  const result = await execute("SELECT username, verifier_hash, vault, revision, updated_at FROM food_coster_users WHERE username = ? LIMIT 1", [username]);
  return rows(result)[0] ?? null;
}

function requestIp(request: Request) {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 96);
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

async function conflict(username: string) {
  const latest = await user(username);
  return NextResponse.json({
    error: "다른 기기에서 더 최신 데이터가 저장되었습니다.",
    conflict: true,
    vault: latest?.vault,
    revision: Number(latest?.revision ?? 1),
    updatedAt: latest?.updated_at,
  }, { status: 409 });
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;
    const username = normalize(body.username);
    const verifier = body.verifier;
    if (!validUser(username)) return NextResponse.json({ error: "사용자명은 영문 소문자, 숫자, ., _, - 조합 3~32자로 입력해 주세요." }, { status: 400 });
    if (!validVerifier(verifier)) return NextResponse.json({ error: "인증 정보가 올바르지 않습니다." }, { status: 400 });

    const ip = requestIp(request);
    const rateKey = `${ip}:${username}`;
    if (action === "login" || action === "pull" || action === "push" || action === "change_credentials" || action === "delete") {
      const limit = await checkRateLimit(rateKey, 20, 15 * 60_000);
      if (!limit.allowed) return NextResponse.json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." }, { status: 429, headers: { "retry-after": String(limit.retryAfter) } });
    }

    const existing = await user(username);

    if (action === "register") {
      if (existing) return NextResponse.json({ error: "이미 사용 중인 사용자명입니다." }, { status: 409 });
      if (!validVault(body.vault)) return NextResponse.json({ error: "저장 데이터가 올바르지 않습니다." }, { status: 400 });
      const now = Date.now();
      await execute("INSERT INTO food_coster_users (username, verifier_hash, vault, revision, updated_at) VALUES (?, ?, ?, 1, ?)", [username, hash(verifier), body.vault, now]);
      return NextResponse.json({ vault: body.vault, revision: 1, updatedAt: now });
    }

    if (!existing || typeof existing.verifier_hash !== "string" || !same(existing.verifier_hash, hash(verifier))) {
      return NextResponse.json({ error: "사용자명 또는 암호가 올바르지 않습니다." }, { status: 401 });
    }
    await clearRateLimit(rateKey);

    const revision = Math.max(1, Number(existing.revision ?? 1));
    if (action === "pull" || action === "login") {
      return NextResponse.json({ vault: existing.vault, revision, updatedAt: existing.updated_at });
    }

    if (action === "push") {
      if (!validVault(body.vault)) return NextResponse.json({ error: "저장 데이터가 올바르지 않습니다." }, { status: 400 });
      const baseRevision = Math.max(0, Number(body.baseRevision ?? 0));
      if (baseRevision !== revision) return conflict(username);
      const now = Date.now();
      const nextRevision = revision + 1;
      const result = await execute("UPDATE food_coster_users SET vault = ?, revision = ?, updated_at = ? WHERE username = ? AND revision = ?", [body.vault, nextRevision, now, username, revision]);
      if (result.affected_row_count !== 1) return conflict(username);
      return NextResponse.json({ vault: body.vault, revision: nextRevision, updatedAt: now });
    }

    if (action === "change_credentials") {
      if (!validVerifier(body.newVerifier) || !validVault(body.vault)) return NextResponse.json({ error: "새 인증 정보가 올바르지 않습니다." }, { status: 400 });
      const baseRevision = Math.max(0, Number(body.baseRevision ?? 0));
      if (baseRevision !== revision) return conflict(username);
      const now = Date.now();
      const nextRevision = revision + 1;
      const result = await execute("UPDATE food_coster_users SET verifier_hash = ?, vault = ?, revision = ?, updated_at = ? WHERE username = ? AND revision = ?", [hash(body.newVerifier), body.vault, nextRevision, now, username, revision]);
      if (result.affected_row_count !== 1) return conflict(username);
      return NextResponse.json({ revision: nextRevision, updatedAt: now });
    }

    if (action === "delete") {
      await execute("DELETE FROM food_coster_users WHERE username = ?", [username]);
      await clearRateLimit(rateKey);
      return NextResponse.json({ deleted: true });
    }

    return NextResponse.json({ error: "지원하지 않는 요청입니다." }, { status: 400 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "저장소 연결에 실패했습니다." }, { status: 500 });
  }
}
