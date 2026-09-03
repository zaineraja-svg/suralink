import { describe, it, expect } from "vitest";
import { transliterate } from "./transliterate.js";

describe("transliterate", () => {
  it("handles simple short vowels", () => {
    expect(transliterate("قُلْ")).toBe("qul");
  });

  it("handles a plain long vowel from alef", () => {
    expect(transliterate("قَالَ")).toBe("qāla");
  });

  it("doubles a shadda consonant with its vowel", () => {
    expect(transliterate("رَبِّ")).toBe("rabbi");
  });

  it("renders tanwin endings", () => {
    expect(transliterate("أَحَدٌ")).toBe("'ahadun");
  });

  it("keeps the moon-letter al- prefix intact", () => {
    expect(transliterate("الْقَمَرِ")).toBe("al-qamari");
  });

  it("assimilates a sun-letter al- prefix (no literal 'l')", () => {
    const result = transliterate("الشَّمْسِ");
    expect(result.startsWith("a")).toBe(true);
    expect(result).not.toContain("l-sh");
    expect(result).toContain("shsh"); // doubled sun letter from the shadda
  });

  it("reads a long ū from damma + waw-sukun", () => {
    expect(transliterate("نُورٌ")).toBe("nūrun");
  });

  it("reads a long ī from kasra + yaa-sukun", () => {
    expect(transliterate("فِيهِ")).toBe("fīhi");
  });

  it("treats taa marbuta as a soft word-final h", () => {
    expect(transliterate("رَحْمَة")).toBe("rahmah");
  });

  it("handles a full short ayah end to end (Al-Ikhlas 1)", () => {
    const result = transliterate("قُلْ هُوَ اللَّهُ أَحَدٌ");
    // Not asserting an exact academic transliteration — just that
    // it's a plausible, readable phonetic string with the right
    // word count and no leftover raw Arabic characters.
    expect(result.split(" ").length).toBe(4);
    expect(/[؀-ۿ]/.test(result)).toBe(false);
  });

  it("produces something for every word in a multi-ayah chunk, never dropping a word", () => {
    const text = "وَالْعَصْرِ إِنَّ الْإِنسَانَ لَفِي خُسْرٍ";
    const result = transliterate(text);
    expect(result.split(" ").length).toBe(text.trim().split(/\s+/).length);
  });
});
