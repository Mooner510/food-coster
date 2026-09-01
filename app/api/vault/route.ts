import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureSchema, execute, rows } from "@/lib/turso";

export const runtime = "nodejs";

const normalize = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const validUser = (v: string) => /^[a-z0-9._-]{3,32}$/.test(v);
const validVerifier = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const same = (a: string, b: string) => { try { return timingSafeEqual(Buffer.from(a,"hex"), Buffer.from(b,"hex")); } catch { return false; } };

async function user(username: string) {
  const result = await execute("SELECT username, verifier_hash, vault, updated_at FROM food_coster_users WHERE username = ? LIMIT 1", [username]);
  return rows(result)[0] ?? null;
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
    const existing = await user(username);

    if (action === "register") {
      if (existing) return NextResponse.json({ error: "이미 사용 중인 사용자명입니다." }, { status: 409 });
      if (typeof body.vault !== "string" || body.vault.length > 2_000_000) return NextResponse.json({ error: "저장 데이터가 올바르지 않습니다." }, { status: 400 });
      const now = Date.now();
      await execute("INSERT INTO food_coster_users (username, verifier_hash, vault, updated_at) VALUES (?, ?, ?, ?)", [username, hash(verifier), body.vault, now]);
      return NextResponse.json({ vault: body.vault, updatedAt: now });
    }

    if (!existing || typeof existing.verifier_hash !== "string" || !same(existing.verifier_hash, hash(verifier))) return NextResponse.json({ error: "사용자명 또는 암호가 올바르지 않습니다." }, { status: 401 });
    if (action === "pull" || action === "login") return NextResponse.json({ vault: existing.vault, updatedAt: existing.updated_at });
    if (action === "push") {
      if (typeof body.vault !== "string" || body.vault.length > 2_000_000) return NextResponse.json({ error: "저장 데이터가 올바르지 않습니다." }, { status: 400 });
      const clientUpdatedAt = typeof body.baseUpdatedAt === "number" ? body.baseUpdatedAt : 0;
      const serverUpdatedAt = Number(existing.updated_at ?? 0);
      if (clientUpdatedAt && serverUpdatedAt > clientUpdatedAt) return NextResponse.json({ error: "다른 기기에서 더 최신 데이터가 저장되었습니다.", conflict: true, vault: existing.vault, updatedAt: serverUpdatedAt }, { status: 409 });
      const now = Date.now();
      await execute("UPDATE food_coster_users SET vault = ?, updated_at = ? WHERE username = ?", [body.vault, now, username]);
      return NextResponse.json({ vault: body.vault, updatedAt: now });
    }
    return NextResponse.json({ error: "지원하지 않는 요청입니다." }, { status: 400 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "저장소 연결에 실패했습니다." }, { status: 500 });
  }
}
