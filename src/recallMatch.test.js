import { describe, it, expect } from "vitest";
import { normalizeArabicForMatch, matchRecall, extractBrokenPhrase } from "./recallMatch.js";

describe("normalizeArabicForMatch", () => {
  it("strips diacritics", () => {
    expect(normalizeArabicForMatch("بِسْمِ اللَّهِ")).toBe(normalizeArabicForMatch("بسم الله"));
  });

  it("normalizes hamza-on-alef and madda/wasla variants to plain alef", () => {
    expect(normalizeArabicForMatch("أحد")).toBe(normalizeArabicForMatch("احد"));
    expect(normalizeArabicForMatch("آمن")).toBe(normalizeArabicForMatch("امن"));
    expect(normalizeArabicForMatch("إله")).toBe(normalizeArabicForMatch("اله"));
  });

  it("normalizes alef maksura and ta marbuta to their common typing substitutes", () => {
    expect(normalizeArabicForMatch("هدى")).toBe(normalizeArabicForMatch("هدي"));
    expect(normalizeArabicForMatch("رحمة")).toBe(normalizeArabicForMatch("رحمه"));
  });

  it("drops punctuation and collapses whitespace", () => {
    expect(normalizeArabicForMatch("قل  هو -- الله!")).toBe("قل هو الله");
  });
});

describe("matchRecall", () => {
  const ref = "قُلْ هُوَ اللَّهُ أَحَدٌ";

  it("passes on an exact (undiacritized) match", () => {
    const r = matchRecall(ref, "قل هو الله احد");
    expect(r.passed).toBe(true);
    expect(r.accuracy).toBe(1);
    expect(r.brokenIndices).toEqual([]);
    expect(r.wordResults.every((w) => w.status === "correct")).toBe(true);
  });

  it("flags a single wrong word without failing the whole thing if accuracy stays high enough", () => {
    // 3 of 4 words right = 0.75 accuracy, below default 0.85 threshold -> fails,
    // but the per-word breakdown should still isolate exactly the wrong word.
    const r = matchRecall(ref, "قل هو الله واحد");
    expect(r.wordResults[0]).toMatchObject({ status: "correct" });
    expect(r.wordResults[1]).toMatchObject({ status: "correct" });
    expect(r.wordResults[2]).toMatchObject({ status: "correct" });
    expect(r.wordResults[3].status).toBe("wrong");
    expect(r.brokenIndices).toEqual([3]);
  });

  it("passes when accuracy is at or above the threshold with one word off", () => {
    // 4 of 5 words right = 0.8 — use a lower custom threshold to test the boundary
    const r = matchRecall("الحمد لله رب العالمين الرحمن", "الحمد لله رب العالمين", 0.75);
    expect(r.passed).toBe(true);
  });

  it("marks a dropped word as missing, not wrong", () => {
    const r = matchRecall(ref, "قل هو احد"); // skipped "الله"
    const missing = r.wordResults.filter((w) => w.status === "missing");
    expect(missing.length).toBe(1);
    expect(missing[0].word).toBe(normalizeArabicForMatch("اللَّهُ"));
  });

  it("treats an empty attempt as fully missing", () => {
    const r = matchRecall(ref, "");
    expect(r.passed).toBe(false);
    expect(r.accuracy).toBe(0);
    expect(r.wordResults.every((w) => w.status === "missing")).toBe(true);
  });

  it("handles an empty reference gracefully (auto-pass, nothing to recall)", () => {
    const r = matchRecall("", "anything");
    expect(r.passed).toBe(true);
    expect(r.wordResults).toEqual([]);
  });
});

describe("extractBrokenPhrase", () => {
  it("joins only the words at the given indices, in order", () => {
    const refWords = ["قل", "هو", "الله", "احد"];
    expect(extractBrokenPhrase(refWords, [3])).toBe("احد");
    expect(extractBrokenPhrase(refWords, [1, 2])).toBe("هو الله");
  });
});
