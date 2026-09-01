import type { AppData, MealEntry, Ruleset } from "./model";
import { SCHEMA_VERSION } from "./model";

const newer = <T extends { updatedAt: number }>(a: T | undefined, b: T | undefined) => {
  if (!a) return b;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
};

export function mergeAppData(local: AppData, remote: AppData): AppData {
  const entries: Record<string, MealEntry> = {};
  const dates = new Set([...Object.keys(local.entries), ...Object.keys(remote.entries)]);
  for (const date of dates) {
    const selected = newer(local.entries[date], remote.entries[date]);
    if (selected) entries[date] = selected;
  }

  const rulesById = new Map<string, Ruleset>();
  for (const rule of [...remote.rulesets, ...local.rulesets]) {
    const existing = rulesById.get(rule.id);
    const selected = newer(existing, rule);
    if (selected) rulesById.set(rule.id, selected);
  }

  const rulesets = [...rulesById.values()].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  return { schemaVersion: SCHEMA_VERSION, rulesets, entries };
}

export function sameAppData(a: AppData, b: AppData) {
  return JSON.stringify(a) === JSON.stringify(b);
}
