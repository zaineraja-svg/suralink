import { describe, it, expect } from "vitest";
import { serializeAppState, deserializeAppState, STATE_VERSION } from "./persist.js";

function liveState(overrides = {}) {
  return {
    prefs: { goal: "salah", level: "some", time: "5" },
    progress: {
      ayahsExplored: new Set(["1:1", "1:2"]),
      ayahsUnderstood: new Set(["1:1"]),
      surahsCompleted: new Set([112]),
      words: { "قُلْ": { count: 3, meaning: "Say" } },
      streak: 12,
      salahDone: new Set(["takbir"]),
      bookmarks: new Set(["1:1"]),
    },
    memorization: {
      items: { "112:1-4": { id: "112:1-4", status: "learned" } },
      sessions: [{ itemId: "112:1-4", result: "pass", timestamp: 1000 }],
    },
    currentSurah: 112,
    currentAyahIdx: 2,
    onboarded: true,
    ...overrides,
  };
}

describe("serializeAppState / deserializeAppState round-trip", () => {
  it("preserves every Set as an array and restores it back to a Set", () => {
    const serialized = serializeAppState(liveState());
    expect(Array.isArray(serialized.progress.ayahsExplored)).toBe(true);
    expect(new Set(serialized.progress.ayahsExplored)).toEqual(new Set(["1:1", "1:2"]));

    const restored = deserializeAppState(serialized);
    expect(restored.progress.ayahsExplored).toBeInstanceOf(Set);
    expect(restored.progress.ayahsExplored).toEqual(new Set(["1:1", "1:2"]));
    expect(restored.progress.ayahsUnderstood).toEqual(new Set(["1:1"]));
    expect(restored.progress.surahsCompleted).toEqual(new Set([112]));
    expect(restored.progress.salahDone).toEqual(new Set(["takbir"]));
    expect(restored.progress.bookmarks).toEqual(new Set(["1:1"]));
  });

  it("round-trips plain fields (words, streak, memorization, prefs, position) exactly", () => {
    const restored = deserializeAppState(serializeAppState(liveState()));
    expect(restored.progress.words).toEqual({ "قُلْ": { count: 3, meaning: "Say" } });
    expect(restored.progress.streak).toBe(12);
    expect(restored.memorization).toEqual({
      items: { "112:1-4": { id: "112:1-4", status: "learned" } },
      sessions: [{ itemId: "112:1-4", result: "pass", timestamp: 1000 }],
    });
    expect(restored.prefs).toEqual({ goal: "salah", level: "some", time: "5" });
    expect(restored.currentSurah).toBe(112);
    expect(restored.currentAyahIdx).toBe(2);
    expect(restored.onboarded).toBe(true);
  });

  it("stamps a version and a savedAt timestamp", () => {
    const serialized = serializeAppState(liveState());
    expect(serialized.v).toBe(STATE_VERSION);
    expect(typeof serialized.savedAt).toBe("number");
  });
});

describe("deserializeAppState — defensive defaults", () => {
  it("returns full safe defaults for null/undefined input", () => {
    for (const bad of [null, undefined, "not an object", 42]) {
      const restored = deserializeAppState(bad);
      expect(restored.progress.ayahsExplored).toEqual(new Set());
      expect(restored.progress.streak).toBe(0);
      expect(restored.memorization).toEqual({ items: {}, sessions: [] });
      expect(restored.currentSurah).toBe(1);
      expect(restored.currentAyahIdx).toBe(0);
      expect(restored.onboarded).toBe(false);
      expect(restored.prefs).toEqual({ goal: null, level: null, time: null });
    }
  });

  it("defaults just the broken field when only part of the blob is malformed", () => {
    const raw = {
      progress: { ayahsExplored: "not an array", streak: 5, words: { a: 1 } },
      memorization: { items: null, sessions: "nope" },
      currentSurah: "not a number",
      onboarded: true,
    };
    const restored = deserializeAppState(raw);
    expect(restored.progress.ayahsExplored).toEqual(new Set()); // bad field -> default
    expect(restored.progress.streak).toBe(5); // good field -> preserved
    expect(restored.progress.words).toEqual({ a: 1 }); // good field -> preserved
    expect(restored.memorization.items).toEqual({});
    expect(restored.memorization.sessions).toEqual([]);
    expect(restored.currentSurah).toBe(1); // bad -> default
    expect(restored.onboarded).toBe(true); // good -> preserved
  });

  it("tolerates an already-Set-shaped array-of-arrays gracefully (no crash) even though it's not the real shape", () => {
    expect(() => deserializeAppState({ progress: { ayahsExplored: [["nested"]] } })).not.toThrow();
  });
});
