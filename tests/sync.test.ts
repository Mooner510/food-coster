import assert from "node:assert/strict";
import test from "node:test";
import { defaultData } from "../lib/model";
import { mergeAppData } from "../lib/sync";

test("서로 다른 날짜의 오프라인 수정은 모두 보존된다", () => {
  const local = defaultData();
  const remote = defaultData();
  local.entries["2026-09-01"] = { date: "2026-09-01", lunch: 8_000, dinner: 0, updatedAt: 10 };
  remote.entries["2026-09-02"] = { date: "2026-09-02", lunch: 9_000, dinner: 0, updatedAt: 11 };
  const merged = mergeAppData(local, remote);
  assert.equal(merged.entries["2026-09-01"].lunch, 8_000);
  assert.equal(merged.entries["2026-09-02"].lunch, 9_000);
});

test("같은 날짜는 updatedAt이 최신인 값을 선택한다", () => {
  const local = defaultData();
  const remote = defaultData();
  local.entries["2026-09-01"] = { date: "2026-09-01", lunch: 8_000, dinner: 0, updatedAt: 20 };
  remote.entries["2026-09-01"] = { date: "2026-09-01", lunch: 9_000, dinner: 0, updatedAt: 10 };
  const merged = mergeAppData(local, remote);
  assert.equal(merged.entries["2026-09-01"].lunch, 8_000);
});

test("서로 다른 Ruleset revision을 모두 유지한다", () => {
  const local = defaultData();
  const remote = defaultData();
  local.rulesets.push({ ...local.rulesets[0], id: "oct", effectiveFrom: "2026-10-01", lunchBudget: 12_000, updatedAt: 10 });
  remote.rulesets.push({ ...remote.rulesets[0], id: "nov", effectiveFrom: "2026-11-01", lunchBudget: 13_000, updatedAt: 11 });
  const merged = mergeAppData(local, remote);
  assert.ok(merged.rulesets.some((rule) => rule.id === "oct"));
  assert.ok(merged.rulesets.some((rule) => rule.id === "nov"));
});
