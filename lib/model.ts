import Holidays from "date-holidays";

export const SCHEMA_VERSION = 2;

export type WorkdayMode = "WEEKDAYS" | "SATURDAY" | "SUNDAY" | "EVERYDAY";
export type CarryMode = "DAILY" | "CARRY";
export type DinnerPolicy = "ALWAYS" | "CONDITIONAL" | "NONE";

export type Ruleset = {
  id: string;
  effectiveFrom: string;
  updatedAt: number;
  lunchBudget: number;
  dinnerBudget: number;
  workdayMode: WorkdayMode;
  lunchCarry: CarryMode;
  dinnerPolicy: DinnerPolicy;
  dinnerCarry: CarryMode;
  cycleDay: number;
  excludeKrPublicHolidays: boolean;
};

export type MealEntry = {
  date: string;
  lunch: number;
  dinner: number;
  dinnerEligible?: boolean;
  dayOverride?: "ON" | "OFF";
  updatedAt: number;
};

export type AppData = {
  schemaVersion: number;
  rulesets: Ruleset[];
  entries: Record<string, MealEntry>;
};

const legacyEffectiveFrom = "1970-01-01";

export const defaultRuleset = (): Ruleset => ({
  id: "default",
  effectiveFrom: legacyEffectiveFrom,
  updatedAt: 0,
  lunchBudget: 10_000,
  dinnerBudget: 15_000,
  workdayMode: "WEEKDAYS",
  lunchCarry: "DAILY",
  dinnerPolicy: "CONDITIONAL",
  dinnerCarry: "CARRY",
  cycleDay: 1,
  excludeKrPublicHolidays: false,
});

export const defaultData = (): AppData => ({
  schemaVersion: SCHEMA_VERSION,
  rulesets: [defaultRuleset()],
  entries: {},
});

const krHolidays = new Holidays("KR");

export function isKrPublicHoliday(date: Date) {
  const result = krHolidays.isHoliday(date);
  if (!result) return false;
  const holidays = Array.isArray(result) ? result : [result];
  return holidays.some((holiday) => holiday.type === "public" || holiday.type === "bank");
}

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
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cell += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  out.push(cell);
  return out;
};

export function serializeCsv(data: AppData) {
  const rows: unknown[][] = [
    ["# food-coster-schema", SCHEMA_VERSION],
    ["kind", "key", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    ...data.rulesets
      .slice()
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
      .map((rule) => [
        "rule",
        rule.id,
        rule.effectiveFrom,
        rule.lunchBudget,
        rule.dinnerBudget,
        rule.workdayMode,
        rule.lunchCarry,
        rule.dinnerPolicy,
        rule.dinnerCarry,
        rule.cycleDay,
        rule.excludeKrPublicHolidays ? 1 : 0,
        rule.updatedAt,
      ]),
    ...Object.values(data.entries)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((entry) => [
        "entry",
        entry.date,
        entry.lunch,
        entry.dinner,
        entry.dinnerEligible ? 1 : 0,
        entry.dayOverride ?? "",
        entry.updatedAt,
      ]),
  ];
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function parseLegacyV1(csv: string): AppData {
  const data = defaultData();
  const rule = defaultRuleset();
  const lines = csv.split(/\r?\n/).slice(2);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [kind, key, a, b, c, d] = parseCsvLine(line);
    if (kind === "rule") {
      if (key === "lunchBudget") rule.lunchBudget = Math.max(0, Number(a) || 0);
      if (key === "dinnerBudget") rule.dinnerBudget = Math.max(0, Number(a) || 0);
      if (key === "workdayMode" && ["WEEKDAYS", "SATURDAY", "SUNDAY", "EVERYDAY"].includes(a)) rule.workdayMode = a as WorkdayMode;
      if (key === "lunchCarry" && ["DAILY", "CARRY"].includes(a)) rule.lunchCarry = a as CarryMode;
      if (key === "dinnerPolicy" && ["ALWAYS", "CONDITIONAL", "NONE"].includes(a)) rule.dinnerPolicy = a as DinnerPolicy;
      if (key === "dinnerCarry" && ["DAILY", "CARRY"].includes(a)) rule.dinnerCarry = a as CarryMode;
      if (key === "cycleDay") rule.cycleDay = Math.min(31, Math.max(1, Number(a) || 1));
    }
    if (kind === "entry" && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
      data.entries[key] = {
        date: key,
        lunch: Math.max(0, Number(a) || 0),
        dinner: Math.max(0, Number(b) || 0),
        dinnerEligible: c === "1",
        dayOverride: d === "ON" || d === "OFF" ? d : undefined,
        updatedAt: 0,
      };
    }
  }
  data.rulesets = [rule];
  return data;
}

export function parseCsv(input: string): AppData {
  const csv = input.trim();
  if (!csv) return defaultData();
  const first = csv.split(/\r?\n/, 1)[0] ?? "";
  const version = first.startsWith("# food-coster-schema,") ? Number(first.split(",")[1]) : 0;
  if (!Number.isInteger(version) || version < 0) throw new Error("알 수 없는 데이터 스키마입니다.");
  if (version > SCHEMA_VERSION) throw new Error("현재 앱보다 새로운 데이터 형식입니다. 앱을 업데이트해 주세요.");
  if (version <= 1) {
    const legacy = version === 0 ? `# food-coster-schema,1\n${csv}` : csv;
    return parseLegacyV1(legacy);
  }

  const data = defaultData();
  data.rulesets = [];
  const lines = csv.split(/\r?\n/).slice(2);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const [kind, key] = cells;
    if (kind === "rule" && key) {
      const [, id, effectiveFrom, lunchBudget, dinnerBudget, workdayMode, lunchCarry, dinnerPolicy, dinnerCarry, cycleDay, excludeHoliday, updatedAt] = cells;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) continue;
      if (!["WEEKDAYS", "SATURDAY", "SUNDAY", "EVERYDAY"].includes(workdayMode)) continue;
      if (!["DAILY", "CARRY"].includes(lunchCarry) || !["DAILY", "CARRY"].includes(dinnerCarry)) continue;
      if (!["ALWAYS", "CONDITIONAL", "NONE"].includes(dinnerPolicy)) continue;
      data.rulesets.push({
        id,
        effectiveFrom,
        updatedAt: Math.max(0, Number(updatedAt) || 0),
        lunchBudget: Math.max(0, Number(lunchBudget) || 0),
        dinnerBudget: Math.max(0, Number(dinnerBudget) || 0),
        workdayMode: workdayMode as WorkdayMode,
        lunchCarry: lunchCarry as CarryMode,
        dinnerPolicy: dinnerPolicy as DinnerPolicy,
        dinnerCarry: dinnerCarry as CarryMode,
        cycleDay: Math.min(31, Math.max(1, Number(cycleDay) || 1)),
        excludeKrPublicHolidays: excludeHoliday === "1",
      });
    }
    if (kind === "entry" && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
      const [, date, lunch, dinner, dinnerEligibleValue, dayOverride, updatedAt] = cells;
      data.entries[date] = {
        date,
        lunch: Math.max(0, Number(lunch) || 0),
        dinner: Math.max(0, Number(dinner) || 0),
        dinnerEligible: dinnerEligibleValue === "1",
        dayOverride: dayOverride === "ON" || dayOverride === "OFF" ? dayOverride : undefined,
        updatedAt: Math.max(0, Number(updatedAt) || 0),
      };
    }
  }
  if (!data.rulesets.length) data.rulesets = [defaultRuleset()];
  data.schemaVersion = SCHEMA_VERSION;
  return data;
}

export const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const fromDateKey = (key: string) => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
};

const clampDay = (year: number, month: number, day: number) => Math.min(day, new Date(year, month + 1, 0).getDate());
const cycleDate = (year: number, month: number, day: number) => new Date(year, month, clampDay(year, month, day));

export function rulesForDate(data: AppData, date: Date | string) {
  const key = typeof date === "string" ? date : dateKey(date);
  return data.rulesets
    .filter((rule) => rule.effectiveFrom <= key)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0] ?? data.rulesets[0] ?? defaultRuleset();
}

export function cycleRange(target: Date, cycleDay: number) {
  const candidate = cycleDate(target.getFullYear(), target.getMonth(), cycleDay);
  const start = target >= candidate ? candidate : cycleDate(target.getFullYear(), target.getMonth() - 1, cycleDay);
  const next = cycleDate(start.getFullYear(), start.getMonth() + 1, cycleDay);
  const end = new Date(next);
  end.setDate(end.getDate() - 1);
  return { start, end };
}

export function cycleRangeForDate(data: AppData, target: Date) {
  const rule = rulesForDate(data, target);
  return cycleRange(target, rule.cycleDay);
}

export function nextCycleStart(data: AppData, target = new Date()) {
  const { end } = cycleRangeForDate(data, target);
  const next = new Date(end);
  next.setDate(next.getDate() + 1);
  return next;
}

export function isWorkday(date: Date, rules: Ruleset, entry?: MealEntry) {
  if (entry?.dayOverride === "ON") return true;
  if (entry?.dayOverride === "OFF") return false;
  const day = date.getDay();
  let included = false;
  if (rules.workdayMode === "EVERYDAY") included = true;
  else if (day >= 1 && day <= 5) included = true;
  else if (rules.workdayMode === "SATURDAY" && day === 6) included = true;
  else if (rules.workdayMode === "SUNDAY" && day === 0) included = true;
  if (!included) return false;
  if (rules.excludeKrPublicHolidays && isKrPublicHoliday(date)) return false;
  return true;
}

export function dinnerEligible(date: Date, data: AppData) {
  const key = dateKey(date);
  const rule = rulesForDate(data, key);
  const entry = data.entries[key];
  if (!isWorkday(date, rule, entry)) return false;
  if (rule.dinnerPolicy === "NONE") return false;
  if (rule.dinnerPolicy === "ALWAYS") return true;
  return !!entry?.dinnerEligible;
}

export function mealAllowance(data: AppData, date: Date) {
  const key = dateKey(date);
  const rule = rulesForDate(data, key);
  const entry = data.entries[key];
  const workday = isWorkday(date, rule, entry);
  return {
    rule,
    workday,
    lunch: workday ? rule.lunchBudget : 0,
    dinner: dinnerEligible(date, data) ? rule.dinnerBudget : 0,
  };
}

export function periodSummary(data: AppData, target = new Date()) {
  const { start, end } = cycleRangeForDate(data, target);
  const today = dateKey(target);
  const todayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999);
  let total = 0;
  let usedToDate = 0;
  let lunchAccrued = 0;
  let dinnerAccrued = 0;
  let lunchCarrySpent = 0;
  let dinnerCarrySpent = 0;
  let todayLunchAvailable = 0;
  let todayDinnerAvailable = 0;
  let futureAvailable = 0;
  let expired = 0;

  const cursor = new Date(start);
  while (cursor <= end) {
    const key = dateKey(cursor);
    const entry = data.entries[key];
    const { rule, lunch: lunchAllowance, dinner: dinnerAllowance } = mealAllowance(data, cursor);
    const lunchSpent = entry?.lunch ?? 0;
    const dinnerSpent = entry?.dinner ?? 0;
    total += lunchAllowance + dinnerAllowance;

    if (cursor <= todayEnd) {
      usedToDate += lunchSpent + dinnerSpent;
      if (rule.lunchCarry === "CARRY") {
        lunchAccrued += lunchAllowance;
        lunchCarrySpent += lunchSpent;
      } else if (key === today) {
        todayLunchAvailable = Math.max(0, lunchAllowance - lunchSpent);
      } else {
        expired += Math.max(0, lunchAllowance - Math.min(lunchAllowance, lunchSpent));
      }

      if (rule.dinnerCarry === "CARRY") {
        dinnerAccrued += dinnerAllowance;
        dinnerCarrySpent += dinnerSpent;
      } else if (key === today) {
        todayDinnerAvailable = Math.max(0, dinnerAllowance - dinnerSpent);
      } else {
        expired += Math.max(0, dinnerAllowance - Math.min(dinnerAllowance, dinnerSpent));
      }
    } else {
      futureAvailable += Math.max(0, lunchAllowance - lunchSpent) + Math.max(0, dinnerAllowance - dinnerSpent);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const activeRule = rulesForDate(data, target);
  const lunchAvailableNow = activeRule.lunchCarry === "CARRY" ? Math.max(0, lunchAccrued - lunchCarrySpent) : todayLunchAvailable;
  const dinnerAvailableNow = activeRule.dinnerCarry === "CARRY" ? Math.max(0, dinnerAccrued - dinnerCarrySpent) : todayDinnerAvailable;
  const availableNow = lunchAvailableNow + dinnerAvailableNow;

  return {
    start,
    end,
    total,
    usedToDate,
    expired,
    lunchAvailableNow,
    dinnerAvailableNow,
    availableNow,
    futureAvailable: availableNow + futureAvailable,
  };
}

export function createRulesetRevision(base: Ruleset, effectiveFrom: string, now = Date.now()): Ruleset {
  return {
    ...base,
    id: `${effectiveFrom}-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
    effectiveFrom,
    updatedAt: now,
  };
}
