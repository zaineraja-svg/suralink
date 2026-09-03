/* ============================================================
   TRANSLITERATION — pure, isolated, unit-testable.
   Converts fully-diacritized Arabic (the Uthmani-style text this
   app already stores, with harakat/tanwin/shadda intact) into a
   readable Latin phonetic reading — NOT an academic transliteration
   standard (no macrons/dots-under-letters), just something someone
   with zero Arabic literacy can sound out while listening along.
   Handles: short vowels, shadda (consonant doubling), tanwin
   endings, long vowels (alef/waw/yaa as vowel carriers), and
   sun/moon letter assimilation for the "al-" prefix (e.g. الشمس ->
   "ash-shams", not the technically-wrong "al-shams"). It will not
   be perfect on every irregular word — Arabic morphology has real
   exceptions this doesn't model — but it's a solid, honest read-
   along aid, which is what it's for.
   ============================================================ */

const CONSONANTS = {
  "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh",
  "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh",
  "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "'", "غ": "gh",
  "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n",
  "ه": "h", "ء": "'", "أ": "'", "إ": "'", "ؤ": "'", "ئ": "'",
  // آ (alef madda) is intentionally NOT here — it combines hamza +
  // long ā in one glyph and is handled as its own case (-> "'ā"),
  // not routed through the generic consonant+harakah pipeline.
};

// Letters after which the ل of "ال" assimilates (sun letters) —
// the ل is dropped in pronunciation and the following consonant
// doubles instead, e.g. الرحمن -> "ar-rahman", النور -> "an-nur".
const SUN_LETTERS = new Set([
  "ت", "ث", "د", "ذ", "ر", "ز", "س", "ش",
  "ص", "ض", "ط", "ظ", "ل", "ن",
]);

// Single-letter particles very commonly attached directly to the
// next word with no space (وَ "and", فَ "so", بِ "by/with", لِ "for",
// كَ "like/as") — read as a leading syllable, see the prefix-scan
// at the top of transliterateWord.
const PREFIX_LETTERS = new Set(["و", "ف", "ب", "ل", "ك"]);

const FATHA = "َ", KASRA = "ِ", DAMMA = "ُ", SUKUN = "ْ", SHADDA = "ّ";
// U+064B fathatan "an", U+064C dammatan "un", U+064D kasratan "in".
const TANWIN_FATH = "ً", TANWIN_DAMM = "ٌ", TANWIN_KASR = "ٍ";
const DAGGER_ALEF = "ٰ"; // superscript alef, e.g. in "هٰذا"
const ALEF = "ا", ALEF_MAKSURA = "ى", ALEF_MADDA = "آ", TAA_MARBUTA = "ة";
const WAW = "و", YAA = "ي";

function isHarakah(ch) {
  return ch === FATHA || ch === KASRA || ch === DAMMA || ch === SUKUN
    || ch === TANWIN_FATH || ch === TANWIN_KASR || ch === TANWIN_DAMM;
}

/** Transliterate one already-space-separated Arabic word. */
function transliterateWord(word) {
  const chars = [...word];
  let out = "";
  let i = 0;

  // A single-letter particle (و "and", ف "so", ب "by/with", ل "for",
  // ك "like/as") is very commonly written attached directly to the
  // next word with no space — e.g. وَالْعَصْرِ is "wa" + "al-" + "asr"
  // as ONE token. Read that leading letter (with its own vowel) here
  // first, so the "ال" check right after can still find the definite
  // article at the position it actually starts, not just position 0.
  let alStart = 0;
  if (PREFIX_LETTERS.has(chars[0]) && chars[2] === ALEF && chars[3] === "ل") {
    const prefixVowelCh = chars[1];
    let prefixVowel = "";
    if (prefixVowelCh === FATHA) prefixVowel = "a";
    else if (prefixVowelCh === KASRA) prefixVowel = "i";
    else if (prefixVowelCh === DAMMA) prefixVowel = "u";
    out += (chars[0] === WAW ? "w" : CONSONANTS[chars[0]]) + prefixVowel; // و isn't in CONSONANTS (handled specially elsewhere)
    alStart = 2;
  }

  // "ال" prefix — sun/moon assimilation. Only treated as the
  // definite article when it's a genuine prefix (followed by more
  // letters), not when the whole word just happens to be alef-lam.
  // For sun letters, Quran orthography already writes a shadda on
  // the assimilated letter itself (e.g. الشَّمْس) — so the fix here
  // is just to drop the silent ل and let the normal shadda-doubling
  // logic in the main loop double that letter, rather than trying
  // to reconstruct the doubling by hand.
  if (chars[alStart] === ALEF && chars[alStart + 1] === "ل" && chars.length > alStart + 2) {
    const nextLetter = chars[alStart + 2];
    if ((isHarakah(nextLetter) && nextLetter !== SUKUN) || nextLetter === SHADDA) {
      // (a plain sukun on the lam is the NORMAL moon-letter marker —
      // "the lam, no vowel" — not a sign of the irregular case)
      // The lam itself carries a diacritic right after it — that
      // only happens for the irregular الَّذِي/الَّتِي/الَّذِينَ family,
      // which doubles the LAM itself (shadda somewhere on it, order
      // varies) rather than following ordinary sun-letter
      // assimilation. Emit "a" and let the main loop process that
      // lam, with its own shadda and vowel, normally from here.
      out += "a";
      i = alStart + 1;
    } else if (SUN_LETTERS.has(nextLetter)) {
      out += "a";
      i = alStart + 2; // skip only ا and ل — the sun letter itself is processed normally below
    } else {
      out += (alStart > 0 ? "l-" : "al-");
      i = alStart + 2;
    }
  } else {
    i = alStart;
  }

  for (; i < chars.length; i++) {
    const ch = chars[i];

    if (ch === SHADDA) continue; // handled when we hit the consonant it doubles (look-ahead below)
    if (isHarakah(ch)) continue; // consumed alongside the consonant that precedes it (or a long-vowel lookahead)
    if (ch === DAGGER_ALEF) { out += "ā"; continue; }
    if (ch === ALEF_MAKSURA) { out += "ā"; continue; } // word-final long a spelled with ى
    if (ch === ALEF_MADDA) { out += "'ā"; continue; } // آ combines hamza + long ā in one glyph

    if (ch === TAA_MARBUTA) {
      // Silent/soft word-final "h" — this app recites word-by-word
      // in isolation, where taa marbuta is pronounced softly, not
      // as a hard "t" (that only happens mid-construct-phrase).
      out += "h";
      continue;
    }

    if (ch === ALEF) {
      // A bare alef reached directly here (not consumed as part of a
      // consonant+fatha+alef long-ā lookahead below) is either a
      // word-initial hamza seat with no explicit hamza mark, or a
      // standalone lengthener — either way, "ā" is the right read.
      out += "ā";
      continue;
    }

    const isConsonant = Object.prototype.hasOwnProperty.call(CONSONANTS, ch);
    const isVowelLetter = ch === WAW || ch === YAA;
    if (!isConsonant && !isVowelLetter) continue; // unrecognized char — drop, don't corrupt output

    // A consonant can be followed by a shadda and/or a single vowel
    // diacritic in EITHER order (real Quran text isn't consistent —
    // e.g. رَبِّ stores kasra-then-shadda, not shadda-then-kasra), so
    // scan forward consuming both regardless of which comes first,
    // then look at whatever comes after THAT for long-vowel letters.
    let j = i + 1;
    let doubled = false;
    let harakah = undefined;
    while (j < chars.length && (chars[j] === SHADDA || isHarakah(chars[j]))) {
      if (chars[j] === SHADDA) doubled = true;
      else harakah = chars[j];
      j++;
    }
    const afterIdx = j; // first character position after this letter's own diacritics

    if (isVowelLetter) {
      // Reaching و/ي directly (not via the consonant-lookahead cases
      // below, which consume it themselves) means it's either a real
      // consonant (w/y) or the tail of an "aw"/"ay" diphthong.
      const prevChar = chars[i - 1];
      if (ch === WAW && harakah === SUKUN && prevChar === FATHA) { out += "w"; continue; }
      if (ch === YAA && harakah === SUKUN && prevChar === FATHA) { out += "y"; continue; }
    } else if (harakah === FATHA && (chars[afterIdx] === ALEF || chars[afterIdx] === DAGGER_ALEF)) {
      // consonant + fatha + alef (or the dagger-alef spelling some
      // words use instead of a full alef, e.g. الرَّحْمَٰنِ) = long ā.
      // Emit the consonant with NO short vowel of its own — the loop
      // reaching that alef next would double it, so consume it here.
      out += (doubled ? CONSONANTS[ch] + CONSONANTS[ch] : CONSONANTS[ch]) + "ā";
      i = afterIdx;
      continue;
    } else if (harakah === DAMMA && chars[afterIdx] === WAW && chars[afterIdx + 1] !== FATHA) {
      // consonant + damma + waw = long ū (excluded when it's really
      // an "aw" diphthong, which needs a fatha before a sukun-waw).
      let end = afterIdx + 1; // position right after the waw
      // Word-final "وا" (very common on plural verb endings, e.g.
      // آمَنُوا "āmanū") spells a silent alef after the waw — purely
      // orthographic, never pronounced — so swallow it here too.
      if (chars[end] === ALEF && end + 1 === chars.length) end += 1;
      out += (doubled ? CONSONANTS[ch] + CONSONANTS[ch] : CONSONANTS[ch]) + "ū";
      i = end - 1; // -1 because the for-loop's i++ advances to `end` next
      continue;
    } else if (harakah === KASRA && chars[afterIdx] === YAA && chars[afterIdx + 1] !== FATHA) {
      // consonant + kasra + yaa = long ī
      out += (doubled ? CONSONANTS[ch] + CONSONANTS[ch] : CONSONANTS[ch]) + "ī";
      i = afterIdx;
      continue;
    }

    // Ordinary case: this letter with its own short vowel (or none).
    const letter = isConsonant ? CONSONANTS[ch] : (ch === WAW ? "w" : "y");
    let vowel = "";
    if (harakah === FATHA) vowel = "a";
    else if (harakah === KASRA) vowel = "i";
    else if (harakah === DAMMA) vowel = "u";
    else if (harakah === TANWIN_FATH) vowel = "an";
    else if (harakah === TANWIN_KASR) vowel = "in";
    else if (harakah === TANWIN_DAMM) vowel = "un";
    // SUKUN or no following harakah at all -> no vowel (consonant cluster / word-final)

    out += doubled ? letter + letter + vowel : letter + vowel;
    i = afterIdx - 1; // -1 because the for-loop's i++ will advance past the last consumed diacritic
  }

  return out;
}

/**
 * Transliterate a full ayah/chunk of Arabic text (space-separated
 * words) into a readable Latin phonetic string.
 */
export function transliterate(arabicText) {
  return transliterateWords(arabicText).join(" ");
}

/**
 * Same as transliterate(), but returns one entry per Arabic word
 * instead of joining them — the array is index-aligned with the
 * source text's own whitespace-split words, which is what lets a
 * UI highlight the Nth transliterated word in step with the Nth
 * Arabic word (e.g. during word-by-word audio playback).
 */
export function transliterateWords(arabicText) {
  return arabicText.trim().split(/\s+/).map(transliterateWord).filter(Boolean);
}
