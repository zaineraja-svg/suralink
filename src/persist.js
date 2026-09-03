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
export function serializeAppState({ prefs, progress, memorization, currentSurah, currentAyahIdx, onboarded }) {
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
  };
}
