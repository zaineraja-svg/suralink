import { describe, it, expect } from "vitest";
import {
  createMemorizationItem,
  applyReviewResult,
  isDue,
  sortByMostOverdue,
  countDue,
  STEP_LADDER_DAYS,
  MS_PER_DAY,
  MIN_EASE_FACTOR,
  DEFAULT_EASE_FACTOR,
} from "./srs.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");

describe("createMemorizationItem", () => {
  it("builds a fresh item with expected defaults", () => {
    const item = createMemorizationItem({ surahId: 103, ayahStart: 1, ayahEnd: 2, now: T0 });
    expect(item.id).toBe("103:1-2");
    expect(item.status).toBe("new");
    expect(item.consecutiveCorrect).toBe(0);
    expect(item.easeFactor).toBe(DEFAULT_EASE_FACTOR);
    expect(item.nextReviewAt).toBeNull();
  });
});

describe("applyReviewResult — pass path", () => {
  it("climbs the fixed step ladder on consecutive passes", () => {
    let item = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    let t = T0;
    for (let i = 0; i < STEP_LADDER_DAYS.length; i++) {
      item = applyReviewResult(item, "pass", t);
      expect(item.status).toBe("learned");
      expect(item.consecutiveCorrect).toBe(i + 1);
      expect(item.intervalDays).toBe(STEP_LADDER_DAYS[i]);
      expect(item.nextReviewAt).toBe(t + STEP_LADDER_DAYS[i] * MS_PER_DAY);
      t = item.nextReviewAt; // simulate reviewing exactly when due
    }
  });

  it("switches to ease-factor multiplication once past the ladder", () => {
    let item = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    let t = T0;
    for (let i = 0; i < STEP_LADDER_DAYS.length; i++) {
      item = applyReviewResult(item, "pass", t);
      t = item.nextReviewAt;
    }
    const beforeInterval = item.intervalDays;
    item = applyReviewResult(item, "pass", t);
    expect(item.consecutiveCorrect).toBe(STEP_LADDER_DAYS.length + 1);
    // interval uses THIS pass's freshly-bumped ease factor, per standard SM-2
    expect(item.intervalDays).toBe(Math.round(beforeInterval * item.easeFactor));
    // further growth compounds — should exceed the ladder's max step
    expect(item.intervalDays).toBeGreaterThan(STEP_LADDER_DAYS[STEP_LADDER_DAYS.length - 1]);
  });

  it("increases ease factor slightly on every pass", () => {
    let item = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    item = applyReviewResult(item, "pass", T0);
    expect(item.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR + 0.1, 5);
  });
});

describe("applyReviewResult — fail path", () => {
  it("resets consecutiveCorrect and drops interval to 1 day", () => {
    let item = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    item = applyReviewResult(item, "pass", T0);
    item = applyReviewResult(item, "pass", item.nextReviewAt);
    expect(item.consecutiveCorrect).toBe(2);

    const failedAt = item.nextReviewAt;
    item = applyReviewResult(item, "fail", failedAt);
    expect(item.status).toBe("learning");
    expect(item.consecutiveCorrect).toBe(0);
    expect(item.intervalDays).toBe(1);
    expect(item.nextReviewAt).toBe(failedAt + 1 * MS_PER_DAY);
  });

  it("decreases ease factor but never below the floor", () => {
    let item = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    item = { ...item, easeFactor: MIN_EASE_FACTOR + 0.05 };
    item = applyReviewResult(item, "fail", T0);
    expect(item.easeFactor).toBe(MIN_EASE_FACTOR);
  });

  it("rejects an invalid result value", () => {
    const item = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    expect(() => applyReviewResult(item, "maybe", T0)).toThrow();
  });
});

describe("isDue / sortByMostOverdue / countDue", () => {
  it("a brand-new item is never due", () => {
    const item = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    expect(isDue(item, T0 + 100 * MS_PER_DAY)).toBe(false);
  });

  it("an item becomes due exactly at its nextReviewAt", () => {
    let item = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    item = applyReviewResult(item, "pass", T0); // due at T0 + 1 day
    expect(isDue(item, item.nextReviewAt - 1)).toBe(false);
    expect(isDue(item, item.nextReviewAt)).toBe(true);
    expect(isDue(item, item.nextReviewAt + MS_PER_DAY)).toBe(true);
  });

  it("sorts due items most-overdue first, and excludes not-yet-due items", () => {
    let a = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    let b = createMemorizationItem({ surahId: 1, ayahStart: 2, ayahEnd: 2, now: T0 });
    let c = createMemorizationItem({ surahId: 1, ayahStart: 3, ayahEnd: 3, now: T0 });
    let d = createMemorizationItem({ surahId: 1, ayahStart: 4, ayahEnd: 4, now: T0 });
    a = applyReviewResult(a, "pass", T0 - 2 * MS_PER_DAY); // due T0-1d (due, less overdue)
    b = applyReviewResult(b, "pass", T0 - 6 * MS_PER_DAY); // due T0-5d (due, most overdue)
    c = applyReviewResult(c, "pass", T0 - 1 * MS_PER_DAY); // due T0 (due, right at boundary)
    // d stays "new" — never due regardless of time
    const sorted = sortByMostOverdue([a, b, c, d], T0);
    // b is 5 days overdue, a is 1 day overdue, c is due exactly now (0 overdue)
    expect(sorted.map((it) => it.id)).toEqual([b.id, a.id, c.id]);
  });

  it("counts only due items", () => {
    let a = createMemorizationItem({ surahId: 1, ayahStart: 1, ayahEnd: 1, now: T0 });
    let b = createMemorizationItem({ surahId: 1, ayahStart: 2, ayahEnd: 2, now: T0 });
    a = applyReviewResult(a, "pass", T0); // due T0+1d
    // b stays "new" — never counted
    expect(countDue([a, b], T0)).toBe(0);
    expect(countDue([a, b], T0 + 1 * MS_PER_DAY)).toBe(1);
  });
});
