/* ============================================================
   SPACED REPETITION SCHEDULER — pure, isolated, unit-testable.
   No React, no DOM, no I/O. Every function takes plain data in
   and returns plain data out, so the memorization UI (and tests)
   can call it directly without mounting anything.

   Model: a simplified SM-2. The first several correct reps climb
   a fixed step ladder (matches how most people describe "spaced
   repetition" intuitively: tomorrow, then 3 days, then a week...),
   after which growth switches to ease-factor multiplication like
   classic SM-2, so long-term intervals keep expanding sensibly
   instead of capping at the last fixed step forever.
   ============================================================ */

// Day counts for the Nth consecutive correct pass (1-indexed).
// Once consecutiveCorrect exceeds this ladder, interval growth
// switches to `previousInterval * easeFactor` (classic SM-2).
export const STEP_LADDER_DAYS = [1, 3, 7, 14, 30];

export const DEFAULT_EASE_FACTOR = 2.5;
export const MIN_EASE_FACTOR = 1.3;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A fresh MemorizationItem for a newly-chunked ayah range.
 * @param {{surahId:number, ayahStart:number, ayahEnd:number, audioRef?:object, translationRef?:object}} args
 */
export function createMemorizationItem({ surahId, ayahStart, ayahEnd, audioRef = null, translationRef = null, now = Date.now() }) {
  return {
    id: `${surahId}:${ayahStart}-${ayahEnd}`,
    surahId,
    ayahRange: [ayahStart, ayahEnd],
    audioRef,
    translationRef,
    status: "new", // new -> learning -> learned (in SRS rotation)
    intervalDays: 0,
    easeFactor: DEFAULT_EASE_FACTOR,
    consecutiveCorrect: 0,
    lastResult: null, // "pass" | "fail" | null
    nextReviewAt: null, // epoch ms, or null until first learned
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply one recall result (from either the initial "learn" pass or
 * a later "review" pass) to an item, returning a NEW item object
 * (never mutates the input) plus the interval that was assigned.
 *
 * @param {object} item - a MemorizationItem
 * @param {"pass"|"fail"} result
 * @param {number} now - epoch ms, injectable for tests
 */
export function applyReviewResult(item, result, now = Date.now()) {
  if (result !== "pass" && result !== "fail") {
    throw new Error(`applyReviewResult: result must be "pass" or "fail", got ${JSON.stringify(result)}`);
  }

  if (result === "fail") {
    const next = {
      ...item,
      status: "learning", // drop back into near-term rotation, not fully "learned"
      consecutiveCorrect: 0,
      easeFactor: Math.max(MIN_EASE_FACTOR, roundTo(item.easeFactor - 0.2, 2)),
      intervalDays: 1,
      lastResult: "fail",
      nextReviewAt: now + 1 * MS_PER_DAY,
      updatedAt: now,
    };
    return next;
  }

  // pass
  const consecutiveCorrect = item.consecutiveCorrect + 1;
  const easeFactor = roundTo(item.easeFactor + 0.1, 2); // no cap in classic SM-2, but keep it sane
  const intervalDays = consecutiveCorrect <= STEP_LADDER_DAYS.length
    ? STEP_LADDER_DAYS[consecutiveCorrect - 1]
    : Math.round((item.intervalDays || STEP_LADDER_DAYS[STEP_LADDER_DAYS.length - 1]) * easeFactor);

  return {
    ...item,
    status: "learned",
    consecutiveCorrect,
    easeFactor,
    intervalDays,
    lastResult: "pass",
    nextReviewAt: now + intervalDays * MS_PER_DAY,
    updatedAt: now,
  };
}

/** True if an item is due for review at the given moment (defaults to now). */
export function isDue(item, now = Date.now()) {
  if (item.status === "new") return false; // not learned yet — belongs in "Learn", not "Review"
  if (item.nextReviewAt == null) return false;
  return item.nextReviewAt <= now;
}

/**
 * Sort a list of items by how overdue they are (most overdue first).
 * Items due at the exact same time keep their relative order.
 */
export function sortByMostOverdue(items, now = Date.now()) {
  return items
    .filter((it) => isDue(it, now))
    .map((it, i) => ({ it, overdueMs: now - it.nextReviewAt, i }))
    .sort((a, b) => b.overdueMs - a.overdueMs || a.i - b.i)
    .map((x) => x.it);
}

/** Count of items due right now — the number a dashboard badge should show. */
export function countDue(items, now = Date.now()) {
  return items.reduce((n, it) => n + (isDue(it, now) ? 1 : 0), 0);
}

function roundTo(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
