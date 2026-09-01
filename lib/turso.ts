type Arg = string | number | null;
type Wire = { type: "null" } | { type: "integer" | "float" | "text"; value: string };
type Result = { cols: { name: string }[]; rows: Wire[][]; affected_row_count: number };

const env = (name: "TURSO_DATABASE_URL" | "TURSO_AUTH_TOKEN") => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}이 설정되지 않았습니다.`);
  return value;
};

const url = () => {
  const value = env("TURSO_DATABASE_URL").replace(/^(?:libsql|turso):\/\//i, "https://");
  const parsed = new URL(value); parsed.pathname = "/v2/pipeline"; parsed.search = ""; parsed.hash = ""; return parsed.toString();
};
const wire = (v: Arg): Wire => v === null ? { type: "null" } : typeof v === "string" ? { type: "text", value: v } : { type: Number.isSafeInteger(v) ? "integer" : "float", value: String(v) };
const decode = (v: Wire | undefined) => !v || v.type === "null" ? null : v.type === "text" ? v.value : Number(v.value);

export async function execute(sql: string, args: Arg[] = []) {
  const response = await fetch(url(), { method: "POST", headers: { authorization: `Bearer ${env("TURSO_AUTH_TOKEN")}`, "content-type": "application/json" }, body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args: args.map(wire) } }, { type: "close" }] }), cache: "no-store" });
  const payload = await response.json() as { results?: Array<{ type: "ok"; response: { type: "execute"; result: Result } } | { type: "error"; error?: { message?: string } }> };
  if (!response.ok) throw new Error(`Turso 요청 실패 (${response.status})`);
  const item = payload.results?.[0];
  if (!item || item.type === "error") throw new Error(item && "error" in item ? item.error?.message || "Turso query failed" : "Turso 응답 오류");
  if (item.response.type !== "execute") throw new Error("Turso 실행 결과가 없습니다.");
  return item.response.result;
}

export const rows = (result: Result) => result.rows.map(row => Object.fromEntries(result.cols.map((col,i) => [col.name, decode(row[i])])) as Record<string,string|number|null>);

let ready: Promise<void> | null = null;
export function ensureSchema() {
  if (!ready) ready = execute(`CREATE TABLE IF NOT EXISTS food_coster_users (username TEXT PRIMARY KEY NOT NULL, verifier_hash TEXT NOT NULL, vault TEXT NOT NULL, updated_at INTEGER NOT NULL)`).then(() => undefined).catch(e => { ready = null; throw e; });
  return ready;
}
