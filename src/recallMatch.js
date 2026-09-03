/* ============================================================
   RECALL MATCHING — pure, isolated, unit-testable.
   Compares what a user recalled (typed OR a speech-to-text
   transcript — both arrive here as plain strings, so this module
   doesn't care which input method produced them) against the real
   ayah text, word by word, and reports exactly which words were
   right, wrong, or missing. That per-word breakdown is what lets
   the UI isolate and re-drill only the broken part of a chunk
   instead of the whole thing.
   ============================================================ */

// Codepoint ranges to strip for lenient comparison: Arabic
// combining diacritics (harakat/tanwin/sukun/shadda), the
// superscript alef, and the Quranic annotation/waqf marks. Using
// explicit codepoints (rather than a regex literal full of raw
// combining characters, which is unreadable and easy to mistype)
// keeps this correct and auditable.
const DIACRITIC_RANGES = [
  [0x064b, 0x065f], // harakat, tanwin, shadda, sukun, etc.
  [0x0670, 0x0670], // superscript alef
  [0x06d6, 0x06ed], // Quranic annotation signs (waqf marks, small high marks)
  [0x08d3, 0x08ff], // extended Arabic diacritics
];

function isDiacritic(codePoint) {
  return DIACRITIC_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

// Strip diacritics, tatweel, and normalize alef/hamza-seat variants
// users won't reliably type or that speech recognition won't
// reliably transcribe. This is a LENIENT comparison on purpose —
// recall checks should reward getting the right word, not perfect
// Uthmani orthography.
export function normalizeArabicForMatch(text) {
  const stripped = [...text.normalize("NFC")]
    .filter((ch) => !isDiacritic(ch.codePointAt(0)))
    .join("")
    .replace(/ـ/g, ""); // tatweel

  let out = "";
  for (const ch of stripped) {
    if (ch === "إ" || ch === "أ" || ch === "آ" || ch === "ٱ") out += "ا";
    else if (ch === "ى") out += "ي";
    else if (ch === "ة") out += "ه";
    else if (ch === " " || (ch >= "ء" && ch <= "ي")) out += ch;
    // anything else (punctuation, latin, digits) is dropped
  }
  return out.replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  const n = normalizeArabicForMatch(text);
  return n.length ? n.split(" ") : [];
}

/**
 * Word-level alignment via classic edit-distance (Wagner–Fischer),
 * backtracked to produce an op sequence. This is what lets a
 * transposed or slightly misheard word get flagged individually
 * instead of cascading into "everything after this is wrong."
 */
function alignWords(refWords, attemptWords) {
  const n = refWords.length, m = attemptWords.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (refWords[i - 1] === attemptWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  // Backtrack to an op sequence, aligned to reference-word order.
  let i = n, j = m;
  const rev = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && refWords[i - 1] === attemptWords[j - 1]) {
      rev.push({ refIndex: i - 1, status: "correct", attemptWord: attemptWords[j - 1] });
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      rev.push({ refIndex: i - 1, status: "wrong", attemptWord: attemptWords[j - 1] });
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      rev.push({ refIndex: i - 1, status: "missing", attemptWord: null });
      i--;
    } else {
      rev.push({ refIndex: null, status: "extra", attemptWord: attemptWords[j - 1] });
      j--;
    }
  }
  rev.reverse();
  return rev;
}

/**
 * Compare a recalled string against the reference Arabic text.
 * @param {string} referenceText - the real ayah/chunk text
 * @param {string} attemptText - what the user typed or what STT heard
 * @param {number} passThreshold - accuracy (0-1) needed to count as a pass; default 0.85
 * @returns {{
 *   passed: boolean,
 *   accuracy: number,
 *   refWords: string[],
 *   wordResults: Array<{ word: string, status: "correct"|"wrong"|"missing", heard: string|null }>,
 *   brokenIndices: number[],   // indices into refWords that need re-drilling
 * }}
 */
export function matchRecall(referenceText, attemptText, passThreshold = 0.85) {
  const refWords = tokenize(referenceText);
  const attemptWords = tokenize(attemptText);

  if (refWords.length === 0) {
    return { passed: true, accuracy: 1, refWords: [], wordResults: [], brokenIndices: [] };
  }
  if (attemptWords.length === 0) {
    return {
      passed: false,
      accuracy: 0,
      refWords,
      wordResults: refWords.map((w) => ({ word: w, status: "missing", heard: null })),
      brokenIndices: refWords.map((_, i) => i),
    };
  }

  const ops = alignWords(refWords, attemptWords);
  const wordResults = [];
  const brokenIndices = [];
  let correctCount = 0;

  for (const op of ops) {
    if (op.status === "extra") continue; // doesn't map to a reference word; ignored for scoring
    const word = refWords[op.refIndex];
    wordResults[op.refIndex] = { word, status: op.status, heard: op.attemptWord };
    if (op.status === "correct") correctCount++;
    else brokenIndices.push(op.refIndex);
  }

  const accuracy = correctCount / refWords.length;
  return { passed: accuracy >= passThreshold, accuracy, refWords, wordResults, brokenIndices };
}

/** Build the reference text for just the broken words, for the isolated re-drill step. */
export function extractBrokenPhrase(refWords, brokenIndices) {
  return brokenIndices.map((i) => refWords[i]).join(" ");
}
