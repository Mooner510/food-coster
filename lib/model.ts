export const SCHEMA_VERSION = 1;

export type WorkdayMode = "WEEKDAYS" | "SATURDAY" | "SUNDAY" | "EVERYDAY";
export type CarryMode = "DAILY" | "CARRY";
export type DinnerPolicy = "ALWAYS" | "CONDITIONAL" | "NONE";

export type Ruleset = {
  lunchBudget: number;
  dinnerBudget: number;
  workdayMode: WorkdayMode;
  lunchCarry: CarryMode;
  dinnerPolicy: DinnerPolicy;
  dinnerCarry: CarryMode;
  cycleDay: number;
};

export type MealEntry = {
  date: string;
  lunch: number;
  dinner: number;
  dinnerEligible?: boolean;
  dayOverride?: "ON" | "OFF";
};

export type AppData = {
  schemaVersion: number;
  rules: Ruleset;
  entries: Record<string, MealEntry>;
};

export const defaultData = (): AppData => ({
  schemaVersion: SCHEMA_VERSION,
  rules: {
    lunchBudget: 10000,
    dinnerBudget: 15000,
    workdayMode: "WEEKDAYS",
    lunchCarry: "DAILY",
    dinnerPolicy: "CONDITIONAL",
    dinnerCarry: "CARRY",
    cycleDay: 1,
  },
  entries: {},
});

const csvEscape = (value: unknown) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const parseCsvLine = (line: string) => {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cell); cell = ""; continue; }
    cell += ch;
  }
  out.push(cell);
  return out;
};

export function serializeCsv(data: AppData) {
  const rows = [
    [`# food-coster-schema`, String(SCHEMA_VERSION)],
    ["kind", "key", "a", "b", "c", "d"],
    ["rule", "lunchBudget", String(data.rules.lunchBudget)],
    ["rule", "dinnerBudget", String(data.rules.dinnerBudget)],
    ["rule", "workdayMode", data.rules.workdayMode],
    ["rule", "lunchCarry", data.rules.lunchCarry],
    ["rule", "dinnerPolicy", data.rules.dinnerPolicy],
    ["rule", "dinnerCarry", data.rules.dinnerCarry],
    ["rule", "cycleDay", String(data.rules.cycleDay)],
    ...Object.values(data.entries).sort((a,b) => a.date.localeCompare(b.date)).map(e => ["entry", e.date, String(e.lunch), String(e.dinner), e.dinnerEligible ? "1" : "0", e.dayOverride ?? ""]),
  ];
  return rows.map(row => row.map(csvEscape).join(",")).join("\n");
}

function migrateV0(csv: string) {
  const lines = csv.trim().split(/\r?\n/);
  return [`# food-coster-schema,1`, ...lines.filter(line => !line.startsWith("# food-coster-schema"))].join("\n");
}

export function migrateCsvToLatest(input: string) {
  let csv = input.trim();
  const first = csv.split(/\r?\n/, 1)[0] ?? "";
  let version = first.startsWith("# food-coster-schema,") ? Number(first.split(",")[1]) : 0;
  if (!Number.isInteger(version) || version < 0) throw new Error("알 수 없는 데이터 스키마입니다.");
  if (version > SCHEMA_VERSION) throw new Error("현재 앱보다 새로운 데이터 형식입니다. 앱을 업데이트해 주세요.");
  while (version < SCHEMA_VERSION) {
    if (version === 0) csv = migrateV0(csv);
    else throw new Error(`스키마 ${version} 마이그레이션이 없습니다.`);
    version++;
  }
  return csv;
}

export function parseCsv(input: string): AppData {
  const csv = migrateCsvToLatest(input);
  const data = defaultData();
  const lines = csv.split(/\r?\n/).slice(2);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [kind, key, a, b, c, d] = parseCsvLine(line);
    if (kind === "rule") {
      if (key === "lunchBudget") data.rules.lunchBudget = Math.max(0, Number(a) || 0);
      if (key === "dinnerBudget") data.rules.dinnerBudget = Math.max(0, Number(a) || 0);
      if (key === "workdayMode" && ["WEEKDAYS","SATURDAY","SUNDAY","EVERYDAY"].includes(a)) data.rules.workdayMode = a as WorkdayMode;
      if (key === "lunchCarry" && ["DAILY","CARRY"].includes(a)) data.rules.lunchCarry = a as CarryMode;
      if (key === "dinnerPolicy" && ["ALWAYS","CONDITIONAL","NONE"].includes(a)) data.rules.dinnerPolicy = a as DinnerPolicy;
      if (key === "dinnerCarry" && ["DAILY","CARRY"].includes(a)) data.rules.dinnerCarry = a as CarryMode;
      if (key === "cycleDay") data.rules.cycleDay = Math.min(31, Math.max(1, Number(a) || 1));
    }
    if (kind === "entry" && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
      data.entries[key] = { date: key, lunch: Math.max(0, Number(a) || 0), dinner: Math.max(0, Number(b) || 0), dinnerEligible: c === "1", dayOverride: d === "ON" || d === "OFF" ? d : undefined };
    }
  }
  return data;
}

export const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
export const fromDateKey = (key: string) => { const [y,m,d] = key.split("-").map(Number); return new Date(y,m-1,d); };
const clampDay = (year: number, month: number, day: number) => Math.min(day, new Date(year, month + 1, 0).getDate());
const cycleDate = (year: number, month: number, day: number) => new Date(year, month, clampDay(year, month, day));

export function cycleRange(target: Date, cycleDay: number) {
  const candidate = cycleDate(target.getFullYear(), target.getMonth(), cycleDay);
  const start = target >= candidate ? candidate : cycleDate(target.getFullYear(), target.getMonth()-1, cycleDay);
  const next = cycleDate(start.getFullYear(), start.getMonth()+1, cycleDay);
  const end = new Date(next); end.setDate(end.getDate()-1);
  return { start, end };
}

export function isWorkday(date: Date, rules: Ruleset, entry?: MealEntry) {
  if (entry?.dayOverride === "ON") return true;
  if (entry?.dayOverride === "OFF") return false;
  const day = date.getDay();
  if (rules.workdayMode === "EVERYDAY") return true;
  if (day >= 1 && day <= 5) return true;
  if (rules.workdayMode === "SATURDAY") return day === 6;
  if (rules.workdayMode === "SUNDAY") return day === 0;
  return false;
}

export function dinnerEligible(date: Date, data: AppData) {
  const entry = data.entries[dateKey(date)];
  if (!isWorkday(date, data.rules, entry)) return false;
  if (data.rules.dinnerPolicy === "NONE") return false;
  if (data.rules.dinnerPolicy === "ALWAYS") return true;
  return !!entry?.dinnerEligible;
}

export function periodSummary(data: AppData, target = new Date()) {
  const { start, end } = cycleRange(target, data.rules.cycleDay);
  const today = dateKey(target);
  const todayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999);
  let total = 0;
  let used = 0;
  let lunchAccrued = 0;
  let dinnerAccrued = 0;
  let lunchCarrySpent = 0;
  let dinnerCarrySpent = 0;
  let todayLunchAvailable = 0;
  let todayDinnerAvailable = 0;

  const cursor = new Date(start);
  while (cursor <= end) {
    const key = dateKey(cursor);
    const entry = data.entries[key];
    const lunchAllowance = isWorkday(cursor, data.rules, entry) ? data.rules.lunchBudget : 0;
    const dinnerAllowance = dinnerEligible(cursor, data) ? data.rules.dinnerBudget : 0;
    const lunchSpent = entry?.lunch ?? 0;
    const dinnerSpent = entry?.dinner ?? 0;

    total += lunchAllowance + dinnerAllowance;
    used += lunchSpent + dinnerSpent;

    if (cursor <= todayEnd) {
      if (data.rules.lunchCarry === "CARRY") {
        lunchAccrued += lunchAllowance;
        lunchCarrySpent += lunchSpent;
      } else if (key === today) {
        todayLunchAvailable = Math.max(0, lunchAllowance - lunchSpent);
      }

      if (data.rules.dinnerCarry === "CARRY") {
        dinnerAccrued += dinnerAllowance;
        dinnerCarrySpent += dinnerSpent;
      } else if (key === today) {
        todayDinnerAvailable = Math.max(0, dinnerAllowance - dinnerSpent);
      }
    }

    cursor.setDate(cursor.getDate()+1);
  }

  const lunchAvailable = data.rules.lunchCarry === "CARRY" ? Math.max(0, lunchAccrued - lunchCarrySpent) : todayLunchAvailable;
  const dinnerAvailable = data.rules.dinnerCarry === "CARRY" ? Math.max(0, dinnerAccrued - dinnerCarrySpent) : todayDinnerAvailable;

  return {
    start,
    end,
    total,
    used,
    remaining: Math.max(0, total-used),
    availableNow: lunchAvailable + dinnerAvailable,
  };
}
