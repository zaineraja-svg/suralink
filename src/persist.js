/* ============================================================
   PERSISTENCE — pure, isolated, unit-testable.
   Converts the app's live state (which uses Sets, not JSON-safe on
   their own) to and from a plain, versioned object safe to store in
   localStorage, and back. No localStorage access happens in this
   file — that's the caller's job (see loadState/saveState in
   App.jsx) — so this module can be tested with plain objects only.

   Every field is read defensively: a missing, corrupt, or
   older-version blob degrades to sensible per-field defaults rather
   than throwing or wiping everything else that DID parse fine.
   ============================================================ */

export const STORAGE_KEY = "quran-app-state-v1";
export const STATE_VERSION = 1;

const EMPTY_PROGRESS = {
  ayahsExplored: new Set(),
  ayahsUnderstood: new Set(),
  surahsCompleted: new Set(),
  words: {},
  streak: 0,
  lastActiveDate: null,
  salahDone: new Set(),
  bookmarks: new Set(),
};

function toArray(maybeSet) {
  return maybeSet instanceof Set ? [...maybeSet] : Array.isArray(maybeSet) ? maybeSet : [];
}
function toSet(maybeArray) {
  return new Set(Array.isArray(maybeArray) ? maybeArray : []);
}

/** Live app state -> plain JSON-safe object. */
export function serializeAppState({ prefs, progress, memorization, currentSurah, currentAyahIdx, onboarded, billing, selectedReciterId }) {
  return {
    v: STATE_VERSION,
    savedAt: Date.now(),
    prefs: prefs || null,
    progress: {
      ayahsExplored: toArray(progress?.ayahsExplored),
      ayahsUnderstood: toArray(progress?.ayahsUnderstood),
      surahsCompleted: toArray(progress?.surahsCompleted),
      words: progress?.words && typeof progress.words === "object" ? progress.words : {},
      streak: Number.isFinite(progress?.streak) ? progress.streak : 0,
      lastActiveDate: typeof progress?.lastActiveDate === "string" ? progress.lastActiveDate : null,
      salahDone: toArray(progress?.salahDone),
      bookmarks: toArray(progress?.bookmarks),
    },
    memorization: {
      items: memorization?.items && typeof memorization.items === "object" ? memorization.items : {},
      sessions: Array.isArray(memorization?.sessions) ? memorization.sessions : [],
    },
    currentSurah: Number.isFinite(currentSurah) ? currentSurah : 1,
    currentAyahIdx: Number.isFinite(currentAyahIdx) ? currentAyahIdx : 0,
    onboarded: !!onboarded,
    // Not a licensing gate on the audio itself (that stays free for
    // everyone, on both tiers) — this only limits how many BRAND NEW
    // chunks a free-tier user can start memorizing per calendar day.
    // Reviewing anything already learned is never limited.
    // `creatorUnlocked` (a redeemed creator code) and `subscriptionActive`
    // (a real, verified RevenueCat entitlement) are two independent
    // sources of premium access — either one alone is enough, and a
    // real subscription lapsing should never silently take away
    // something a creator code already granted. The app derives the
    // single "is this user premium" check from `creatorUnlocked ||
    // subscriptionActive`, never from one alone.
    billing: {
      creatorUnlocked: !!billing?.creatorUnlocked,
      subscriptionActive: !!billing?.subscriptionActive,
      newChunksToday: {
        date: typeof billing?.newChunksToday?.date === "string" ? billing.newChunksToday.date : null,
        count: Number.isFinite(billing?.newChunksToday?.count) ? billing.newChunksToday.count : 0,
      },
    },
    selectedReciterId: typeof selectedReciterId === "string" ? selectedReciterId : null,
  };
}

/**
 * Plain stored object (from JSON.parse, possibly from an older
 * version or partially corrupt) -> live app state with Sets
 * restored. Always returns a complete, safe-to-use object — every
 * field falls back independently rather than the whole thing
 * failing if one field is missing or malformed.
 */
export function deserializeAppState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const p = r.progress && typeof r.progress === "object" ? r.progress : {};
  const m = r.memorization && typeof r.memorization === "object" ? r.memorization : {};

  return {
    prefs: r.prefs && typeof r.prefs === "object" ? r.prefs : { goal: null, level: null, time: null },
    progress: {
      ayahsExplored: toSet(p.ayahsExplored),
      ayahsUnderstood: toSet(p.ayahsUnderstood),
      surahsCompleted: toSet(p.surahsCompleted),
      words: p.words && typeof p.words === "object" ? p.words : {},
      streak: Number.isFinite(p.streak) ? p.streak : EMPTY_PROGRESS.streak,
      lastActiveDate: typeof p.lastActiveDate === "string" ? p.lastActiveDate : null,
      salahDone: toSet(p.salahDone),
      bookmarks: toSet(p.bookmarks),
    },
    memorization: {
      items: m.items && typeof m.items === "object" ? m.items : {},
      sessions: Array.isArray(m.sessions) ? m.sessions : [],
    },
    currentSurah: Number.isFinite(r.currentSurah) ? r.currentSurah : 1,
    currentAyahIdx: Number.isFinite(r.currentAyahIdx) ? r.currentAyahIdx : 0,
    onboarded: !!r.onboarded,
    billing: {
      // `isPremium` (no source distinction) was this field's shape
      // before creator codes and real subscriptions became two
      // separate things — treat any pre-existing true there as a
      // grandfathered creatorUnlocked, never just silently drop it.
      creatorUnlocked: !!r.billing?.creatorUnlocked || !!r.billing?.isPremium,
      subscriptionActive: !!r.billing?.subscriptionActive,
      newChunksToday: {
        date: typeof r.billing?.newChunksToday?.date === "string" ? r.billing.newChunksToday.date : null,
        count: Number.isFinite(r.billing?.newChunksToday?.count) ? r.billing.newChunksToday.count : 0,
      },
    },
    selectedReciterId: typeof r.selectedReciterId === "string" ? r.selectedReciterId : null,
  };
}
