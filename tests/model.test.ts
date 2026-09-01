import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleRange,
  dateKey,
  defaultData,
  isWorkday,
  parseCsv,
  periodSummary,
  rulesForDate,
  serializeCsv,
  type AppData,
} from "../lib/model";

const at = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12);

test("31일 기준일은 짧은 달의 말일로 보정한다", () => {
  const range = cycleRange(at(2026, 3, 15), 31);
  assert.equal(dateKey(range.start), "2026-02-28");
  assert.equal(dateKey(range.end), "2026-03-30");
});

test("윤년 2월도 기준일을 올바르게 계산한다", () => {
  const range = cycleRange(at(2028, 2, 29), 31);
  assert.equal(dateKey(range.start), "2028-02-29");
  assert.equal(dateKey(range.end), "2028-03-30");
});

test("토요일 포함은 평일과 토요일만 포함한다", () => {
  const data = defaultData();
  const rule = { ...data.rulesets[0], workdayMode: "SATURDAY" as const };
  assert.equal(isWorkday(at(2026, 9, 5), rule), true);
  assert.equal(isWorkday(at(2026, 9, 6), rule), false);
  assert.equal(isWorkday(at(2026, 9, 7), rule), true);
});

test("당일 소멸 식대는 과거 미사용분을 현재 사용 가능액에 포함하지 않는다", () => {
  const data = defaultData();
  data.rulesets[0] = { ...data.rulesets[0], lunchBudget: 10_000, dinnerPolicy: "NONE", lunchCarry: "DAILY", cycleDay: 1 };
  const summary = periodSummary(data, at(2026, 9, 3));
  assert.equal(summary.lunchAvailableNow, 10_000);
  assert.equal(summary.expired, 20_000);
});

test("누계 식대는 사용하지 않은 과거 식대를 현재 사용 가능액에 포함한다", () => {
  const data = defaultData();
  data.rulesets[0] = { ...data.rulesets[0], lunchBudget: 10_000, dinnerPolicy: "NONE", lunchCarry: "CARRY", cycleDay: 1 };
  data.entries["2026-09-01"] = { date: "2026-09-01", lunch: 4_000, dinner: 0, updatedAt: 1 };
  const summary = periodSummary(data, at(2026, 9, 3));
  assert.equal(summary.lunchAvailableNow, 26_000);
});

test("Ruleset은 effectiveFrom 기준으로 과거 기록에 소급되지 않는다", () => {
  const data = defaultData();
  data.rulesets.push({ ...data.rulesets[0], id: "new", effectiveFrom: "2026-10-01", lunchBudget: 20_000, updatedAt: 2 });
  assert.equal(rulesForDate(data, "2026-09-30").lunchBudget, 10_000);
  assert.equal(rulesForDate(data, "2026-10-01").lunchBudget, 20_000);
});

test("CSV v2 round trip은 데이터와 Ruleset 이력을 보존한다", () => {
  const data = defaultData();
  data.rulesets.push({ ...data.rulesets[0], id: "future", effectiveFrom: "2026-10-01", lunchBudget: 12_000, updatedAt: 99 });
  data.entries["2026-09-01"] = { date: "2026-09-01", lunch: 8_500, dinner: 12_000, dinnerEligible: true, updatedAt: 100 };
  assert.deepEqual(parseCsv(serializeCsv(data)), data);
});

test("legacy CSV v1은 v2 모델로 마이그레이션된다", () => {
  const csv = [
    "# food-coster-schema,1",
    "kind,key,a,b,c,d",
    "rule,lunchBudget,9000",
    "rule,dinnerBudget,14000",
    "rule,workdayMode,WEEKDAYS",
    "rule,lunchCarry,CARRY",
    "rule,dinnerPolicy,CONDITIONAL",
    "rule,dinnerCarry,DAILY",
    "rule,cycleDay,25",
    "entry,2026-08-31,8500,12000,1,",
  ].join("\n");
  const migrated: AppData = parseCsv(csv);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.rulesets[0].cycleDay, 25);
  assert.equal(migrated.entries["2026-08-31"].lunch, 8_500);
});

test("대한민국 공휴일 제외 설정은 공휴일 식대를 제외한다", () => {
  const data = defaultData();
  const rule = { ...data.rulesets[0], workdayMode: "EVERYDAY" as const, excludeKrPublicHolidays: true };
  assert.equal(isWorkday(at(2026, 10, 3), rule), false);
});
