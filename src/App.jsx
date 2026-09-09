import React, { useState, useMemo, useCallback } from "react";
import {
  createMemorizationItem,
  applyReviewResult,
  isDue,
  sortByMostOverdue,
  countDue,
} from "./srs.js";
import { matchRecall, extractBrokenPhrase } from "./recallMatch.js";
import { transliterate, transliterateWords } from "./transliterate.js";
import { serializeAppState, deserializeAppState, STORAGE_KEY } from "./persist.js";
// Capacitor is a no-op on the plain web (isNativePlatform() just
// returns false) — safe to import unconditionally. It's only
// actually exercised once this app is wrapped and run as the real
// iOS build, where the browser's SpeechRecognition API doesn't
// exist at all (a WebKit/iOS limitation, not something fixable
// from this app's own code) and this native plugin is the real
// substitute.
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition as NativeSpeechRecognition } from "@capacitor-community/speech-recognition";
import { Purchases } from "@revenuecat/purchases-capacitor";

// Real subscription config — set up in App Store Connect (the two
// products) and RevenueCat (the API key + the "unlimited" entitlement
// both products are attached to). Never touched on the plain website
// (isNativeApp() is always false there) — only the native iOS build
// actually configures or purchases anything through this.
const REVENUECAT_API_KEY_IOS = "appl_aUMaZeSGyXqXVyYKwErHjIpwgqq";
const RC_ENTITLEMENT_ID = "unlimited";
const RC_PRODUCT_IDS = { monthly: "com.suralink.app.monthly", annual: "com.suralink.app.annual" };

/* ============================================================
   FONTS (loaded via link in index — for artifact preview we
   inject a <style> tag with @import, which the sandbox allows)
   ============================================================ */
const FontLoader = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
  `}</style>
);

/* ============================================================
   DESIGN TOKENS
   Palette: "manuscript at night" — a deep indigo/ink ground,
   illuminated-parchment card for the Arabic centerpiece,
   antique gold + muted teal as the two accents.
   ============================================================ */
// "Inside the mosque at night" palette — deep emerald ground instead
// of indigo, warm mosque-lamp gold as the one accent, everything
// else (parchment, danger, text tones) shifted just enough to sit
// naturally on green rather than blue-black. `teal`/`tealSoft` keep
// their original key names (used all over the app for the "success/
// understood" tone) but are now a richer masjid-carpet green.
const T = {
  ink: "#0c1a14",
  inkRaised: "#132821",
  inkLine: "#264337",
  parchment: "#F4EEDA",
  parchmentDim: "#E9E0C4",
  gold: "#C9A45C",
  goldSoft: "#E7CE93",
  teal: "#2E7D53",
  tealSoft: "#6FBE8E",
  textHi: "#F1EFE2",
  textLo: "#9BAC9E",
  textFaint: "#5C7267",
  danger: "#C97A6B",
};

const displaySerif = { fontFamily: "'Cormorant Garamond', serif" };
const arabicFont = { fontFamily: "'Amiri', serif" };
const bodySans = { fontFamily: "'Inter', sans-serif" };
const mono = { fontFamily: "'IBM Plex Mono', monospace" };

/* ============================================================
   PRONUNCIATION (tap-to-hear)
   Uses the browser's built-in speech synthesis so words play
   instantly with no extra setup or API keys — same idea as
   Duolingo's tap-a-word audio. Picks the best available Arabic
   voice; falls back gracefully if the browser has none.
   ============================================================ */
let cachedArabicVoice = null;
let voicesReady = false;

function primeVoices() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const pick = () => {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    voicesReady = true;
    cachedArabicVoice =
      voices.find((v) => v.lang?.toLowerCase().startsWith("ar")) || null;
  };
  pick();
  if (!voicesReady) {
    window.speechSynthesis.onvoiceschanged = pick;
  }
}
if (typeof window !== "undefined") primeVoices();

// Speaks Arabic text via the browser's TTS and reports state through
// callbacks, the same way the real-audio players do — so a button
// using this can show a proper playing/error state instead of firing
// speech with no feedback at all. If the device has no Arabic voice
// installed, most engines stay silent with no error event, so that
// case is reported explicitly via onError rather than assumed to work.
function speakArabic(text, { rate = 0.8, onStart, onEnd, onError } = {}) {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    onError && onError("unsupported");
    return;
  }
  window.speechSynthesis.cancel(); // interrupt anything already playing
  if (voicesReady && !cachedArabicVoice) {
    // No Arabic voice on this device — speaking would likely be silent
    // or badly mispronounced, so report it instead of playing nothing.
    onError && onError("no-arabic-voice");
    return;
  }
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "ar-SA";
  utter.rate = rate;
  if (cachedArabicVoice) utter.voice = cachedArabicVoice;
  utter.onstart = () => onStart && onStart();
  utter.onend = () => onEnd && onEnd();
  utter.onerror = () => onError && onError("speech-error");
  window.speechSynthesis.speak(utter);
}

/* ============================================================
   RECITATION AUDIO (real Qari recitation, per ayah)
   Streams actual recitation from everyayah.com's public Quran
   audio CDN — the same source many open-source Quran apps use —
   keyed by surah:ayah number. Tries a first verified human
   reciter, and if that clip fails to load, tries a second. If
   neither loads, playback reports an error so the UI can offer a
   retry — it NEVER falls back to a synthesized voice for actual
   Quran recitation; text-to-speech is not an acceptable substitute
   for a real Qari's recitation.
   ============================================================ */
// Always-available fallback chain — every one of these is tried, in
// order, for any ayah, regardless of tier or selection, so playback
// never just goes silent because a preferred reciter's clip for one
// specific ayah happens to 404. Folder names verified directly
// against everyayah.com's own reciter listing (recitations_pages.html),
// never guessed.
const RECITERS = [
  { id: "Alafasy_128kbps", label: "Mishary Rashid Alafasy" },
  { id: "Husary_128kbps", label: "Mahmoud Khalil Al-Husary" },
];
// Additional reciters a premium account can pick as their PREFERRED
// one (tried first, ahead of the RECITERS fallback chain above,
// which still runs afterward as a safety net either way). Free
// accounts always get RECITERS[0] (Alafasy) as their fixed default —
// same real audio infrastructure, just no choice of voice.
const PREMIUM_RECITERS = [
  { id: "Abdul_Basit_Murattal_192kbps", label: "Abdul Basit Abdus Samad" },
  { id: "Minshawy_Murattal_128kbps", label: "Mohamed Siddiq Al-Minshawi" },
  { id: "Abdurrahmaan_As-Sudais_192kbps", label: "Abdur-Rahman As-Sudais" },
  { id: "Saood_ash-Shuraym_128kbps", label: "Saud Ash-Shuraym" },
];
const ALL_RECITERS = [...RECITERS, ...PREMIUM_RECITERS];
const sharedRecitationAudio = typeof Audio !== "undefined" ? new Audio() : null;
let onRecitationEnd = null; // current listener, so switching clips resets prior UI state

function pad3(n) {
  return String(n).padStart(3, "0");
}

function ayahAudioUrl(reciterId, surahId, ayahNum) {
  return `https://everyayah.com/data/${reciterId}/${pad3(surahId)}${pad3(ayahNum)}.mp3`;
}

// Plays real recitation for a given ayah, trying each verified
// reciter in RECITERS in turn. Reports state via callbacks so the
// calling button can swap its icon; onError fires only once every
// reciter has failed — at that point nothing plays.
// `preferredReciterId` (optional): tried first, ahead of the normal
// RECITERS fallback chain, which still always runs afterward as a
// safety net — a preferred reciter never having a clip for one
// specific ayah should never mean silence, just a fallback voice
// for that one ayah.
function playRecitation({ surahId, ayahNum, preferredReciterId, onStart, onDuration, onEnd, onError }) {
  if (!sharedRecitationAudio) {
    onError && onError();
    return;
  }
  stopRecitation(); // clears any previous listener/playing state first

  const preferred = preferredReciterId ? ALL_RECITERS.find((r) => r.id === preferredReciterId) : null;
  const attemptOrder = preferred
    ? [preferred, ...RECITERS.filter((r) => r.id !== preferred.id)]
    : RECITERS;

  let reciterIdx = 0;
  const attempt = () => {
    if (reciterIdx >= attemptOrder.length) {
      onRecitationEnd = null;
      onEnd && onEnd();
      onError && onError();
      return;
    }
    const reciter = attemptOrder[reciterIdx];
    sharedRecitationAudio.src = ayahAudioUrl(reciter.id, surahId, ayahNum);

    const finish = () => {
      if (onRecitationEnd === finish) onRecitationEnd = null;
      onEnd && onEnd();
    };
    const tryNext = () => {
      reciterIdx += 1;
      attempt();
    };

    sharedRecitationAudio.onended = finish;
    sharedRecitationAudio.onerror = tryNext;
    onRecitationEnd = finish;

    if (onDuration) {
      // Real ayah audio's actual length — used (as an estimate, not
      // exact per-word timing, which this single continuous file
      // doesn't expose) to schedule proportional word-highlight
      // timing so the karaoke effect works on the natural, fluent
      // recitation instead of only on isolated per-word clips.
      const reportDuration = () => {
        if (Number.isFinite(sharedRecitationAudio.duration)) onDuration(sharedRecitationAudio.duration);
      };
      if (Number.isFinite(sharedRecitationAudio.duration)) reportDuration();
      else sharedRecitationAudio.addEventListener("loadedmetadata", reportDuration, { once: true });
    }

    const playPromise = sharedRecitationAudio.play();
    if (playPromise?.then) {
      playPromise.then(() => onStart && onStart(reciter)).catch(tryNext);
    } else {
      onStart && onStart(reciter);
    }
  };
  attempt();
}

function stopRecitation() {
  if (onRecitationEnd) {
    const prevEnd = onRecitationEnd;
    onRecitationEnd = null;
    prevEnd && prevEnd();
  }
  if (sharedRecitationAudio && !sharedRecitationAudio.paused) {
    sharedRecitationAudio.pause();
  }
}

// Plays a contiguous range of ayat back-to-back (reusing
// playRecitation per-ayah — no separate audio pipeline), optionally
// looping the whole range multiple times. Used by memorization's
// "listen a few times, then recall" step, where a chunk is 1-3
// ayat. Returns a `cancel()` function so the caller (e.g. the user
// tapping "stop" or leaving the screen) can interrupt mid-sequence.
function playRecitationRange({ surahId, ayahStart, ayahEnd, loops = 1, preferredReciterId, onLoopStart, onAyahStart, onEnd, onError }) {
  let cancelled = false;
  let loopsDone = 0;

  function playOneLoop() {
    if (cancelled) return;
    onLoopStart && onLoopStart(loopsDone + 1);
    let ayahNum = ayahStart;
    let sawError = false;
    const playNextAyah = () => {
      if (cancelled) return;
      if (ayahNum > ayahEnd) {
        loopsDone += 1;
        if (sawError) { onError && onError(); return; }
        if (loopsDone >= loops) { onEnd && onEnd(); return; }
        playOneLoop();
        return;
      }
      // Note: playRecitation calls BOTH onEnd and onError when every
      // reciter fails for an ayah — so advancement must happen only
      // in onEnd (always fires) and onError must only record the
      // failure flag, never advance, or this would skip an ayah.
      const thisAyah = ayahNum;
      playRecitation({
        surahId, ayahNum, preferredReciterId,
        onDuration: onAyahStart ? (duration) => onAyahStart(thisAyah, duration) : undefined,
        onEnd: () => { ayahNum += 1; playNextAyah(); },
        onError: () => { sawError = true; },
      });
    };
    playNextAyah();
  }

  playOneLoop();
  return () => { cancelled = true; stopRecitation(); };
}

/* ============================================================
   WORD-LEVEL RECITATION AUDIO (tap-a-word, Discover it step)
   Streams real per-word recitation clips from QuranWBW's public
   word-by-word audio CDN, keyed by surah:ayah:word position —
   verified directly (fetched and confirmed as real audio/mpeg
   clips) rather than assumed. A tapped chunk plays each of its
   underlying Quran words back-to-back in order. Same rule as
   ayah playback: if the clip(s) fail to load, this reports an
   error for a retry — it never falls back to a synthesized voice
   for actual Quran text.
   ============================================================ */
const sharedWordAudio = typeof Audio !== "undefined" ? new Audio() : null;
let onWordAudioEnd = null;

function wordAudioUrl(surahId, ayahNum, wordNum) {
  return `https://audios.quranwbw.com/words/${surahId}/${pad3(surahId)}_${pad3(ayahNum)}_${pad3(wordNum)}.mp3?version=2`;
}

// Plays words [startWord..endWord] of a given ayah back-to-back.
// `rate` is the HTML Audio element's own playbackRate (1 = normal,
// <1 = slower, >1 = faster) — this changes tempo, not pitch quality,
// via the browser's built-in resampling, applied to the same real
// recitation clips (not a different, synthesized source).
function playWordRange({ surahId, ayahNum, startWord, endWord, rate = 1, onStart, onEnd, onError }) {
  if (!sharedWordAudio) {
    onError && onError();
    return;
  }
  stopWordAudio();

  let word = startWord;
  const advance = () => {
    if (word > endWord) {
      onWordAudioEnd = null;
      onEnd && onEnd();
      return;
    }
    sharedWordAudio.src = wordAudioUrl(surahId, ayahNum, word);
    sharedWordAudio.playbackRate = rate;

    const finish = () => {
      if (onWordAudioEnd === finish) onWordAudioEnd = null;
      onEnd && onEnd();
    };
    const playNextWord = () => {
      word += 1;
      advance();
    };
    const fail = () => {
      onWordAudioEnd = null;
      onEnd && onEnd();
      onError && onError();
    };

    sharedWordAudio.onended = playNextWord;
    sharedWordAudio.onerror = fail;
    onWordAudioEnd = finish;

    const playPromise = sharedWordAudio.play();
    if (playPromise?.then) {
      playPromise.then(() => onStart && onStart()).catch(fail);
    } else {
      onStart && onStart();
    }
  };
  advance();
}

function stopWordAudio() {
  if (onWordAudioEnd) {
    const prevEnd = onWordAudioEnd;
    onWordAudioEnd = null;
    prevEnd && prevEnd();
  }
  if (sharedWordAudio && !sharedWordAudio.paused) {
    sharedWordAudio.pause();
  }
}

/* ============================================================
   PHRASE AUDIO (real recorded audio for non-Quran phrases, e.g.
   salah dhikr from Hisn al-Muslim). Same shape as the Quran
   players — verified real recordings, reports state via
   callbacks, and never falls back to a synthesized voice on
   failure; it just reports an error for a retry.
   ============================================================ */
const sharedPhraseAudio = typeof Audio !== "undefined" ? new Audio() : null;
let onPhraseAudioEnd = null;

// startTime/endTime (optional): play only that window of the source
// recording instead of the whole file — used to isolate just the
// relevant phrase inside a longer multi-narration clip (see
// SALAH_MODULES' audioStart/audioEnd).
function playPhraseAudio(url, { startTime = 0, endTime, onStart, onEnd, onError } = {}) {
  if (!sharedPhraseAudio) {
    onError && onError();
    return;
  }
  stopPhraseAudio();
  sharedPhraseAudio.onloadedmetadata = null;
  sharedPhraseAudio.src = url;

  const finish = () => {
    if (onPhraseAudioEnd === finish) onPhraseAudioEnd = null;
    sharedPhraseAudio.ontimeupdate = null;
    onEnd && onEnd();
  };
  const fail = () => {
    onPhraseAudioEnd = null;
    sharedPhraseAudio.ontimeupdate = null;
    onEnd && onEnd();
    onError && onError();
  };

  sharedPhraseAudio.onended = finish;
  sharedPhraseAudio.onerror = fail;
  sharedPhraseAudio.ontimeupdate = endTime
    ? () => { if (sharedPhraseAudio.currentTime >= endTime) { sharedPhraseAudio.pause(); finish(); } }
    : null;
  onPhraseAudioEnd = finish;

  const beginPlayback = () => {
    sharedPhraseAudio.currentTime = startTime;
    const playPromise = sharedPhraseAudio.play();
    if (playPromise?.then) {
      playPromise.then(() => onStart && onStart()).catch(fail);
    } else {
      onStart && onStart();
    }
  };

  // Seeking works reliably only once the browser knows the file's
  // duration/metadata — for a fresh src that hasn't loaded yet, wait
  // for it rather than seeking immediately (which some browsers ignore).
  if (startTime > 0 && sharedPhraseAudio.readyState < 1) {
    sharedPhraseAudio.onloadedmetadata = beginPlayback;
  } else {
    beginPlayback();
  }
}

function stopPhraseAudio() {
  if (onPhraseAudioEnd) {
    const prevEnd = onPhraseAudioEnd;
    onPhraseAudioEnd = null;
    prevEnd && prevEnd();
  }
  if (sharedPhraseAudio) {
    sharedPhraseAudio.ontimeupdate = null;
    sharedPhraseAudio.onloadedmetadata = null;
    if (!sharedPhraseAudio.paused) sharedPhraseAudio.pause();
  }
}

// Plays a list of real, verified clips back-to-back on the shared
// phrase-audio player — used for phrases with no single continuous
// recording (e.g. takbir), built entirely from real per-word audio
// rather than any synthesized voice.
function playAudioSequence(urls, { onStart, onEnd, onError } = {}) {
  if (!sharedPhraseAudio || !urls?.length) {
    onError && onError();
    return;
  }
  stopPhraseAudio();
  let idx = 0;
  const finish = () => {
    if (onPhraseAudioEnd === finish) onPhraseAudioEnd = null;
    onEnd && onEnd();
  };
  const fail = () => {
    onPhraseAudioEnd = null;
    onEnd && onEnd();
    onError && onError();
  };
  const playNext = () => {
    if (idx >= urls.length) { finish(); return; }
    sharedPhraseAudio.ontimeupdate = null;
    sharedPhraseAudio.onloadedmetadata = null;
    sharedPhraseAudio.src = urls[idx];
    sharedPhraseAudio.onended = () => { idx += 1; playNext(); };
    sharedPhraseAudio.onerror = fail;
    onPhraseAudioEnd = finish;
    const playPromise = sharedPhraseAudio.play();
    if (playPromise?.then) {
      playPromise.then(() => idx === 0 && onStart && onStart()).catch(fail);
    } else if (idx === 0) {
      onStart && onStart();
    }
  };
  playNext();
}

// Plays a resolved audio descriptor — { kind: "word"|"phrase", url,
// start?, end? } or { kind: "quranWord", surahId, ayahNum, start,
// end } — the same shape LessonFlow's resolveChunkAudio produces.
// Used anywhere a previously-tapped word gets replayed (the quiz
// prompt, Quick Review) so it always uses the same real audio
// source the original tap used, never the synthesized voice when a
// verified source exists.
function playResolvedAudio(audio, { onStart, onEnd, onError } = {}) {
  if (!audio) { onError && onError(); return; }
  if (audio.kind === "quranWord") {
    playWordRange({
      surahId: audio.surahId, ayahNum: audio.ayahNum,
      startWord: audio.start, endWord: audio.end,
      onStart, onEnd, onError,
    });
  } else {
    playPhraseAudio(audio.url, { startTime: audio.start, endTime: audio.end, onStart, onEnd, onError });
  }
}

function stopResolvedAudio() {
  stopWordAudio();
  stopPhraseAudio();
}

function PlayPauseIcon({ playing, size = 18, color = "#1A1305" }) {
  return playing ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function RetryIcon({ size = 18, color = "#1A1305" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M4 12a8 8 0 1 1 2.34 5.66M4 12V6M4 12h6"
        stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function SpeakerIcon({ size = 12, color, active }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M4 9v6h4l5 4V5L8 9H4z" fill={color} />
      <path
        d="M16.5 8.5a5 5 0 0 1 0 7"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity={active ? 1 : 0.55}
      />
    </svg>
  );
}

/* ============================================================
   SAMPLE CONTENT
   NOTE: Word/phrase meanings (`m` fields) are literal
   word-by-word glosses adapted from the Quranic Arabic Corpus
   (corpus.quran.com), used with attribution under its stated
   reuse terms — NOT a reproduction of any single clause-level
   translation (e.g. Sahih International, The Clear Quran). This
   is a deliberate switch away from an earlier draft that too
   closely paraphrased a licensed translation. `gist`/`connect`
   commentary is original writing for this app, not translation.
   The architecture still allows a licensed translation provider
   to be swapped in later without touching app logic.
   ============================================================ */

// A lightweight "translation provider" abstraction — swap this
// object for a licensed provider later without touching UI code.
const TRANSLATION_PROVIDER = {
  id: "corpus-quran-wbw-v1",
  label: "Word-by-word glosses adapted from the Quranic Arabic Corpus (corpus.quran.com)",
};

const ALL_SURAHS = [
  { id: 1, nameAr: "الفاتحة", nameEn: "Al-Fatihah", meaning: "The Opening", ayahCount: 7, revelation: "Meccan" },
  { id: 36, nameAr: "يس", nameEn: "Ya-Sin", meaning: "Ya Sin", ayahCount: 83, revelation: "Meccan" },
  { id: 55, nameAr: "الرحمن", nameEn: "Ar-Rahman", meaning: "The Most Merciful", ayahCount: 78, revelation: "Medinan" },
  { id: 56, nameAr: "الواقعة", nameEn: "Al-Waqi'ah", meaning: "The Inevitable", ayahCount: 96, revelation: "Meccan" },
  { id: 67, nameAr: "الملك", nameEn: "Al-Mulk", meaning: "The Sovereignty", ayahCount: 30, revelation: "Meccan" },
  { id: 97, nameAr: "القدر", nameEn: "Al-Qadr", meaning: "The Decree", ayahCount: 5, revelation: "Meccan" },
  { id: 103, nameAr: "العصر", nameEn: "Al-Asr", meaning: "The Time", ayahCount: 3, revelation: "Meccan" },
  { id: 105, nameAr: "الفيل", nameEn: "Al-Fil", meaning: "The Elephant", ayahCount: 5, revelation: "Meccan" },
  { id: 106, nameAr: "قريش", nameEn: "Quraysh", meaning: "Quraysh", ayahCount: 4, revelation: "Meccan" },
  { id: 108, nameAr: "الكوثر", nameEn: "Al-Kawthar", meaning: "Abundance", ayahCount: 3, revelation: "Meccan" },
  { id: 109, nameAr: "الكافرون", nameEn: "Al-Kafirun", meaning: "The Disbelievers", ayahCount: 6, revelation: "Meccan" },
  { id: 110, nameAr: "النصر", nameEn: "An-Nasr", meaning: "Divine Support", ayahCount: 3, revelation: "Medinan" },
  { id: 111, nameAr: "المسد", nameEn: "Al-Masad", meaning: "The Palm Fiber", ayahCount: 5, revelation: "Meccan" },
  { id: 112, nameAr: "الإخلاص", nameEn: "Al-Ikhlas", meaning: "Sincerity", ayahCount: 4, revelation: "Meccan" },
  { id: 113, nameAr: "الفلق", nameEn: "Al-Falaq", meaning: "The Daybreak", ayahCount: 5, revelation: "Meccan" },
  { id: 114, nameAr: "الناس", nameEn: "An-Nas", meaning: "Mankind", ayahCount: 6, revelation: "Meccan" },
  { id: 93, nameAr: "الضحى", nameEn: "Ad-Duha", meaning: "The Morning Brightness", ayahCount: 11, revelation: "Meccan" },
  { id: 94, nameAr: "الشرح", nameEn: "Ash-Sharh", meaning: "The Relief", ayahCount: 8, revelation: "Meccan" },
  { id: 99, nameAr: "الزلزلة", nameEn: "Az-Zalzalah", meaning: "The Earthquake", ayahCount: 8, revelation: "Medinan" },
  { id: 100, nameAr: "العاديات", nameEn: "Al-Adiyat", meaning: "The Chargers", ayahCount: 11, revelation: "Meccan" },
  { id: 101, nameAr: "القارعة", nameEn: "Al-Qari'ah", meaning: "The Striking Calamity", ayahCount: 11, revelation: "Meccan" },
  { id: 102, nameAr: "التكاثر", nameEn: "At-Takathur", meaning: "Competition for Increase", ayahCount: 8, revelation: "Meccan" },
  { id: 104, nameAr: "الهمزة", nameEn: "Al-Humazah", meaning: "The Slanderer", ayahCount: 9, revelation: "Meccan" },
  { id: 107, nameAr: "الماعون", nameEn: "Al-Ma'un", meaning: "Small Kindnesses", ayahCount: 7, revelation: "Meccan" },
];
// Remaining surahs exist as lightweight stubs so the architecture
// visibly supports all 114 without needing full content for each.
const STUB_IDS = Array.from({ length: 114 }, (_, i) => i + 1).filter(
  (id) => !ALL_SURAHS.find((s) => s.id === id)
);
const STUB_NAMES = {
  2: ["البقرة", "Al-Baqarah", "The Cow", 286],
  3: ["آل عمران", "Ali 'Imran", "The Family of Imran", 200],
  18: ["الكهف", "Al-Kahf", "The Cave", 110],
  36: ["يس", "Ya-Sin", "Ya Sin", 83],
};
const surahDirectory = [
  ...ALL_SURAHS,
  ...STUB_IDS.map((id) => {
    const known = STUB_NAMES[id];
    return {
      id,
      nameAr: known ? known[0] : "سورة",
      nameEn: known ? known[1] : `Surah ${id}`,
      meaning: known ? known[2] : "",
      ayahCount: known ? known[3] : "—",
      revelation: "—",
      stub: true,
    };
  }),
].sort((a, b) => a.id - b.id);

// Full ayah content, with chunk-level meanings, for a handful of surahs.
const AYAT = {
  1: [
    {
      n: 1,
      ar: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
      chunks: [
        { ar: "بِسْمِ", m: "In the name" },
        { ar: "اللَّهِ", m: "of Allah" },
        { ar: "الرَّحْمَٰنِ", m: "the Most Gracious" },
        { ar: "الرَّحِيمِ", m: "the Most Merciful" },
      ],
      gist: "You're opening with God's name and two of His names about mercy — this is why Muslims say it before almost anything.",
      connect: "Next time you start something — a meal, a task, salah — remember you're consciously placing it in the name of a Merciful God.",
    },
    {
      n: 2,
      ar: "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ",
      chunks: [
        { ar: "الْحَمْدُ", m: "All praise and thanks" },
        { ar: "لِلَّهِ", m: "(be) to Allah" },
        { ar: "رَبِّ", m: "the Lord" },
        { ar: "الْعَالَمِينَ", m: "of the universe" },
      ],
      gist: "You're acknowledging that every form of praise ultimately belongs to the One who sustains everything that exists.",
      connect: "When you say 'Alhamdulillah' in daily life, this ayah is the full idea behind that one word.",
    },
    {
      n: 3,
      ar: "الرَّحْمَٰنِ الرَّحِيمِ",
      chunks: [
        { ar: "الرَّحْمَٰنِ", m: "the Most Gracious" },
        { ar: "الرَّحِيمِ", m: "the Most Merciful" },
      ],
      gist: "Before anything else is asked of you, you're reminded twice that God's core nature toward you is mercy.",
      connect: "Whatever else happens in the surah, this sets the tone: mercy comes first.",
    },
    {
      n: 4,
      ar: "مَالِكِ يَوْمِ الدِّينِ",
      chunks: [
        { ar: "مَالِكِ", m: "The Master" },
        { ar: "يَوْمِ", m: "of the Day" },
        { ar: "الدِّينِ", m: "of Judgment" },
      ],
      gist: "You're affirming that ultimate accountability belongs to God alone, on a day that's coming.",
      connect: "This line is what keeps the mercy of the first two lines from becoming complacency — there's still a reckoning.",
    },
    {
      n: 5,
      ar: "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ",
      chunks: [
        { ar: "إِيَّاكَ نَعْبُدُ", m: "You Alone we worship" },
        { ar: "وَإِيَّاكَ نَسْتَعِينُ", m: "and You Alone we ask for help" },
      ],
      gist: "This is the hinge of the whole surah — you're speaking directly to God for the first time, pledging worship and help to Him alone.",
      connect: "You say this at least 17 times a day in salah. It's a standing renewal of who you rely on.",
    },
    {
      n: 6,
      ar: "اهْدِنَا الصِّرَاطَ الْمُسْتَقِيمَ",
      chunks: [
        { ar: "اهْدِنَا", m: "Guide us" },
        { ar: "الصِّرَاطَ", m: "(to) the path" },
        { ar: "الْمُسْتَقِيمَ", m: "the straight" },
      ],
      gist: "You're asking, plainly, to be kept on the right path — not just to find it once, but to stay on it.",
      connect: "This is the core request of the whole surah — everything before it was setting up who you're asking, and this is what you ask for.",
    },
    {
      n: 7,
      ar: "صِرَاطَ الَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ وَلَا الضَّالِّينَ",
      chunks: [
        { ar: "صِرَاطَ الَّذِينَ أَنْعَمْتَ عَلَيْهِمْ", m: "the path of those You have bestowed Favor on" },
        { ar: "غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ", m: "not (of) those who earned wrath on themselves" },
        { ar: "وَلَا الضَّالِّينَ", m: "and not (of) those who go astray" },
      ],
      gist: "You're defining the straight path by example — people who were guided rightly — and by contrast, two ways of going wrong.",
      connect: "This ayah gives you a mental picture every time you ask for guidance: not just 'a good path,' but the path of those who got it right.",
    },
  ],
  112: [
    {
      n: 1,
      ar: "قُلْ هُوَ اللَّهُ أَحَدٌ",
      chunks: [
        { ar: "قُلْ", m: "Say" },
        { ar: "هُوَ اللَّهُ", m: "He, Allah" },
        { ar: "أَحَدٌ", m: "(is) the One" },
      ],
      gist: "You're commanded to state plainly, when asked who God is, that He is absolutely One.",
      connect: "This is the ayah worth a third of the Quran in reward — it's the single clearest statement of monotheism in the whole book.",
    },
    {
      n: 2,
      ar: "اللَّهُ الصَّمَدُ",
      chunks: [
        { ar: "اللَّهُ", m: "Allah" },
        { ar: "الصَّمَدُ", m: "the Eternal, the Absolute — needed by all, needing none" },
      ],
      gist: "Everything depends on Him; He depends on nothing.",
      connect: "Whenever you feel dependent on people or circumstances, this word describes the one thing that isn't dependent on anything.",
    },
    {
      n: 3,
      ar: "لَمْ يَلِدْ وَلَمْ يُولَدْ",
      chunks: [
        { ar: "لَمْ يَلِدْ", m: "Not He begets" },
        { ar: "وَلَمْ يُولَدْ", m: "and not He is begotten" },
      ],
      gist: "He has no offspring and no origin — He's outside the category of things that are born or reproduce.",
      connect: "This directly rules out any claim that God has a literal child.",
    },
    {
      n: 4,
      ar: "وَلَمْ يَكُنْ لَهُ كُفُوًا أَحَدٌ",
      chunks: [
        { ar: "وَلَمْ يَكُنْ لَهُ", m: "and not is for Him" },
        { ar: "كُفُوًا أَحَدٌ", m: "equivalent any [one]" },
      ],
      gist: "Nothing and no one is comparable to Him in any way.",
      connect: "This closes the surah the way it opened — with total, uncompromised oneness.",
    },
  ],
  114: [
    { n: 1, ar: "قُلْ أَعُوذُ بِرَبِّ النَّاسِ", chunks: [{ ar: "قُلْ", m: "Say" }, { ar: "أَعُوذُ", m: "I seek refuge" }, { ar: "بِرَبِّ النَّاسِ", m: "in the Lord of mankind" }], gist: "You're opening a plea for protection by naming exactly who you're turning to.", connect: "Say this consciously, not just by habit, the next time you recite it." },
    { n: 2, ar: "مَلِكِ النَّاسِ", chunks: [{ ar: "مَلِكِ", m: "the King" }, { ar: "النَّاسِ", m: "of mankind" }], gist: "You're naming Him again, this time as the true King over people.", connect: "Three names in a row for God — Lord, King, God — each ruling out a different kind of false authority." },
    { n: 3, ar: "إِلَٰهِ النَّاسِ", chunks: [{ ar: "إِلَٰهِ", m: "the God" }, { ar: "النَّاسِ", m: "of mankind" }], gist: "And the God that people actually worship, whether they realize it or not.", connect: "This sets up who has the power to protect you, right before naming the threat." },
    { n: 4, ar: "مِنْ شَرِّ الْوَسْوَاسِ الْخَنَّاسِ", chunks: [{ ar: "مِنْ شَرِّ", m: "from (the) evil" }, { ar: "الْوَسْوَاسِ الْخَنَّاسِ", m: "of the whisperer, the one who withdraws" }], gist: "You're asking for protection specifically from a whisperer that slinks back whenever you remember God.", connect: "Notice 'withdraws' — the whisper isn't described as unstoppable, just persistent when you forget." },
    { n: 5, ar: "الَّذِي يُوَسْوِسُ فِي صُدُورِ النَّاسِ", chunks: [{ ar: "الَّذِي يُوَسْوِسُ", m: "the one who whispers" }, { ar: "فِي صُدُورِ النَّاسِ", m: "in the breasts of mankind" }], gist: "The location of the whisper is named — inside you, not some external event.", connect: "This reframes intrusive, unwanted thoughts as something you can seek refuge from, not something that defines you." },
    { n: 6, ar: "مِنَ الْجِنَّةِ وَالنَّاسِ", chunks: [{ ar: "مِنَ الْجِنَّةِ", m: "from the jinn" }, { ar: "وَالنَّاسِ", m: "and men" }], gist: "The whisperer can be unseen or a person — either way, the same refuge applies.", connect: "This is why the surah is recited against both supernatural harm and harmful people." },
  ],
  67: [
    {
      n: 1,
      ar: "تَبَارَكَ الَّذِي بِيَدِهِ الْمُلْكُ وَهُوَ عَلَىٰ كُلِّ شَيْءٍ قَدِيرٌ",
      chunks: [
        { ar: "تَبَارَكَ", m: "Blessed is" },
        { ar: "الَّذِي بِيَدِهِ الْمُلْكُ", m: "He in Whose Hand is the Dominion" },
        { ar: "وَهُوَ عَلَىٰ كُلِّ شَيْءٍ قَدِيرٌ", m: "and He is over every thing All-Powerful" },
      ],
      gist: "The surah opens by placing all real authority in one place — and pairing it immediately with total capability.",
      connect: "Whenever something feels out of your control, this is the ayah that names exactly whose hand it's actually in.",
    },
  ],
  97: [
    {
      n: 1,
      ar: "إِنَّا أَنزَلْنَاهُ فِي لَيْلَةِ الْقَدْرِ",
      chunks: [
        { ar: "إِنَّا أَنزَلْنَاهُ", m: "Indeed We sent it down" },
        { ar: "فِي لَيْلَةِ الْقَدْرِ", m: "on the Night of Power" },
      ],
      gist: "You're being told exactly when the Quran's revelation began — on one specific, named night.",
      connect: "This is why Muslims search for Laylat al-Qadr in Ramadan's last ten nights — this ayah is the reason it matters.",
    },
    {
      n: 2,
      ar: "وَمَا أَدْرَاكَ مَا لَيْلَةُ الْقَدْرِ",
      chunks: [
        { ar: "وَمَا أَدْرَاكَ", m: "And what will make you realize" },
        { ar: "مَا لَيْلَةُ الْقَدْرِ", m: "what the Night of Power is" },
      ],
      gist: "Even the Prophet is asked this rhetorically — the night's value is set up as beyond ordinary comprehension.",
      connect: "When the Quran introduces something this way, it's a signal: pay close attention, what follows is enormous.",
    },
    {
      n: 3,
      ar: "لَيْلَةُ الْقَدْرِ خَيْرٌ مِّنْ أَلْفِ شَهْرٍ",
      chunks: [
        { ar: "لَيْلَةُ الْقَدْرِ", m: "The Night of Power" },
        { ar: "خَيْرٌ مِّنْ أَلْفِ شَهْرٍ", m: "is better than a thousand months" },
      ],
      gist: "One night outweighs over 83 years of ordinary worship — that's the scale being described.",
      connect: "A single night of sincere worship in this window can outweigh a lifetime of missed opportunity.",
    },
    {
      n: 4,
      ar: "تَنَزَّلُ الْمَلَائِكَةُ وَالرُّوحُ فِيهَا بِإِذْنِ رَبِّهِم مِّن كُلِّ أَمْرٍ",
      chunks: [
        { ar: "تَنَزَّلُ الْمَلَائِكَةُ وَالرُّوحُ", m: "The angels and the Spirit descend" },
        { ar: "فِيهَا بِإِذْنِ رَبِّهِم", m: "during it, by their Lord's permission" },
        { ar: "مِّن كُلِّ أَمْرٍ", m: "for every matter" },
      ],
      gist: "You're told the angels themselves descend that night, carrying out decrees by God's permission.",
      connect: "It's not just a symbolically important night — something is actually happening, unseen, while you worship.",
    },
    {
      n: 5,
      ar: "سَلَامٌ هِيَ حَتَّىٰ مَطْلَعِ الْفَجْرِ",
      chunks: [
        { ar: "سَلَامٌ هِيَ", m: "Peace it is" },
        { ar: "حَتَّىٰ مَطْلَعِ الْفَجْرِ", m: "until the emergence of dawn" },
      ],
      gist: "The whole night is described in one word above all others — peace — lasting until sunrise.",
      connect: "That's the feeling this night is meant to leave you with: peace, start to finish.",
    },
  ],
  103: [
    {
      n: 1,
      ar: "وَالْعَصْرِ",
      chunks: [
        { ar: "وَالْعَصْرِ", m: "By time" },
      ],
      gist: "God opens by swearing an oath on time itself — a resource you can't get back.",
      connect: "Whenever you feel like you have endless time, this is the ayah that opens by reminding you otherwise.",
    },
    {
      n: 2,
      ar: "إِنَّ الْإِنسَانَ لَفِي خُسْرٍ",
      chunks: [
        { ar: "إِنَّ الْإِنسَانَ", m: "Indeed mankind" },
        { ar: "لَفِي خُسْرٍ", m: "is in loss" },
      ],
      gist: "The default state of a human being, without anything more, is described as loss.",
      connect: "This isn't pessimism — it's the setup for the next ayah, which is the way out.",
    },
    {
      n: 3,
      ar: "إِلَّا الَّذِينَ آمَنُوا وَعَمِلُوا الصَّالِحَاتِ وَتَوَاصَوْا بِالْحَقِّ وَتَوَاصَوْا بِالصَّبْرِ",
      chunks: [
        { ar: "إِلَّا الَّذِينَ آمَنُوا", m: "except those who believe" },
        { ar: "وَعَمِلُوا الصَّالِحَاتِ", m: "and do righteous deeds" },
        { ar: "وَتَوَاصَوْا بِالْحَقِّ", m: "and advise each other to truth" },
        { ar: "وَتَوَاصَوْا بِالصَّبْرِ", m: "and advise each other to patience" },
      ],
      gist: "Four things pull you out of that default loss — belief, action, and two kinds of mutual encouragement.",
      connect: "Notice it's not just personal — advising others toward truth and patience is part of the way out too.",
    },
  ],
  105: [
    {
      n: 1,
      ar: "أَلَمْ تَرَ كَيْفَ فَعَلَ رَبُّكَ بِأَصْحَابِ الْفِيلِ",
      chunks: [
        { ar: "أَلَمْ تَرَ", m: "Have you not seen" },
        { ar: "كَيْفَ فَعَلَ رَبُّكَ", m: "how your Lord dealt" },
        { ar: "بِأَصْحَابِ الْفِيلِ", m: "with the companions of the elephant" },
      ],
      gist: "You're pointed to a real historical event as proof — an army with elephants that attacked the Kaaba.",
      connect: "This surah opens like a reminder of something the listener would already know — history as evidence.",
    },
    {
      n: 2,
      ar: "أَلَمْ يَجْعَلْ كَيْدَهُمْ فِي تَضْلِيلٍ",
      chunks: [
        { ar: "أَلَمْ يَجْعَلْ كَيْدَهُمْ", m: "Did He not make their plan" },
        { ar: "فِي تَضْلِيلٍ", m: "go astray" },
      ],
      gist: "Their scheme, however powerful it looked, was made to fail completely.",
      connect: "Whatever plan looks unstoppable to you, this ayah is a reminder of how easily God can unravel it.",
    },
    {
      n: 3,
      ar: "وَأَرْسَلَ عَلَيْهِمْ طَيْرًا أَبَابِيلَ",
      chunks: [
        { ar: "وَأَرْسَلَ عَلَيْهِمْ", m: "And He sent against them" },
        { ar: "طَيْرًا أَبَابِيلَ", m: "flocks of birds" },
      ],
      gist: "The response to a massive army wasn't another army — it was birds.",
      connect: "Notice the scale mismatch — that's the point of the whole story.",
    },
    {
      n: 4,
      ar: "تَرْمِيهِم بِحِجَارَةٍ مِّن سِجِّيلٍ",
      chunks: [
        { ar: "تَرْمِيهِم بِحِجَارَةٍ", m: "Pelting them with stones" },
        { ar: "مِّن سِجِّيلٍ", m: "of hard baked clay" },
      ],
      gist: "The birds carried small stones, and that alone was enough.",
      connect: "God's help doesn't need to look impressive to be devastating.",
    },
    {
      n: 5,
      ar: "فَجَعَلَهُمْ كَعَصْفٍ مَّأْكُولٍ",
      chunks: [
        { ar: "فَجَعَلَهُمْ", m: "And He made them" },
        { ar: "كَعَصْفٍ مَّأْكُولٍ", m: "like eaten straw" },
      ],
      gist: "The army that came to destroy the Kaaba ended up like husks stripped bare.",
      connect: "This is the image the surah leaves you with — total, humiliating defeat of overwhelming force.",
    },
  ],
  106: [
    {
      n: 1,
      ar: "لِإِيلَافِ قُرَيْشٍ",
      chunks: [
        { ar: "لِإِيلَافِ", m: "For the accustomed security of" },
        { ar: "قُرَيْشٍ", m: "Quraysh" },
      ],
      gist: "The surah opens naming the tribe of Quraysh and the security/familiarity they were given.",
      connect: "This surah reads almost like a direct continuation of Al-Fil — the elephant army was stopped so Quraysh could keep this.",
    },
    {
      n: 2,
      ar: "إِيلَافِهِمْ رِحْلَةَ الشِّتَاءِ وَالصَّيْفِ",
      chunks: [
        { ar: "إِيلَافِهِمْ", m: "their accustomed" },
        { ar: "رِحْلَةَ الشِّتَاءِ", m: "winter journey" },
        { ar: "وَالصَّيْفِ", m: "and summer" },
      ],
      gist: "Specifically, their safe trade journeys — winter south, summer north — are what's being pointed to.",
      connect: "An entire economy's safety is credited here to God's protection, not their own strength.",
    },
    {
      n: 3,
      ar: "فَلْيَعْبُدُوا رَبَّ هَٰذَا الْبَيْتِ",
      chunks: [
        { ar: "فَلْيَعْبُدُوا", m: "So let them worship" },
        { ar: "رَبَّ هَٰذَا الْبَيْتِ", m: "the Lord of this House" },
      ],
      gist: "Given all that security, the natural response asked of them is simple: worship the One who gave it.",
      connect: "The logic is direct — you were protected, so worship the Protector.",
    },
    {
      n: 4,
      ar: "الَّذِي أَطْعَمَهُم مِّن جُوعٍ وَآمَنَهُم مِّنْ خَوْفٍ",
      chunks: [
        { ar: "الَّذِي أَطْعَمَهُم مِّن جُوعٍ", m: "who fed them against hunger" },
        { ar: "وَآمَنَهُم مِّنْ خَوْفٍ", m: "and secured them from fear" },
      ],
      gist: "Two specific blessings are named as the reason: food security and safety from fear.",
      connect: "Next time you eat a meal without worry, this is the ayah that names exactly what that is — a gift, not a given.",
    },
  ],
  108: [
    {
      n: 1,
      ar: "إِنَّا أَعْطَيْنَاكَ الْكَوْثَرَ",
      chunks: [
        { ar: "إِنَّا أَعْطَيْنَاكَ", m: "Indeed We have given you" },
        { ar: "الْكَوْثَرَ", m: "abundance" },
      ],
      gist: "God opens by directly telling the Prophet he's been given abundant good.",
      connect: "This surah was revealed to comfort him after loss — it opens with a gift, not a complaint answered.",
    },
    {
      n: 2,
      ar: "فَصَلِّ لِرَبِّكَ وَانْحَرْ",
      chunks: [
        { ar: "فَصَلِّ لِرَبِّكَ", m: "So pray to your Lord" },
        { ar: "وَانْحَرْ", m: "and sacrifice" },
      ],
      gist: "The response to being given abundance is worship and sacrifice — not pride.",
      connect: "Whenever you're given something good, this is the model response: turn back to God with it, don't turn away.",
    },
    {
      n: 3,
      ar: "إِنَّ شَانِئَكَ هُوَ الْأَبْتَرُ",
      chunks: [
        { ar: "إِنَّ شَانِئَكَ", m: "Indeed your enemy" },
        { ar: "هُوَ الْأَبْتَرُ", m: "he is the one cut off" },
      ],
      gist: "Those who mocked the Prophet as having no legacy are told the opposite is true of them.",
      connect: "This surah's whole shape is comfort in three short lines — gift, response, and reassurance.",
    },
  ],
  109: [
    {
      n: 1,
      ar: "قُلْ يَا أَيُّهَا الْكَافِرُونَ",
      chunks: [
        { ar: "قُلْ", m: "Say" },
        { ar: "يَا أَيُّهَا الْكَافِرُونَ", m: "O disbelievers" },
      ],
      gist: "You're told exactly how to address people who reject faith — directly, by naming their position.",
      connect: "This is a direct address, meant to be said out loud — try reciting it as if speaking to someone.",
    },
    {
      n: 2,
      ar: "لَا أَعْبُدُ مَا تَعْبُدُونَ",
      chunks: [
        { ar: "لَا أَعْبُدُ", m: "I do not worship" },
        { ar: "مَا تَعْبُدُونَ", m: "what you worship" },
      ],
      gist: "A clear, personal line is drawn — no shared worship.",
      connect: "Notice the directness — no hedging, no partial agreement.",
    },
    {
      n: 3,
      ar: "وَلَا أَنتُمْ عَابِدُونَ مَا أَعْبُدُ",
      chunks: [
        { ar: "وَلَا أَنتُمْ عَابِدُونَ", m: "nor are you worshippers" },
        { ar: "مَا أَعْبُدُ", m: "of what I worship" },
      ],
      gist: "The same line is drawn back the other way — it's mutual, not one-sided.",
      connect: "This surah repeats itself almost like a refrain — that repetition is the point, not redundancy.",
    },
    {
      n: 4,
      ar: "وَلَا أَنَا عَابِدٌ مَّا عَبَدتُّمْ",
      chunks: [
        { ar: "وَلَا أَنَا عَابِدٌ", m: "nor will I worship" },
        { ar: "مَّا عَبَدتُّمْ", m: "what you have worshipped" },
      ],
      gist: "The declaration is repeated again, this time about the past — reinforcing there's no compromise.",
      connect: "Four times in six ayahs, the same boundary gets restated — that's how seriously it's meant.",
    },
    {
      n: 5,
      ar: "وَلَا أَنتُمْ عَابِدُونَ مَا أَعْبُدُ",
      chunks: [
        { ar: "وَلَا أَنتُمْ عَابِدُونَ", m: "nor will you worship" },
        { ar: "مَا أَعْبُدُ", m: "what I worship" },
      ],
      gist: "The mutual boundary is restated once more, sealing that this isn't a one-time comment.",
      connect: "By now the rhythm itself is teaching you something: some lines don't get renegotiated.",
    },
    {
      n: 6,
      ar: "لَكُمْ دِينُكُمْ وَلِيَ دِينِ",
      chunks: [
        { ar: "لَكُمْ دِينُكُمْ", m: "For you is your religion" },
        { ar: "وَلِيَ دِينِ", m: "and for me is my religion" },
      ],
      gist: "The surah closes with peaceful coexistence, not conflict — each keeps their own way.",
      connect: "This is one of Islam's clearest statements on religious coexistence — difference without forced conversion.",
    },
  ],
  110: [
    {
      n: 1,
      ar: "إِذَا جَاءَ نَصْرُ اللَّهِ وَالْفَتْحُ",
      chunks: [
        { ar: "إِذَا جَاءَ", m: "When there comes" },
        { ar: "نَصْرُ اللَّهِ وَالْفَتْحُ", m: "the help of Allah and victory" },
      ],
      gist: "You're told to expect a moment when divine help and victory arrive together.",
      connect: "This surah is widely understood to have signaled the Prophet's life was nearing its end — victory as a closing, not just a beginning.",
    },
    {
      n: 2,
      ar: "وَرَأَيْتَ النَّاسَ يَدْخُلُونَ فِي دِينِ اللَّهِ أَفْوَاجًا",
      chunks: [
        { ar: "وَرَأَيْتَ النَّاسَ", m: "and you see the people" },
        { ar: "يَدْخُلُونَ فِي دِينِ اللَّهِ", m: "entering the religion of Allah" },
        { ar: "أَفْوَاجًا", m: "in crowds" },
      ],
      gist: "The visible sign of that help is people entering the faith not one at a time, but in crowds.",
      connect: "This describes a specific historical shift — mass conversions after Mecca's peaceful conquest.",
    },
    {
      n: 3,
      ar: "فَسَبِّحْ بِحَمْدِ رَبِّكَ وَاسْتَغْفِرْهُ إِنَّهُ كَانَ تَوَّابًا",
      chunks: [
        { ar: "فَسَبِّحْ بِحَمْدِ رَبِّكَ", m: "So glorify your Lord with praise" },
        { ar: "وَاسْتَغْفِرْهُ", m: "and seek His forgiveness" },
        { ar: "إِنَّهُ كَانَ تَوَّابًا", m: "indeed He is ever Accepting of repentance" },
      ],
      gist: "Instead of celebration, the response to success is told to be glorification and seeking forgiveness.",
      connect: "At the height of success is exactly when this surah tells you to turn back to God, not away from Him.",
    },
  ],
  111: [
    {
      n: 1,
      ar: "تَبَّتْ يَدَا أَبِي لَهَبٍ وَتَبَّ",
      chunks: [
        { ar: "تَبَّتْ يَدَا أَبِي لَهَبٍ", m: "Perished are the hands of Abu Lahab" },
        { ar: "وَتَبَّ", m: "and he has perished" },
      ],
      gist: "The surah opens by naming a real person directly and pronouncing his ruin.",
      connect: "This is the only surah that names a specific opponent of the Prophet by name — that's how serious his hostility was.",
    },
    {
      n: 2,
      ar: "مَا أَغْنَىٰ عَنْهُ مَالُهُ وَمَا كَسَبَ",
      chunks: [
        { ar: "مَا أَغْنَىٰ عَنْهُ", m: "Did not benefit him" },
        { ar: "مَالُهُ وَمَا كَسَبَ", m: "his wealth and what he earned" },
      ],
      gist: "All his money and everything he worked for is stated to have done him no good.",
      connect: "Whatever you're accumulating, this ayah is a reminder of what it can't buy you out of.",
    },
    {
      n: 3,
      ar: "سَيَصْلَىٰ نَارًا ذَاتَ لَهَبٍ",
      chunks: [
        { ar: "سَيَصْلَىٰ نَارًا", m: "He will burn in a Fire" },
        { ar: "ذَاتَ لَهَبٍ", m: "of flame" },
      ],
      gist: "His fate is stated plainly and directly — a blazing fire.",
      connect: "There's a wordplay here worth noticing — his name meant \"father of flame,\" and his fate matches his name.",
    },
    {
      n: 4,
      ar: "وَامْرَأَتُهُ حَمَّالَةَ الْحَطَبِ",
      chunks: [
        { ar: "وَامْرَأَتُهُ", m: "And his wife" },
        { ar: "حَمَّالَةَ الْحَطَبِ", m: "carrier of firewood" },
      ],
      gist: "His wife, who actively supported his hostility, is named in the same condemnation.",
      connect: "This makes clear that supporting harm isn't a passive role — she's held responsible too.",
    },
    {
      n: 5,
      ar: "فِي جِيدِهَا حَبْلٌ مِّن مَّسَدٍ",
      chunks: [
        { ar: "فِي جِيدِهَا", m: "Around her neck" },
        { ar: "حَبْلٌ مِّن مَّسَدٍ", m: "a rope of twisted fiber" },
      ],
      gist: "The surah closes with a specific, almost visual image of her own punishment.",
      connect: "The surah's name, Al-Masad, comes from this very last word — the rope itself.",
    },
  ],
  113: [
    { n: 1, ar: "قُلْ أَعُوذُ بِرَبِّ الْفَلَقِ", chunks: [{ ar: "قُلْ", m: "Say" }, { ar: "أَعُوذُ", m: "I seek refuge" }, { ar: "بِرَبِّ", m: "in the Lord" }, { ar: "الْفَلَقِ", m: "of the daybreak" }], gist: "You're told exactly how to ask for protection — by naming who you're taking refuge in first.", connect: "This opens a pair with the surah right after it (An-Nas) — together they're the two most commonly recited surahs for protection." },
    { n: 2, ar: "مِن شَرِّ مَا خَلَقَ", chunks: [{ ar: "مِن شَرِّ", m: "from the evil" }, { ar: "مَا خَلَقَ", m: "of what He created" }], gist: "The request is broad on purpose — not one named threat, but anything harmful in all creation.", connect: "Whatever you're worried about right now technically falls inside 'what He created' — this ayah already covers it." },
    { n: 3, ar: "وَمِن شَرِّ غَاسِقٍ إِذَا وَقَبَ", chunks: [{ ar: "وَمِن شَرِّ", m: "and from the evil" }, { ar: "غَاسِقٍ", m: "of darkness" }, { ar: "إِذَا وَقَبَ", m: "when it spreads" }], gist: "Night specifically is named — when it settles in and things feel less certain.", connect: "Say this consciously at night, when this exact fear is most likely to show up." },
    { n: 4, ar: "وَمِن شَرِّ النَّفَّاثَاتِ فِي الْعُقَدِ", chunks: [{ ar: "وَمِن شَرِّ", m: "and from the evil" }, { ar: "النَّفَّاثَاتِ", m: "of the blowers" }, { ar: "فِي الْعُقَدِ", m: "in the knots" }], gist: "Even hidden schemes and quiet manipulation aimed at you are named as something to seek refuge from.", connect: "Not just physical harm — this covers the kind of harm you can't always see coming." },
    { n: 5, ar: "وَمِن شَرِّ حَاسِدٍ إِذَا حَسَدَ", chunks: [{ ar: "وَمِن شَرِّ", m: "and from the evil" }, { ar: "حَاسِدٍ", m: "of an envier" }, { ar: "إِذَا حَسَدَ", m: "when he envies" }], gist: "The surah closes on envy — someone else's resentment toward what you have.", connect: "This is protection from other people's harmful feelings toward you, not just from events or darkness." },
  ],
  104: [
    { n: 1, ar: "وَيْلٌ لِّكُلِّ هُمَزَةٍ لُّمَزَةٍ", chunks: [{ ar: "وَيْلٌ", m: "Woe" }, { ar: "لِّكُلِّ", m: "to every" }, { ar: "هُمَزَةٍ", m: "slanderer" }, { ar: "لُّمَزَةٍ", m: "backbiter" }], gist: "The surah opens with a direct warning aimed at a specific kind of person: one who tears others down, to their face or behind their back.", connect: "Worth pausing on — this names both forms, the insult said openly and the one said once you've left the room." },
    { n: 2, ar: "الَّذِي جَمَعَ مَالًا وَعَدَّدَهُ", chunks: [{ ar: "الَّذِي", m: "who" }, { ar: "جَمَعَ", m: "collects" }, { ar: "مَالًا", m: "wealth" }, { ar: "وَعَدَّدَهُ", m: "and counts it" }], gist: "The behavior is tied to a specific mindset — someone who keeps a running tally of what they've accumulated.", connect: "The warning isn't about having wealth, it's about what counting it obsessively does to how you treat people." },
    { n: 3, ar: "يَحْسَبُ أَنَّ مَالَهُ أَخْلَدَهُ", chunks: [{ ar: "يَحْسَبُ", m: "He thinks" }, { ar: "أَنَّ", m: "that" }, { ar: "مَالَهُ", m: "his wealth" }, { ar: "أَخْلَدَهُ", m: "will make him immortal" }], gist: "The real error named here isn't the wealth itself — it's the delusion that it makes him permanent.", connect: "This is the quiet lie behind a lot of hoarding: the feeling that enough of something protects you from mortality." },
    { n: 4, ar: "كَلَّا لَيُنبَذَنَّ فِي الْحُطَمَةِ", chunks: [{ ar: "كَلَّا", m: "Nay" }, { ar: "لَيُنبَذَنَّ", m: "surely he will be thrown" }, { ar: "فِي الْحُطَمَةِ", m: "in the Crusher" }], gist: "The correction is immediate and sharp — that belief is flatly rejected, and a fate is named instead.", connect: "\"Nay\" (Kalla) is a hard stop in the Quran — it means whatever was just claimed is being directly refuted." },
    { n: 5, ar: "وَمَا أَدْرَاكَ مَا الْحُطَمَةُ", chunks: [{ ar: "وَمَا أَدْرَاكَ", m: "And what will make you know" }, { ar: "مَا الْحُطَمَةُ", m: "what the Crusher is" }], gist: "The Crusher is introduced with a rhetorical question before it's even explained — a signal that it's beyond ordinary description.", connect: "This build-up pattern shows up before the Quran's most severe warnings — pay attention when it appears." },
    { n: 6, ar: "نَارُ اللَّهِ الْمُوقَدَةُ", chunks: [{ ar: "نَارُ", m: "A Fire" }, { ar: "اللَّهِ", m: "(of) Allah" }, { ar: "الْمُوقَدَةُ", m: "kindled" }], gist: "The answer to the previous ayah's question: it's a Fire, and it's actively burning, not dormant.", connect: "The one who hoarded is met with something that consumes — an intentional contrast to what he tried to keep." },
    { n: 7, ar: "الَّتِي تَطَّلِعُ عَلَى الْأَفْئِدَةِ", chunks: [{ ar: "الَّتِي", m: "Which" }, { ar: "تَطَّلِعُ", m: "mounts up" }, { ar: "عَلَى الْأَفْئِدَةِ", m: "to the hearts" }], gist: "The fire's reach is described as going past the body, straight to the heart itself.", connect: "This makes the punishment feel personal — not surface pain, but something that reaches what he valued in secret." },
    { n: 8, ar: "إِنَّهَا عَلَيْهِم مُّؤْصَدَةٌ", chunks: [{ ar: "إِنَّهَا", m: "Indeed, it" }, { ar: "عَلَيْهِم", m: "upon them" }, { ar: "مُّؤْصَدَةٌ", m: "(will be) closed over" }], gist: "There's no way out described — the fire is sealed shut over those inside.", connect: "The finality here mirrors the finality of his earlier certainty that wealth made him untouchable." },
    { n: 9, ar: "فِي عَمَدٍ مُّمَدَّدَةٍ", chunks: [{ ar: "فِي عَمَدٍ", m: "In columns" }, { ar: "مُّمَدَّدَةٍ", m: "extended" }], gist: "The surah's final image: columns stretched out, locking everything in place.", connect: "A short surah with one clear thread — what you hoard and count can't save you, and can trap you instead." },
  ],
  107: [
    { n: 1, ar: "أَرَأَيْتَ الَّذِي يُكَذِّبُ بِالدِّينِ", chunks: [{ ar: "أَرَأَيْتَ", m: "Have you seen" }, { ar: "الَّذِي", m: "the one who" }, { ar: "يُكَذِّبُ", m: "denies" }, { ar: "بِالدِّينِ", m: "the Judgment" }], gist: "The surah opens with a question, inviting you to picture a specific kind of person before naming what's wrong with them.", connect: "\"Have you seen\" is a setup — the Quran often asks you to picture someone before revealing what actually defines them." },
    { n: 2, ar: "فَذَٰلِكَ الَّذِي يَدُعُّ الْيَتِيمَ", chunks: [{ ar: "فَذَٰلِكَ", m: "Then that" }, { ar: "الَّذِي", m: "(is) the one who" }, { ar: "يَدُعُّ", m: "repulses" }, { ar: "الْيَتِيمَ", m: "the orphan" }], gist: "The answer arrives immediately: denying the Judgment shows up first as how you treat an orphan.", connect: "Notice the surah defines disbelief by an action toward a vulnerable person, not by a claim someone makes." },
    { n: 3, ar: "وَلَا يَحُضُّ عَلَىٰ طَعَامِ الْمِسْكِينِ", chunks: [{ ar: "وَلَا يَحُضُّ", m: "And does not urge" }, { ar: "عَلَىٰ طَعَامِ", m: "on feeding" }, { ar: "الْمِسْكِينِ", m: "the poor" }], gist: "The second marker: not even encouraging others to feed someone in need.", connect: "This isn't only about withholding your own food — it's about not caring enough to even bring it up." },
    { n: 4, ar: "فَوَيْلٌ لِّلْمُصَلِّينَ", chunks: [{ ar: "فَوَيْلٌ", m: "So woe" }, { ar: "لِّلْمُصَلِّينَ", m: "to those who pray" }], gist: "The surah pivots sharply — a warning now aimed at people who do pray, not people who don't.", connect: "This is often the most unsettling verse in the surah — praying alone isn't presented as automatically enough." },
    { n: 5, ar: "الَّذِينَ هُمْ عَن صَلَاتِهِمْ سَاهُونَ", chunks: [{ ar: "الَّذِينَ هُمْ", m: "Those who" }, { ar: "عَن صَلَاتِهِمْ", m: "of their prayer" }, { ar: "سَاهُونَ", m: "(are) neglectful" }], gist: "The warning is specified: it's about praying carelessly, absent-mindedly, without presence.", connect: "This is a check worth running on yourself mid-salah — are you actually here, or just going through it?" },
    { n: 6, ar: "الَّذِينَ هُمْ يُرَاءُونَ", chunks: [{ ar: "الَّذِينَ هُمْ", m: "Those who" }, { ar: "يُرَاءُونَ", m: "make show" }], gist: "A second flaw named: praying to be seen doing it, not for its own sake.", connect: "This connects prayer directly back to the orphan and the poor person from earlier — both are about sincerity versus performance." },
    { n: 7, ar: "وَيَمْنَعُونَ الْمَاعُونَ", chunks: [{ ar: "وَيَمْنَعُونَ", m: "And they deny" }, { ar: "الْمَاعُونَ", m: "small kindnesses" }], gist: "The surah ends on something small on purpose — withholding even minor, everyday acts of help.", connect: "This is the whole surah's real target: faith that never shows up as basic decency toward people around you." },
  ],
  102: [
    { n: 1, ar: "أَلْهَاكُمُ التَّكَاثُرُ", chunks: [{ ar: "أَلْهَاكُمُ", m: "Diverts you" }, { ar: "التَّكَاثُرُ", m: "the competition to increase" }], gist: "You're told plainly what's distracting you — the constant race to have more.", connect: "\"More\" here isn't defined narrowly — wealth, status, followers, anything you're stacking up and comparing." },
    { n: 2, ar: "حَتَّىٰ زُرْتُمُ الْمَقَابِرَ", chunks: [{ ar: "حَتَّىٰ", m: "Until" }, { ar: "زُرْتُمُ", m: "you visit" }, { ar: "الْمَقَابِرَ", m: "the graves" }], gist: "The distraction is described as continuing right up until death itself.", connect: "The verb used is 'visit' — even death is framed here as just another stop, which is exactly the problem." },
    { n: 3, ar: "كَلَّا سَوْفَ تَعْلَمُونَ", chunks: [{ ar: "كَلَّا", m: "Nay" }, { ar: "سَوْفَ تَعْلَمُونَ", m: "soon you will know" }], gist: "A hard correction: that entire way of living is wrong, and you'll come to understand exactly why.", connect: "This is a warning without yet saying what you'll know — the suspense is doing the work here." },
    { n: 4, ar: "ثُمَّ كَلَّا سَوْفَ تَعْلَمُونَ", chunks: [{ ar: "ثُمَّ كَلَّا", m: "Then nay" }, { ar: "سَوْفَ تَعْلَمُونَ", m: "soon you will know" }], gist: "The exact same warning is repeated — not for length, but for emphasis.", connect: "When the Quran repeats a line back to back like this, it's telling you not to let it pass by too quickly." },
    { n: 5, ar: "كَلَّا لَوْ تَعْلَمُونَ عِلْمَ الْيَقِينِ", chunks: [{ ar: "كَلَّا", m: "Nay" }, { ar: "لَوْ تَعْلَمُونَ", m: "if you know" }, { ar: "عِلْمَ الْيَقِينِ", m: "(with) a knowledge of certainty" }], gist: "The distraction is reframed as a failure of certainty — if this were truly certain to you, you'd act differently now.", connect: "This is the surah's real diagnosis: not that you don't know death is coming, but that you don't feel it as certain." },
    { n: 6, ar: "لَتَرَوُنَّ الْجَحِيمَ", chunks: [{ ar: "لَتَرَوُنَّ", m: "Surely you will see" }, { ar: "الْجَحِيمَ", m: "the Hellfire" }], gist: "The suspense breaks — you're told directly what's coming into view.", connect: "This is stated as a certainty, not a possibility — the language leaves no room to negotiate with it." },
    { n: 7, ar: "ثُمَّ لَتَرَوُنَّهَا عَيْنَ الْيَقِينِ", chunks: [{ ar: "ثُمَّ لَتَرَوُنَّهَا", m: "Then surely you will see it" }, { ar: "عَيْنَ الْيَقِينِ", m: "(with the) eye of certainty" }], gist: "Not just knowing about it anymore — seeing it directly, with total certainty.", connect: "This mirrors ayah 5 exactly, but moves from 'knowledge of certainty' to actually witnessing it." },
    { n: 8, ar: "ثُمَّ لَتُسْأَلُنَّ يَوْمَئِذٍ عَنِ النَّعِيمِ", chunks: [{ ar: "ثُمَّ لَتُسْأَلُنَّ", m: "Then surely you will be asked" }, { ar: "يَوْمَئِذٍ", m: "that Day" }, { ar: "عَنِ النَّعِيمِ", m: "about the pleasures" }], gist: "The surah closes with the actual accountability — you'll be asked specifically about the comforts you had.", connect: "This isn't a warning against enjoying things — it's a warning that every comfort comes with a question attached." },
  ],
  101: [
    { n: 1, ar: "الْقَارِعَةُ", chunks: [{ ar: "الْقَارِعَةُ", m: "The Striking Calamity" }], gist: "The surah opens with a single word — one of the Quran's names for the Day of Judgment, meaning something that strikes hard.", connect: "A one-word ayah is rare — it's meant to land like the event itself: sudden, with no lead-up." },
    { n: 2, ar: "مَا الْقَارِعَةُ", chunks: [{ ar: "مَا", m: "What" }, { ar: "الْقَارِعَةُ", m: "(is) the Striking Calamity" }], gist: "The very next line questions the word you just heard, before any explanation is given.", connect: "This immediately signals: whatever you're picturing right now, it's bigger than that." },
    { n: 3, ar: "وَمَا أَدْرَاكَ مَا الْقَارِعَةُ", chunks: [{ ar: "وَمَا أَدْرَاكَ", m: "And what will make you know" }, { ar: "مَا الْقَارِعَةُ", m: "what the Striking Calamity (is)" }], gist: "The question is asked again, even more emphatically — even you, the listener, can't fully grasp it yet.", connect: "Three lines, same word, escalating uncertainty — that's the whole opening doing its job before any details arrive." },
    { n: 4, ar: "يَوْمَ يَكُونُ النَّاسُ كَالْفَرَاشِ الْمَبْثُوثِ", chunks: [{ ar: "يَوْمَ يَكُونُ", m: "(The) Day will be" }, { ar: "النَّاسُ", m: "the mankind" }, { ar: "كَالْفَرَاشِ", m: "like moths" }, { ar: "الْمَبْثُوثِ", m: "scattered" }], gist: "The first real image finally arrives: people scattered like moths, disoriented and without direction.", connect: "Moths are drawn helplessly toward light with no real control — that's the state being described here." },
    { n: 5, ar: "وَتَكُونُ الْجِبَالُ كَالْعِهْنِ الْمَنفُوشِ", chunks: [{ ar: "وَتَكُونُ الْجِبَالُ", m: "And will be the mountains" }, { ar: "كَالْعِهْنِ", m: "like wool" }, { ar: "الْمَنفُوشِ", m: "fluffed up" }], gist: "Even mountains — the things you'd assume are permanent — are reduced to loose, weightless wool.", connect: "If mountains don't hold their form that day, nothing you're counting on to stay solid will either." },
    { n: 6, ar: "فَأَمَّا مَن ثَقُلَتْ مَوَازِينُهُ", chunks: [{ ar: "فَأَمَّا", m: "Then as for" }, { ar: "مَن", m: "(him) whose" }, { ar: "ثَقُلَتْ", m: "(are) heavy" }, { ar: "مَوَازِينُهُ", m: "his scales" }], gist: "The scene shifts to judgment itself — specifically, whoever's good deeds weigh heavy.", connect: "The imagery turns concrete here: an actual weighing, not an abstract idea of good and bad." },
    { n: 7, ar: "فَهُوَ فِي عِيشَةٍ رَّاضِيَةٍ", chunks: [{ ar: "فَهُوَ فِي عِيشَةٍ", m: "Then he (will be) in a life" }, { ar: "رَّاضِيَةٍ", m: "pleasant" }], gist: "For that person, the outcome is stated simply — a life they're genuinely content with.", connect: "Notice the word used is contentment, not just comfort — this is about being at peace with the outcome." },
    { n: 8, ar: "وَأَمَّا مَنْ خَفَّتْ مَوَازِينُهُ", chunks: [{ ar: "وَأَمَّا مَنْ", m: "But as for (him) whose" }, { ar: "خَفَّتْ", m: "(are) light" }, { ar: "مَوَازِينُهُ", m: "his scales" }], gist: "The mirror case: whoever's scales come up light.", connect: "The structure repeats on purpose — same weighing, opposite result, so you can't miss the contrast." },
    { n: 9, ar: "فَأُمُّهُ هَاوِيَةٌ", chunks: [{ ar: "فَأُمُّهُ", m: "His abode" }, { ar: "هَاوِيَةٌ", m: "(will be the) Pit" }], gist: "Their outcome is named directly — a place the Quran elsewhere describes as a deep, falling pit.", connect: "The word used for 'home' here is deliberately unsettling — this is described as where they belong, not just where they end up." },
    { n: 10, ar: "وَمَا أَدْرَاكَ مَا هِيَهْ", chunks: [{ ar: "وَمَا أَدْرَاكَ", m: "And what will make you know" }, { ar: "مَا هِيَهْ", m: "what it is" }], gist: "The same rhetorical build-up from the opening returns — even this is beyond ordinary understanding.", connect: "This callback ties the ending back to the beginning — the Striking Calamity and the Pit are both, ultimately, beyond full description." },
    { n: 11, ar: "نَارٌ حَامِيَةٌ", chunks: [{ ar: "نَارٌ", m: "A Fire" }, { ar: "حَامِيَةٌ", m: "intensely hot" }], gist: "The surah's final two words answer the question directly — it's fire, and it's extreme.", connect: "After three build-ups and two unanswered questions, the surah ends in the shortest, plainest way possible." },
  ],
  100: [
    { n: 1, ar: "وَالْعَادِيَاتِ ضَبْحًا", chunks: [{ ar: "وَالْعَادِيَاتِ", m: "By the racers" }, { ar: "ضَبْحًا", m: "panting" }], gist: "God opens by swearing an oath on war-horses charging forward, breathing hard with effort.", connect: "This is a vivid, physical opening — you're meant to hear the horses before anything is explained." },
    { n: 2, ar: "فَالْمُورِيَاتِ قَدْحًا", chunks: [{ ar: "فَالْمُورِيَاتِ", m: "And the producers of sparks" }, { ar: "قَدْحًا", m: "striking" }], gist: "The image continues — hooves striking stone hard enough to throw sparks.", connect: "Each line adds one more layer of intensity to a single, unfolding scene of a charge." },
    { n: 3, ar: "فَالْمُغِيرَاتِ صُبْحًا", chunks: [{ ar: "فَالْمُغِيرَاتِ", m: "And the chargers" }, { ar: "صُبْحًا", m: "(at) dawn" }], gist: "The timing is specified — this is a dawn raid, catching its target early.", connect: "By now you should have a full picture: horses racing, sparking, charging, all before sunrise." },
    { n: 4, ar: "فَأَثَرْنَ بِهِ نَقْعًا", chunks: [{ ar: "فَأَثَرْنَ", m: "Then raise" }, { ar: "بِهِ نَقْعًا", m: "thereby dust" }], gist: "The charge kicks up a cloud of dust behind it.", connect: "The oath sequence is entirely sensory on purpose — sound, sparks, timing, dust — before the point is ever stated." },
    { n: 5, ar: "فَوَسَطْنَ بِهِ جَمْعًا", chunks: [{ ar: "فَوَسَطْنَ", m: "Then penetrate" }, { ar: "بِهِ جَمْعًا", m: "thereby (in the) center, collectively" }], gist: "The charge finishes by breaking straight into the middle of the enemy's gathered ranks.", connect: "This closes the oath — five ayat building one complete, decisive scene." },
    { n: 6, ar: "إِنَّ الْإِنسَانَ لِرَبِّهِ لَكَنُودٌ", chunks: [{ ar: "إِنَّ الْإِنسَانَ", m: "Indeed, mankind" }, { ar: "لِرَبِّهِ", m: "to his Lord" }, { ar: "لَكَنُودٌ", m: "(is) surely ungrateful" }], gist: "The oath's real target is finally revealed — an accusation about human ingratitude toward God.", connect: "All that battlefield imagery was building toward this one plain statement about you, not about horses." },
    { n: 7, ar: "وَإِنَّهُ عَلَىٰ ذَٰلِكَ لَشَهِيدٌ", chunks: [{ ar: "وَإِنَّهُ", m: "And indeed, he" }, { ar: "عَلَىٰ ذَٰلِكَ", m: "on that" }, { ar: "لَشَهِيدٌ", m: "surely (is) a witness" }], gist: "You're told a person actually knows this about themself — it's not hidden or unconscious.", connect: "This closes off the easy excuse of 'I didn't realize' — the ayah says you're your own witness to this." },
    { n: 8, ar: "وَإِنَّهُ لِحُبِّ الْخَيْرِ لَشَدِيدٌ", chunks: [{ ar: "وَإِنَّهُ", m: "And indeed he" }, { ar: "لِحُبِّ الْخَيْرِ", m: "in (the) love of wealth" }, { ar: "لَشَدِيدٌ", m: "(is) surely intense" }], gist: "The root cause is named plainly — an intense attachment to wealth and possessions.", connect: "This is the same theme as At-Takathur — attachment to 'more' pulling attention away from gratitude." },
    { n: 9, ar: "أَفَلَا يَعْلَمُ إِذَا بُعْثِرَ مَا فِي الْقُبُورِ", chunks: [{ ar: "أَفَلَا يَعْلَمُ", m: "But does not he know" }, { ar: "إِذَا بُعْثِرَ", m: "when will be scattered" }, { ar: "مَا فِي الْقُبُورِ", m: "what (is) in the graves" }], gist: "A question snaps the focus back to what's actually coming — graves opened, everything inside revealed.", connect: "The pivot from 'horses charging' to 'graves opening' is deliberate — both are sudden, unstoppable events." },
    { n: 10, ar: "وَحُصِّلَ مَا فِي الصُّدُورِ", chunks: [{ ar: "وَحُصِّلَ", m: "And is made apparent" }, { ar: "مَا فِي الصُّدُورِ", m: "what (is) in the breasts" }], gist: "Not just bodies — what was hidden in people's hearts and intentions is brought out too.", connect: "This is the real reveal: not just actions, but the private motives behind them." },
    { n: 11, ar: "إِنَّ رَبَّهُم بِهِمْ يَوْمَئِذٍ لَّخَبِيرٌ", chunks: [{ ar: "إِنَّ رَبَّهُم", m: "Indeed, their Lord" }, { ar: "بِهِمْ", m: "about them" }, { ar: "يَوْمَئِذٍ", m: "that Day" }, { ar: "لَّخَبِيرٌ", m: "(is) surely All-Aware" }], gist: "The surah closes by stating what was true the entire time — God was already fully aware of all of it.", connect: "Nothing in this surah was ever a surprise to God; the surprise, if any, is only ever ours." },
  ],
  99: [
    { n: 1, ar: "إِذَا زُلْزِلَتِ الْأَرْضُ زِلْزَالَهَا", chunks: [{ ar: "إِذَا زُلْزِلَتِ", m: "When is shaken" }, { ar: "الْأَرْضُ", m: "the earth" }, { ar: "زِلْزَالَهَا", m: "(with) its earthquake" }], gist: "The surah opens on the earth itself shaking with a violence reserved for this one moment.", connect: "The phrase 'its earthquake' implies something specific to this event — not an ordinary quake, but the earth's own final one." },
    { n: 2, ar: "وَأَخْرَجَتِ الْأَرْضُ أَثْقَالَهَا", chunks: [{ ar: "وَأَخْرَجَتِ", m: "And brings forth" }, { ar: "الْأَرْضُ", m: "the earth" }, { ar: "أَثْقَالَهَا", m: "its burdens" }], gist: "Everything the earth has held and buried is pushed up and out.", connect: "Nothing stays hidden underground forever — that's the literal and symbolic point of this line." },
    { n: 3, ar: "وَقَالَ الْإِنسَانُ مَا لَهَا", chunks: [{ ar: "وَقَالَ", m: "And says" }, { ar: "الْإِنسَانُ", m: "man" }, { ar: "مَا لَهَا", m: "What (is) with it" }], gist: "A human reaction is captured in the middle of the chaos — confusion about what's happening to the ground itself.", connect: "This is a very human moment dropped into a cosmic event — even here, someone just asks 'what's going on?'" },
    { n: 4, ar: "يَوْمَئِذٍ تُحَدِّثُ أَخْبَارَهَا", chunks: [{ ar: "يَوْمَئِذٍ", m: "That Day" }, { ar: "تُحَدِّثُ", m: "it will report" }, { ar: "أَخْبَارَهَا", m: "its news" }], gist: "The answer to that confusion arrives — the earth itself will speak, reporting what happened on it.", connect: "The earth is described almost as a witness giving testimony, not just a passive backdrop to human life." },
    { n: 5, ar: "بِأَنَّ رَبَّكَ أَوْحَىٰ لَهَا", chunks: [{ ar: "بِأَنَّ رَبَّكَ", m: "Because your Lord" }, { ar: "أَوْحَىٰ لَهَا", m: "inspired [to] it" }], gist: "The earth's ability to speak is traced back to a direct command from God.", connect: "Even something as fixed and silent as the ground is shown here to be fully under command." },
    { n: 6, ar: "يَوْمَئِذٍ يَصْدُرُ النَّاسُ أَشْتَاتًا لِّيُرَوْا أَعْمَالَهُمْ", chunks: [{ ar: "يَوْمَئِذٍ", m: "That Day" }, { ar: "يَصْدُرُ النَّاسُ", m: "will proceed the mankind" }, { ar: "أَشْتَاتًا", m: "(in) scattered groups" }, { ar: "لِّيُرَوْا", m: "to be shown" }, { ar: "أَعْمَالَهُمْ", m: "their deeds" }], gist: "People are shown scattering into groups, each on their way to see exactly what they did.", connect: "This is the moment records become undeniable — not told about your deeds secondhand, but shown them directly." },
    { n: 7, ar: "فَمَن يَعْمَلْ مِثْقَالَ ذَرَّةٍ خَيْرًا يَرَهُ", chunks: [{ ar: "فَمَن يَعْمَلْ", m: "So whoever does" }, { ar: "مِثْقَالَ ذَرَّةٍ", m: "(equal to the) weight of an atom" }, { ar: "خَيْرًا يَرَهُ", m: "good, will see it" }], gist: "The scale being used is stated precisely — even something as small as an atom's weight of good is accounted for.", connect: "This is one of the most quoted ayat in the Quran for a reason — it makes even tiny good acts feel worth doing." },
    { n: 8, ar: "وَمَن يَعْمَلْ مِثْقَالَ ذَرَّةٍ شَرًّا يَرَهُ", chunks: [{ ar: "وَمَن يَعْمَلْ", m: "And whoever does" }, { ar: "مِثْقَالَ ذَرَّةٍ", m: "(equal to the) weight of an atom" }, { ar: "شَرًّا يَرَهُ", m: "evil, will see it" }], gist: "The same precision applies to harm — nothing is too small to count.", connect: "The surah ends on perfect symmetry: no good is too small to matter, no harm too small to register." },
  ],
  94: [
    { n: 1, ar: "أَلَمْ نَشْرَحْ لَكَ صَدْرَكَ", chunks: [{ ar: "أَلَمْ نَشْرَحْ", m: "Have not We expanded" }, { ar: "لَكَ صَدْرَكَ", m: "for you your breast" }], gist: "The surah opens by reminding the Prophet of something already done for him — his heart made open and at ease.", connect: "This is addressed directly and personally — a reminder of relief already given, not a request for more." },
    { n: 2, ar: "وَوَضَعْنَا عَنكَ وِزْرَكَ", chunks: [{ ar: "وَوَضَعْنَا", m: "And We removed" }, { ar: "عَنكَ وِزْرَكَ", m: "from you your burden" }], gist: "A weight he was carrying is described as having been physically lifted off him.", connect: "The word used pictures something heavy set down, not just forgiven — a real, felt relief." },
    { n: 3, ar: "الَّذِي أَنقَضَ ظَهْرَكَ", chunks: [{ ar: "الَّذِي", m: "Which" }, { ar: "أَنقَضَ", m: "weighed upon" }, { ar: "ظَهْرَكَ", m: "your back" }], gist: "The burden is described as having been heavy enough to physically strain him.", connect: "This makes the relief in the previous ayah feel earned — the weight being removed was genuinely crushing." },
    { n: 4, ar: "وَرَفَعْنَا لَكَ ذِكْرَكَ", chunks: [{ ar: "وَرَفَعْنَا", m: "And We raised high" }, { ar: "لَكَ ذِكْرَكَ", m: "for you your reputation" }], gist: "Alongside removing the burden, his name and mention are described as being elevated.", connect: "To this day his name is paired with God's in the call to prayer, five times a day — this ayah is why that matters." },
    { n: 5, ar: "فَإِنَّ مَعَ الْعُسْرِ يُسْرًا", chunks: [{ ar: "فَإِنَّ مَعَ", m: "So indeed, with" }, { ar: "الْعُسْرِ", m: "the hardship" }, { ar: "يُسْرًا", m: "(is) ease" }], gist: "A promise is stated as fact — ease exists alongside hardship, not just after it.", connect: "Notice the word is 'with,' not 'after' — the ease isn't only waiting at the end, it's already present alongside the difficulty." },
    { n: 6, ar: "إِنَّ مَعَ الْعُسْرِ يُسْرًا", chunks: [{ ar: "إِنَّ مَعَ", m: "Indeed, with" }, { ar: "الْعُسْرِ", m: "the hardship" }, { ar: "يُسْرًا", m: "(is) ease" }], gist: "The exact same promise is repeated immediately, back to back.", connect: "Classical commentators point out this repetition means one hardship never outnumbers its ease — it's matched, twice." },
    { n: 7, ar: "فَإِذَا فَرَغْتَ فَانصَبْ", chunks: [{ ar: "فَإِذَا فَرَغْتَ", m: "So when you have finished" }, { ar: "فَانصَبْ", m: "then labor hard" }], gist: "After all that relief and promise, the response asked of him is to keep working, not to rest.", connect: "Relief here isn't the end of effort — it's what makes continuing to strive possible." },
    { n: 8, ar: "وَإِلَىٰ رَبِّكَ فَارْغَب", chunks: [{ ar: "وَإِلَىٰ رَبِّكَ", m: "And to your Lord" }, { ar: "فَارْغَب", m: "then turn with hope" }], gist: "The surah closes by directing that effort toward one place — God, with genuine hope and longing.", connect: "This is the surah's real order: burden removed, promise given, effort kept up, and all of it aimed back at Him." },
  ],
  93: [
    { n: 1, ar: "وَالضُّحَىٰ", chunks: [{ ar: "وَالضُّحَىٰ", m: "By the morning brightness" }], gist: "God opens by swearing an oath on the calm, bright light of mid-morning.", connect: "This surah was revealed after a pause in revelation that had worried the Prophet — it opens gently, on purpose." },
    { n: 2, ar: "وَاللَّيْلِ إِذَا سَجَىٰ", chunks: [{ ar: "وَاللَّيْلِ", m: "And the night" }, { ar: "إِذَا سَجَىٰ", m: "when it covers with darkness" }], gist: "A second oath, this time on the night once it settles into full stillness.", connect: "Bright morning and settled night — two calm opposites, both sworn on before the reassurance that follows." },
    { n: 3, ar: "مَا وَدَّعَكَ رَبُّكَ وَمَا قَلَىٰ", chunks: [{ ar: "مَا وَدَّعَكَ", m: "Not has forsaken you" }, { ar: "رَبُّكَ", m: "your Lord" }, { ar: "وَمَا قَلَىٰ", m: "and not He is displeased" }], gist: "The direct reassurance arrives — he hasn't been abandoned, and God isn't upset with him.", connect: "This responds to a real fear the Prophet had during a gap in revelation — the surah answers it immediately and personally." },
    { n: 4, ar: "وَلَلْآخِرَةُ خَيْرٌ لَّكَ مِنَ الْأُولَىٰ", chunks: [{ ar: "وَلَلْآخِرَةُ", m: "And surely the Hereafter" }, { ar: "خَيْرٌ لَّكَ", m: "(is) better for you" }, { ar: "مِنَ الْأُولَىٰ", m: "than the first" }], gist: "Whatever difficulty came before is put in perspective — what's still ahead is described as better.", connect: "This applies beyond the Prophet's situation — it's a general promise that later is better than earlier, if you stay the course." },
    { n: 5, ar: "وَلَسَوْفَ يُعْطِيكَ رَبُّكَ فَتَرْضَىٰ", chunks: [{ ar: "وَلَسَوْفَ يُعْطِيكَ", m: "And soon will give you" }, { ar: "رَبُّكَ", m: "your Lord" }, { ar: "فَتَرْضَىٰ", m: "then you will be satisfied" }], gist: "A promise of future giving, specifically framed around reaching real satisfaction, not just relief.", connect: "The goal named here isn't just survival of hardship — it's arriving at a state of being genuinely content." },
    { n: 6, ar: "أَلَمْ يَجِدْكَ يَتِيمًا فَآوَىٰ", chunks: [{ ar: "أَلَمْ يَجِدْكَ", m: "Did not He find you" }, { ar: "يَتِيمًا", m: "an orphan" }, { ar: "فَآوَىٰ", m: "and give shelter" }], gist: "The reassurance turns to evidence — reminding him of a time he was orphaned, and was given shelter anyway.", connect: "The pattern from here on is: name a past hardship, then name how God already met it — three times in a row." },
    { n: 7, ar: "وَوَجَدَكَ ضَالًّا فَهَدَىٰ", chunks: [{ ar: "وَوَجَدَكَ", m: "And He found you" }, { ar: "ضَالًّا", m: "lost" }, { ar: "فَهَدَىٰ", m: "so He guided" }], gist: "A second reminder — a time he was without direction, and was guided.", connect: "This isn't about sin, but about a period before revelation when the path forward wasn't yet clear to him." },
    { n: 8, ar: "وَوَجَدَكَ عَائِلًا فَأَغْنَىٰ", chunks: [{ ar: "وَوَجَدَكَ", m: "And He found you" }, { ar: "عَائِلًا", m: "in need" }, { ar: "فَأَغْنَىٰ", m: "so He made self-sufficient" }], gist: "A third reminder — a time of real need, met with sufficiency.", connect: "Three hardships, three responses — the pattern itself is the reassurance: whatever you're in now will be met too." },
    { n: 9, ar: "فَأَمَّا الْيَتِيمَ فَلَا تَقْهَرْ", chunks: [{ ar: "فَأَمَّا الْيَتِيمَ", m: "So as for the orphan" }, { ar: "فَلَا تَقْهَرْ", m: "then (do) not oppress" }], gist: "The surah turns from reassurance to instruction — treat orphans the way he was treated: not oppressed.", connect: "Each instruction from here maps directly back to one of the three hardships he was just reminded of." },
    { n: 10, ar: "وَأَمَّا السَّائِلَ فَلَا تَنْهَرْ", chunks: [{ ar: "وَأَمَّا السَّائِلَ", m: "And as for one who asks" }, { ar: "فَلَا تَنْهَرْ", m: "then (do) not repel" }], gist: "The second instruction — don't turn away someone who comes asking for help.", connect: "This mirrors his own past need — having once needed and received, he's told not to refuse someone else's asking." },
    { n: 11, ar: "وَأَمَّا بِنِعْمَةِ رَبِّكَ فَحَدِّثْ", chunks: [{ ar: "وَأَمَّا بِنِعْمَةِ", m: "But as for (the) Favor" }, { ar: "رَبِّكَ", m: "(of) your Lord" }, { ar: "فَحَدِّثْ", m: "narrate" }], gist: "The surah's final instruction: speak openly about what God has given you.", connect: "The whole surah moves from private reassurance to public instruction — what you were shown in comfort, you're told to speak about, not hide." },
  ],
  // The following single/paired ayahs (surahs 21, 27, 17, 20, 3, 25,
  // 23) exist only to back the "What Do I Say When...?" dua finder
  // below — sparse entries, same pattern as 67/97 above (a surah can
  // hold just the ayat actually used). Arabic text for every one of
  // these was fetched fresh from the Uthmani-script edition via
  // api.alquran.cloud (not typed from memory) and only cosmetically
  // normalized (alef-wasla -> plain alef, Uthmani-only print marks
  // stripped) to match this file's existing typographic style —
  // never re-worded or re-ordered.
  21: [
    {
      n: 87,
      ar: "وَذَا النُّونِ إِذ ذَّهَبَ مُغَاضِبًا فَظَنَّ أَن لَّن نَّقْدِرَ عَلَيْهِ فَنَادَىٰ فِي الظُّلُمَاتِ أَن لَّا إِلَٰهَ إِلَّا أَنتَ سُبْحَانَكَ إِنِّي كُنتُ مِنَ الظَّالِمِينَ",
      chunks: [
        { ar: "وَذَا النُّونِ", m: "And [remember] the man of the fish [Yunus]" },
        { ar: "إِذ ذَّهَبَ مُغَاضِبًا", m: "when he went off in anger" },
        { ar: "فَظَنَّ أَن لَّن نَّقْدِرَ عَلَيْهِ", m: "and thought that We would not decree [hardship] upon him" },
        { ar: "فَنَادَىٰ فِي الظُّلُمَاتِ", m: "so he called out in the darkness" },
        { ar: "أَن لَّا إِلَٰهَ إِلَّا أَنتَ", m: "There is no deity except You" },
        { ar: "سُبْحَانَكَ", m: "exalted are You" },
        { ar: "إِنِّي كُنتُ مِنَ الظَّالِمِينَ", m: "indeed, I have been of the wrongdoers" },
      ],
      duaCoreStart: 4, // the actual words to say start here — the rest is the story around them
      gist: "In total darkness and distress, the Prophet Yunus (AS) called out with this exact line — not a long speech, just this.",
      connect: "When everything feels dark and out of your hands, this is the line to reach for.",
    },
  ],
  27: [
    {
      n: 19,
      ar: "فَتَبَسَّمَ ضَاحِكًا مِّن قَوْلِهَا وَقَالَ رَبِّ أَوْزِعْنِي أَنْ أَشْكُرَ نِعْمَتَكَ الَّتِي أَنْعَمْتَ عَلَيَّ وَعَلَىٰ وَالِدَيَّ وَأَنْ أَعْمَلَ صَالِحًا تَرْضَاهُ وَأَدْخِلْنِي بِرَحْمَتِكَ فِي عِبَادِكَ الصَّالِحِينَ",
      chunks: [
        { ar: "فَتَبَسَّمَ ضَاحِكًا مِّن قَوْلِهَا", m: "So he smiled, amused at her words" },
        { ar: "وَقَالَ رَبِّ", m: "and said, \"My Lord" },
        { ar: "أَوْزِعْنِي أَنْ أَشْكُرَ نِعْمَتَكَ", m: "enable me to be grateful for Your favor" },
        { ar: "الَّتِي أَنْعَمْتَ عَلَيَّ وَعَلَىٰ وَالِدَيَّ", m: "which You have bestowed upon me and upon my parents" },
        { ar: "وَأَنْ أَعْمَلَ صَالِحًا تَرْضَاهُ", m: "and to do righteous deeds pleasing to You" },
        { ar: "وَأَدْخِلْنِي بِرَحْمَتِكَ", m: "and admit me, by Your mercy" },
        { ar: "فِي عِبَادِكَ الصَّالِحِينَ", m: "among Your righteous servants\"" },
      ],
      duaCoreStart: 1,
      gist: "This is Sulaiman (AS)'s own prayer of gratitude — recognizing a blessing, then asking to actually be able to appreciate it.",
      connect: "Say this the next time you catch yourself about to take something good for granted.",
    },
  ],
  17: [
    {
      n: 24,
      ar: "وَاخْفِضْ لَهُمَا جَنَاحَ الذُّلِّ مِنَ الرَّحْمَةِ وَقُل رَّبِّ ارْحَمْهُمَا كَمَا رَبَّيَانِي صَغِيرًا",
      chunks: [
        { ar: "وَاخْفِضْ لَهُمَا", m: "And lower to them" },
        { ar: "جَنَاحَ الذُّلِّ مِنَ الرَّحْمَةِ", m: "the wing of humility, out of mercy" },
        { ar: "وَقُل رَّبِّ", m: "and say, \"My Lord" },
        { ar: "ارْحَمْهُمَا", m: "have mercy upon them both" },
        { ar: "كَمَا رَبَّيَانِي صَغِيرًا", m: "as they raised me when I was small\"" },
      ],
      duaCoreStart: 2,
      gist: "A direct instruction on how to treat your parents, paired with the exact words to say for them.",
      connect: "Say this for your parents, whether they're right there with you or not.",
    },
  ],
  20: [
    {
      n: 25,
      ar: "قَالَ رَبِّ اشْرَحْ لِي صَدْرِي",
      chunks: [
        { ar: "قَالَ", m: "He said" },
        { ar: "رَبِّ", m: "\"My Lord" },
        { ar: "اشْرَحْ لِي صَدْرِي", m: "expand for me my breast\"" },
      ],
      duaCoreStart: 1,
      gist: "Musa (AS)'s own prayer right before facing Pharaoh — asking first for the emotional capacity to handle what's ahead.",
      connect: "Say this before the conversation or moment you're dreading.",
    },
    {
      n: 26,
      ar: "وَيَسِّرْ لِي أَمْرِي",
      chunks: [
        { ar: "وَيَسِّرْ لِي", m: "and ease for me" },
        { ar: "أَمْرِي", m: "my task" },
      ],
      duaCoreStart: 0,
      gist: "The very next line — asking for the task itself to be made easier, not just the nerves around it.",
      connect: "Pair this with the ayah before it — capacity first, then ease.",
    },
    {
      n: 114,
      ar: "فَتَعَالَى اللَّهُ الْمَلِكُ الْحَقُّ وَلَا تَعْجَلْ بِالْقُرْآنِ مِن قَبْلِ أَن يُقْضَىٰ إِلَيْكَ وَحْيُهُ وَقُل رَّبِّ زِدْنِي عِلْمًا",
      chunks: [
        { ar: "فَتَعَالَى اللَّهُ الْمَلِكُ الْحَقُّ", m: "So exalted is Allah, the Sovereign, the Truth" },
        { ar: "وَلَا تَعْجَلْ بِالْقُرْآنِ", m: "And do not hasten with the Quran" },
        { ar: "مِن قَبْلِ أَن يُقْضَىٰ إِلَيْكَ وَحْيُهُ", m: "before its revelation is completed to you" },
        { ar: "وَقُل رَّبِّ زِدْنِي عِلْمًا", m: "and say, \"My Lord, increase me in knowledge\"" },
      ],
      duaCoreStart: 3,
      gist: "The Prophet himself was taught to ask for more knowledge — this isn't a beginner's dua, it's one meant for a lifetime.",
      connect: "Say this before you study, take a test, or start learning something new.",
    },
  ],
  3: [
    {
      n: 8,
      ar: "رَبَّنَا لَا تُزِغْ قُلُوبَنَا بَعْدَ إِذْ هَدَيْتَنَا وَهَبْ لَنَا مِن لَّدُنكَ رَحْمَةً إِنَّكَ أَنتَ الْوَهَّابُ",
      chunks: [
        { ar: "رَبَّنَا لَا تُزِغْ قُلُوبَنَا", m: "Our Lord, let not our hearts deviate" },
        { ar: "بَعْدَ إِذْ هَدَيْتَنَا", m: "after You have guided us" },
        { ar: "وَهَبْ لَنَا مِن لَّدُنكَ رَحْمَةً", m: "and grant us mercy from Yourself" },
        { ar: "إِنَّكَ أَنتَ الْوَهَّابُ", m: "indeed, You are the Bestower" },
      ],
      duaCoreStart: 0,
      gist: "A prayer for the specific fear of losing your certainty after you've already found it.",
      connect: "Say this when your faith feels shaky, not just when it feels strong.",
    },
    {
      n: 173,
      ar: "الَّذِينَ قَالَ لَهُمُ النَّاسُ إِنَّ النَّاسَ قَدْ جَمَعُوا لَكُمْ فَاخْشَوْهُمْ فَزَادَهُمْ إِيمَانًا وَقَالُوا حَسْبُنَا اللَّهُ وَنِعْمَ الْوَكِيلُ",
      chunks: [
        { ar: "الَّذِينَ قَالَ لَهُمُ النَّاسُ", m: "Those to whom people said" },
        { ar: "إِنَّ النَّاسَ قَدْ جَمَعُوا لَكُمْ فَاخْشَوْهُمْ", m: "indeed, the people have gathered against you, so fear them" },
        { ar: "فَزَادَهُمْ إِيمَانًا", m: "but it [only] increased them in faith" },
        { ar: "وَقَالُوا حَسْبُنَا اللَّهُ وَنِعْمَ الْوَكِيلُ", m: "and they said, \"Allah is sufficient for us, and He is the best Disposer of affairs\"" },
      ],
      duaCoreStart: 3,
      gist: "The reaction of the believers when they were told real danger was gathering against them — faith went up, not down.",
      connect: "Say this exact line when you find out people are working against you.",
    },
  ],
  25: [
    {
      n: 74,
      ar: "وَالَّذِينَ يَقُولُونَ رَبَّنَا هَبْ لَنَا مِنْ أَزْوَاجِنَا وَذُرِّيَّاتِنَا قُرَّةَ أَعْيُنٍ وَاجْعَلْنَا لِلْمُتَّقِينَ إِمَامًا",
      chunks: [
        { ar: "وَالَّذِينَ يَقُولُونَ", m: "And those who say" },
        { ar: "رَبَّنَا هَبْ لَنَا", m: "\"Our Lord, grant us" },
        { ar: "مِنْ أَزْوَاجِنَا وَذُرِّيَّاتِنَا قُرَّةَ أَعْيُنٍ", m: "from our spouses and offspring comfort to our eyes" },
        { ar: "وَاجْعَلْنَا لِلْمُتَّقِينَ إِمَامًا", m: "and make us a leading example for the righteous\"" },
      ],
      duaCoreStart: 1,
      gist: "How the Quran describes the righteous praying for their own families — real comfort, not just piety on paper.",
      connect: "Say this for your spouse, your kids, or the family you're hoping for.",
    },
  ],
  23: [
    {
      n: 97,
      ar: "وَقُل رَّبِّ أَعُوذُ بِكَ مِنْ هَمَزَاتِ الشَّيَاطِينِ",
      chunks: [
        { ar: "وَقُل", m: "And say" },
        { ar: "رَّبِّ", m: "\"My Lord" },
        { ar: "أَعُوذُ بِكَ", m: "I seek refuge in You" },
        { ar: "مِنْ هَمَزَاتِ الشَّيَاطِينِ", m: "from the incitements of the devils" },
      ],
      duaCoreStart: 1,
      gist: "A direct instruction on what to say when you feel provoked toward anger or something you'll regret.",
      connect: "Say this the moment you feel that push toward reacting badly.",
    },
    {
      n: 98,
      ar: "وَأَعُوذُ بِكَ رَبِّ أَن يَحْضُرُونِ",
      chunks: [
        { ar: "وَأَعُوذُ بِكَ رَبِّ", m: "And I seek refuge in You, my Lord" },
        { ar: "أَن يَحْضُرُونِ", m: "lest they be present with me\"" },
      ],
      duaCoreStart: 0,
      gist: "The follow-up line — not just protection from the push itself, but from the influence staying near you at all.",
      connect: "Pair this with the ayah before it as one continuous request.",
    },
  ],
  43: [
    {
      n: 67,
      ar: "الْأَخِلَّاءُ يَوْمَئِذٍ بَعْضُهُمْ لِبَعْضٍ عَدُوٌّ إِلَّا الْمُتَّقِينَ",
      chunks: [
        { ar: "الْأَخِلَّاءُ يَوْمَئِذٍ", m: "Close friends, that Day" },
        { ar: "بَعْضُهُمْ لِبَعْضٍ عَدُوٌّ", m: "will be enemies to one another" },
        { ar: "إِلَّا الْمُتَّقِينَ", m: "except the righteous" },
      ],
      gist: "A direct warning: closeness now means nothing on its own — only friendships built on righteousness actually last.",
      connect: "Worth asking of anyone close to you: is this a bond that would survive being tested?",
    },
  ],
};

// Salah phrase modules for Journey 1.
// Real recorded audio for salah phrases, verified against Hisn
// al-Muslim's public per-topic recitation clips (audio/mpeg,
// confirmed reachable) — a real reciter, not synthesized speech.
// Each source clip actually covers that topic's full list of
// narrations (this phrase plus several longer variants), so
// `audioEnd` trims playback to just the first clean repetition of
// the exact phrase shown here. The cut point was found by running
// acoustic silence-gap analysis on the real recording (not a guess
// at the wording) — but since it wasn't confirmed by ear, nudge it
// if a clip ever sounds clipped or runs long. Takbir has no
// dedicated recording on this source, so it has none here — see
// SALAH_AUDIO_LABEL usage.
const SALAH_AUDIO_LABEL = "Hisn al-Muslim recitation";

/* ============================================================
   MEMORIZATION — chunk builder
   Groups a surah's ayat into fixed-size chunks (1-3 ayat each,
   per the chunking requirement) for the Learn flow. Pure function
   of AYAT data — no state, easy to reason about independent of the
   scheduler (srs.js) or the matching module (recallMatch.js).
   ============================================================ */
const MEMORIZE_CHUNK_SIZE = 3;

// Flat, ordered list of { ayahNum, pos } — one entry per word across
// the whole chunk, in the same order recallMatch.matchRecall's
// tokenizer produces refWords (whitespace-split, ayah by ayah, in
// order). This is what lets a brokenIndices[] from matchRecall map
// straight back to "which real word, in which real ayah" for the
// isolated-error-replay step, reusing the same per-word Quran audio
// (playWordRange) the Discover-it tap feature already uses.
function buildFlatWordMeta(chunk) {
  const meta = [];
  for (const ayah of chunk.ayat) {
    const words = ayah.ar.trim().split(/\s+/);
    words.forEach((_, i) => meta.push({ ayahNum: ayah.n, pos: i + 1 }));
  }
  return meta;
}

// Plays only the broken words (by global chunk-word index) back to
// back, each via its own real per-word clip — the "only replay the
// specific broken portion" error-isolation step. Chains across ayah
// boundaries by grouping consecutive same-ayah indices into single
// playWordRange calls, falling back to single-word calls elsewhere.
function playIsolatedWords(chunk, brokenIndices, { onEnd, onError } = {}) {
  const meta = buildFlatWordMeta(chunk);
  const positions = brokenIndices.map((i) => meta[i]).filter(Boolean);
  if (positions.length === 0) { onEnd && onEnd(); return () => {}; }

  let idx = 0;
  let cancelled = false;
  let sawError = false;
  const playNext = () => {
    if (cancelled) return;
    if (idx >= positions.length) { onEnd && onEnd(); if (sawError) onError && onError(); return; }
    const { ayahNum, pos } = positions[idx];
    playWordRange({
      surahId: chunk.surahId, ayahNum, startWord: pos, endWord: pos,
      onEnd: () => { idx += 1; playNext(); },
      onError: () => { sawError = true; },
    });
  };
  playNext();
  return () => { cancelled = true; stopWordAudio(); };
}

// Plays every word of a chunk, in order, back to back — each via
// its own real per-word clip (same source as playIsolatedWords /
// the Discover-it tap feature) — optionally looping the whole
// sequence multiple times. `onWordStart(globalIndex)` fires right
// as each word begins, which is what lets the UI highlight the
// word currently being recited in sync with real audio, rather
// than a rough time-based guess.
function playChunkWordsLoop(chunk, { loops = 1, rate = 1, onWordStart, onLoopStart, onEnd, onError } = {}) {
  const meta = buildFlatWordMeta(chunk);
  let cancelled = false;
  let loopsDone = 0;
  let sawError = false;

  function playOneLoop() {
    if (cancelled) return;
    onLoopStart && onLoopStart(loopsDone + 1);
    let idx = 0;
    const playNext = () => {
      if (cancelled) return;
      if (idx >= meta.length) {
        loopsDone += 1;
        if (sawError) { onError && onError(); return; }
        if (loopsDone >= loops) { onEnd && onEnd(); return; }
        playOneLoop();
        return;
      }
      const { ayahNum, pos } = meta[idx];
      onWordStart && onWordStart(idx);
      playWordRange({
        surahId: chunk.surahId, ayahNum, startWord: pos, endWord: pos, rate,
        onEnd: () => { idx += 1; playNext(); },
        onError: () => { sawError = true; },
      });
    };
    playNext();
  }

  playOneLoop();
  return () => { cancelled = true; stopWordAudio(); };
}

// Distributes a known total duration across a list of relative
// "weights" (here, transliterated-word lengths as a rough proxy for
// spoken duration), returning each item's estimated START offset in
// seconds. Pure and independently reasoned-about on purpose.
function computeWordTimeOffsets(weights, durationSec) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return weights.map((w) => {
    const start = (acc / total) * durationSec;
    acc += w;
    return start;
  });
}

// Plays the chunk's real, continuous ayah recording(s) — the same
// natural-paced audio used everywhere else in the app, not the
// slower isolated per-word clips — while ESTIMATING when each word
// begins (proportional to word length, scaled to each ayah's real
// measured duration) to drive the same word-highlight UI. This
// can't be frame-perfect the way playChunkWordsLoop's exact per-
// word timing is, but it keeps the natural, fluent recitation pace
// intact, which is the whole point of offering it as "Normal".
function playChunkContinuousWithEstimatedHighlight(chunk, translitWords, { loops = 1, preferredReciterId, onWordStart, onLoopStart, onEnd, onError } = {}) {
  const wordCountByAyah = chunk.ayat.map((a) => a.ar.trim().split(/\s+/).length);
  const ayahWordOffset = [];
  { let acc = 0; for (const n of wordCountByAyah) { ayahWordOffset.push(acc); acc += n; } }
  const weights = translitWords.map((w) => w.length || 1);

  let timeouts = [];
  const clearAll = () => { timeouts.forEach(clearTimeout); timeouts = []; };

  const cancelRecitation = playRecitationRange({
    surahId: chunk.surahId, ayahStart: chunk.ayahStart, ayahEnd: chunk.ayahEnd, loops, preferredReciterId,
    onLoopStart: (n) => { clearAll(); onLoopStart && onLoopStart(n); },
    onAyahStart: (ayahNum, duration) => {
      const ayahIdx = ayahNum - chunk.ayahStart;
      if (ayahIdx < 0 || ayahIdx >= wordCountByAyah.length || !Number.isFinite(duration)) return;
      const start = ayahWordOffset[ayahIdx];
      const count = wordCountByAyah[ayahIdx];
      const offsets = computeWordTimeOffsets(weights.slice(start, start + count), duration);
      offsets.forEach((t, i) => {
        const globalIdx = start + i;
        timeouts.push(setTimeout(() => onWordStart && onWordStart(globalIdx), Math.max(0, t * 1000)));
      });
    },
    onEnd: () => { clearAll(); onEnd && onEnd(); },
    onError: () => { clearAll(); onError && onError(); },
  });

  return () => { clearAll(); cancelRecitation(); };
}

function buildChunksForSurah(surahId) {
  const ayat = AYAT[surahId];
  if (!ayat) return [];
  const chunks = [];
  for (let i = 0; i < ayat.length; i += MEMORIZE_CHUNK_SIZE) {
    const slice = ayat.slice(i, i + MEMORIZE_CHUNK_SIZE);
    chunks.push({
      surahId,
      ayahStart: slice[0].n,
      ayahEnd: slice[slice.length - 1].n,
      ayat: slice,
      text: slice.map((a) => a.ar).join(" "),
    });
  }
  return chunks;
}

// Rebuilds a full chunk object (ayat + text) from a saved
// MemorizationItem — items only persist surahId + ayahRange (the
// data model from the spec), not the text itself, so the Review
// flow reconstructs it from AYAT on demand rather than duplicating
// content into the item.
function chunkForMemItem(item) {
  const ayat = AYAT[item.surahId];
  if (!ayat) return null;
  const [start, end] = item.ayahRange;
  const slice = ayat.filter((a) => a.n >= start && a.n <= end);
  if (slice.length === 0) return null;
  return {
    surahId: item.surahId, ayahStart: start, ayahEnd: end, ayat: slice,
    text: slice.map((a) => a.ar).join(" "), __itemId: item.id,
  };
}
// Per-word audio strategy for salah phrases: each word below also
// occurs as ordinary Quran vocabulary somewhere, so real, verified,
// genuinely word-isolated recitation is available via the same
// word-by-word Quran audio CDN used for surah lessons — every URL
// was fetched and confirmed as real audio/mpeg before being used
// here, and matched to the correct grammatical form (case ending),
// not just any occurrence of a similar-looking word. The one
// exception is "حَمِدَهُ" (Rising, below) — confirmed via the
// Quranic Arabic Corpus search that this exact conjugated form does
// not occur anywhere in the Quran, so no real isolated clip exists
// for it; that one chunk falls back to the trimmed full-phrase
// recording instead.
//
// Full-phrase "Hear it" audio still comes from Hisn al-Muslim's
// per-topic recordings (real reciter, trimmed to the relevant
// segment) where available, since it sounds like natural fluent
// recitation rather than separately-recorded words stitched
// together. Takbir has no such recording (it's not a standalone
// du'a topic there), so its "Hear it" button instead plays its two
// verified word clips back-to-back.
const SALAH_MODULES = [
  {
    id: "takbir",
    title: "Allahu Akbar",
    ar: "اللَّهُ أَكْبَرُ",
    chunks: [
      { ar: "اللَّهُ", m: "Allah", wordAudioUrl: "https://audios.quranwbw.com/words/58/058_001_003.mp3?version=2" }, // 58:1, word 3 (nominative form)
      { ar: "أَكْبَرُ", m: "is the Greatest", wordAudioUrl: "https://audios.quranwbw.com/words/29/029_045_017.mp3?version=2" }, // 29:45, word 17
    ],
    gist: "You say this to begin salah and to move between almost every position — it's a repeated reset that God is greater than whatever you're about to do or leave behind.",
    connect: "Next time you say Allahu Akbar, let it actually mean: greater than this distraction, this worry, this next 30 seconds.",
  },
  {
    id: "ruku",
    title: "In Ruku' (bowing)",
    ar: "سُبْحَانَ رَبِّيَ الْعَظِيمِ",
    chunks: [
      { ar: "سُبْحَانَ", m: "Exalted is", wordAudioUrl: "https://audios.quranwbw.com/words/17/017_001_001.mp3?version=2" }, // 17:1, word 1
      { ar: "رَبِّيَ", m: "my Lord", wordAudioUrl: "https://audios.quranwbw.com/words/2/002_258_016.mp3?version=2" }, // 2:258, word 16
      { ar: "الْعَظِيمِ", m: "the Most Great", wordAudioUrl: "https://audios.quranwbw.com/words/56/056_074_004.mp3?version=2" }, // 56:74, word 4 (genitive form)
    ],
    gist: "Bowing your body, you're declaring God's greatness with your words at the same time.",
    connect: "The posture and the phrase match: you're physically lowered while verbally exalting Him.",
    audioUrl: "https://hisnmuslim.com/audio/ar/ar_7esn_AlMoslem_by_Doors_018.mp3",
    // The clip opens with spoken narration before the phrase itself,
    // then the repetitions run ~5.36s–7.67s, then a separate short
    // word-length segment (~8.33s–9.05s) — user-confirmed that
    // trailing segment is "ثلاثاً" ("three times") being announced,
    // not part of the phrase, so the window stops right after the
    // repetitions and before that announcement.
    audioStart: 5.3,
    audioEnd: 7.75,
  },
  {
    id: "rising",
    title: "Rising from Ruku'",
    ar: "سَمِعَ اللَّهُ لِمَنْ حَمِدَهُ",
    chunks: [
      { ar: "سَمِعَ", m: "hears", wordAudioUrl: "https://audios.quranwbw.com/words/58/058_001_002.mp3?version=2" }, // 58:1, word 2
      { ar: "اللَّهُ", m: "Allah", wordAudioUrl: "https://audios.quranwbw.com/words/58/058_001_003.mp3?version=2" }, // 58:1, word 3
      { ar: "لِمَنْ", m: "whoever", wordAudioUrl: "https://audios.quranwbw.com/words/98/098_008_019.mp3?version=2" }, // 98:8, word 19
      // This exact conjugated form doesn't occur anywhere in the
      // Quran (confirmed against the Quranic Arabic Corpus's full
      // ح-م-د root concordance) and has no entry on Forvo either, so
      // there's no real recorded source to use. Unlike every other
      // wordAudioUrl in this app, this one clip is AI-generated
      // speech (ElevenLabs TTS), not a human reciter/speaker — kept
      // separate so it's easy to find/replace if a real recording of
      // this word ever turns up.
      { ar: "حَمِدَهُ", m: "praises Him", wordAudioUrl: "https://d8j0ntlcm91z4.cloudfront.net/user_3ChJxXV6y9FfPtacbfyqRKVUeUz/hf_20260901_023135_e5df838d-6ae2-47d2-9743-7186f5ae1b23.mp3" },
    ],
    gist: "As you rise, you're stating a fact: God hears the praise you're about to say next.",
    connect: "This is said right before 'Rabbana lakal hamd' — it's the setup line for the thanks that follows.",
    audioUrl: "https://hisnmuslim.com/audio/ar/ar_7esn_AlMoslem_by_Doors_019.mp3",
    // Same intro-then-phrase structure as ruku: repetitions run
    // ~5.49s–7.365s, then a ~1.95s gap, then a short trailing blip
    // starting ~9.3s (very likely the same kind of "ثلاثاً"-style
    // announcement) — not independently confirmed by ear, unlike
    // ruku, so flag it if this one still sounds off.
    audioStart: 5.4,
    audioEnd: 7.4,
  },
  {
    id: "sujood",
    title: "In Sujood (prostration)",
    ar: "سُبْحَانَ رَبِّيَ الْأَعْلَىٰ",
    chunks: [
      { ar: "سُبْحَانَ", m: "Exalted is", wordAudioUrl: "https://audios.quranwbw.com/words/17/017_001_001.mp3?version=2" }, // 17:1, word 1
      { ar: "رَبِّيَ", m: "my Lord", wordAudioUrl: "https://audios.quranwbw.com/words/2/002_258_016.mp3?version=2" }, // 2:258, word 16
      { ar: "الْأَعْلَىٰ", m: "the Most High", wordAudioUrl: "https://audios.quranwbw.com/words/87/087_001_004.mp3?version=2" }, // 87:1, word 4
    ],
    gist: "In the lowest physical position you take, you declare God as the Most High — the biggest contrast in the whole prayer.",
    connect: "This is the closest a servant gets to God — let the words match the moment.",
    audioUrl: "https://hisnmuslim.com/audio/ar/ar_7esn_AlMoslem_by_Doors_020.mp3",
    // Repetitions run ~4.97s–7.1s, then a ~1.1s gap, then a short
    // trailing blip ~8.22s–8.88s (duration matches ruku's confirmed
    // "ثلاثاً" segment closely) — not independently confirmed by ear.
    audioStart: 4.9,
    audioEnd: 7.15,
  },
  {
    id: "between-sujood",
    title: "Between the two Sujood",
    ar: "رَبِّ اغْفِرْ لِي",
    chunks: [
      { ar: "رَبِّ", m: "My Lord", wordAudioUrl: "https://audios.quranwbw.com/words/71/071_028_001.mp3?version=2" }, // 71:28, word 1
      { ar: "اغْفِرْ", m: "forgive", wordAudioUrl: "https://audios.quranwbw.com/words/71/071_028_002.mp3?version=2" }, // 71:28, word 2
      { ar: "لِي", m: "me", wordAudioUrl: "https://audios.quranwbw.com/words/71/071_028_003.mp3?version=2" }, // 71:28, word 3
    ],
    gist: "In the brief sitting between prostrations, the request is short and direct: simple forgiveness.",
    connect: "It's easy to rush this line without noticing you're actually asking for forgiveness, twice, every rak'ah.",
    audioUrl: "https://hisnmuslim.com/audio/ar/ar_7esn_AlMoslem_by_Doors_021.mp3",
    // This phrase is short enough that the repetition/trailing-word
    // boundary is genuinely harder to distinguish acoustically than
    // the longer phrases above — this window (~7.1s–7.97s) is a
    // best-effort estimate, least confidently verified of the four.
    audioStart: 7.1,
    audioEnd: 7.97,
  },
];

/* ============================================================
   "WHAT DO I SAY WHEN...?" — situational dua finder
   Every entry points at a real ayah (or ayah pair) already sitting
   in AYAT above — no separate content pipeline, no new audio
   sourcing: real recitation (single ayah via playRecitation, a
   pair via playRecitationRange) and real per-word audio both come
   free from the exact same infrastructure the rest of the app
   already uses. `duaCoreStart` (only set on the newly-added ayahs
   above, where the full ayah includes narrative framing) marks
   which chunk index the actual words-to-say start at, so the UI
   can point to it without ever hiding or trimming the real ayah.
   ============================================================ */
// Creator/gifting codes for free SuraLink Unlimited access — checked
// entirely client-side (this app has no backend/server to validate
// against), so treat these as a lightweight gifting mechanic, not a
// secret: anyone who inspects the shipped app bundle can read this
// list. Fine for handing out to a known creator/friend; not a
// substitute for real access control if abuse ever becomes an issue.
const CREATOR_CODES = new Set(["NOOR786", "FAJR143", "ZAINERAJA"]);

const DUA_SITUATIONS = [
  { id: "hardship", icon: "😰", label: "Everything feels overwhelming", surahId: 94, ayahStart: 5, ayahEnd: 6 },
  { id: "envy", icon: "🧿", label: "You feel surrounded by envy or bad energy", surahId: 113, ayahStart: 1, ayahEnd: 5 },
  { id: "whispers", icon: "🗣️", label: "People are talking behind your back", surahId: 114, ayahStart: 1, ayahEnd: 6 },
  { id: "guidance", icon: "🧭", label: "You don't know what to do", surahId: 1, ayahStart: 6, ayahEnd: 6 },
  { id: "distress", icon: "🌑", label: "You're in real distress, everything feels dark", surahId: 21, ayahStart: 87, ayahEnd: 87 },
  { id: "gratitude", icon: "🤲", label: "You want to actually feel grateful", surahId: 27, ayahStart: 19, ayahEnd: 19 },
  { id: "parents", icon: "👨‍👩‍👧", label: "Praying for your parents", surahId: 17, ayahStart: 24, ayahEnd: 24 },
  { id: "nervous", icon: "😬", label: "You're dreading something ahead of you", surahId: 20, ayahStart: 25, ayahEnd: 26 },
  { id: "knowledge", icon: "📚", label: "Before an exam or learning something new", surahId: 20, ayahStart: 114, ayahEnd: 114 },
  { id: "steadfast", icon: "🕯️", label: "Your faith feels shaky", surahId: 3, ayahStart: 8, ayahEnd: 8 },
  { id: "family", icon: "💞", label: "Praying for your spouse or family", surahId: 25, ayahStart: 74, ayahEnd: 74 },
  { id: "plotted", icon: "🛡️", label: "You found out people are plotting against you", surahId: 3, ayahStart: 173, ayahEnd: 173 },
  { id: "anger", icon: "🔥", label: "You feel that push toward anger", surahId: 23, ayahStart: 97, ayahEnd: 98 },
  { id: "newstart", icon: "🌱", label: "Starting something new", surahId: 1, ayahStart: 1, ayahEnd: 1 },
  { id: "badcompany", icon: "🐍", label: "Not sure who around you is really for you", surahId: 43, ayahStart: 67, ayahEnd: 67 },
];

function DuaFinderScreen({ progress, onBack, onMemorize, preferredReciterId }) {
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState(null);
  const [reciting, setReciting] = useState(false);
  const [audioError, setAudioError] = useState(false);

  const filtered = DUA_SITUATIONS.filter((s) => s.label.toLowerCase().includes(search.toLowerCase()));
  const active = DUA_SITUATIONS.find((s) => s.id === activeId);
  const activeAyat = active ? (AYAT[active.surahId] || []).filter((a) => a.n >= active.ayahStart && a.n <= active.ayahEnd) : [];
  const surahMeta = active ? surahDirectory.find((s) => s.id === active.surahId) : null;

  React.useEffect(() => {
    setReciting(false);
    setAudioError(false);
    return () => stopRecitation();
  }, [activeId]);

  function toggleRecitation() {
    if (!active) return;
    if (reciting) { stopRecitation(); setReciting(false); return; }
    setAudioError(false);
    if (active.ayahStart === active.ayahEnd) {
      playRecitation({
        surahId: active.surahId, ayahNum: active.ayahStart, preferredReciterId,
        onStart: () => setReciting(true), onEnd: () => setReciting(false), onError: () => setAudioError(true),
      });
    } else {
      playRecitationRange({
        surahId: active.surahId, ayahStart: active.ayahStart, ayahEnd: active.ayahEnd, loops: 1, preferredReciterId,
        onEnd: () => setReciting(false), onError: () => setAudioError(true),
      });
      setReciting(true);
    }
  }

  if (active) {
    return (
      <Screen>
        <FontLoader />
        <TopBar title="What Do I Say When...?" onBack={() => setActiveId(null)} />
        <div style={{ padding: "0 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{ fontSize: 26 }}>{active.icon}</div>
            <div style={{ ...displaySerif, fontSize: 17, color: T.textHi, fontStyle: "italic" }}>{active.label}</div>
          </div>
          {activeAyat.map((ayah) => {
            const coreStart = ayah.duaCoreStart ?? 0;
            return (
              <div key={ayah.n} style={{
                background: `linear-gradient(180deg, ${T.parchment}, ${T.parchmentDim})`,
                borderRadius: 20, padding: "26px 20px", textAlign: "center", marginBottom: 14,
                boxShadow: "0 20px 40px -20px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(201,164,92,0.4)",
              }}>
                <div dir="rtl" style={{ ...arabicFont, fontSize: 24, lineHeight: 2.1 }}>
                  {ayah.chunks.map((c, i) => (
                    <span key={i} style={{ color: i >= coreStart ? "#26201a" : "rgba(38,32,26,0.45)", fontWeight: i >= coreStart ? 600 : 400 }}>
                      {c.ar}{i < ayah.chunks.length - 1 ? " " : ""}
                    </span>
                  ))}
                </div>
                <div style={{ ...bodySans, fontSize: 12, color: "#6b5a3d", marginTop: 10, lineHeight: 1.6 }}>
                  {ayah.chunks.slice(coreStart).map((c) => c.m).join(" ")}
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
            <button
              onClick={toggleRecitation}
              style={{
                ...iconBtnStyle, width: 46, height: 46, borderRadius: 99,
                background: audioError ? "transparent" : T.gold, borderColor: audioError ? T.danger : T.gold,
                boxShadow: reciting ? "0 0 0 6px rgba(201,164,92,0.16)" : "none",
              }}
            >
              {audioError ? <RetryIcon color={T.danger} /> : <PlayPauseIcon playing={reciting} />}
            </button>
          </div>
          <div style={{ ...bodySans, fontSize: 12, color: audioError ? T.danger : T.textFaint, textAlign: "center", marginBottom: 18 }}>
            {audioError ? "Couldn't play — tap to retry" : reciting ? "Playing…" : "Tap to hear real recitation"}
          </div>
          <div style={{ padding: 16, borderRadius: 14, background: T.inkRaised, border: `1px solid ${T.inkLine}`, marginBottom: 14 }}>
            <div style={{ ...bodySans, fontSize: 11.5, color: T.textFaint, marginBottom: 6 }}>WHY THIS ONE</div>
            <div style={{ ...bodySans, fontSize: 13.5, color: T.textHi, lineHeight: 1.6 }}>{activeAyat[0]?.gist}</div>
          </div>
          <div style={{ ...bodySans, fontSize: 11.5, color: T.textFaint, marginBottom: 16 }}>
            {surahMeta?.nameEn} · Ayah{active.ayahEnd > active.ayahStart ? "s" : ""} {active.ayahStart}{active.ayahEnd > active.ayahStart ? `–${active.ayahEnd}` : ""}
          </div>
          {onMemorize && (
            <GhostButton onClick={() => onMemorize(active)} style={{ width: "100%", textAlign: "center", justifyContent: "center", borderColor: T.gold, color: T.gold }}>
              Memorize this
            </GhostButton>
          )}
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <FontLoader />
      <TopBar title="What Do I Say When...?" onBack={onBack} />
      <div style={{ padding: "0 20px" }}>
        <p style={{ ...bodySans, fontSize: 13, color: T.textLo, lineHeight: 1.6, margin: "4px 0 16px" }}>
          Real ayat from the Quran, matched to real moments — not a claim, just what's actually there.
        </p>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search a feeling or situation…"
          style={{
            width: "100%", ...bodySans, fontSize: 14, padding: "12px 14px", borderRadius: 12,
            background: T.inkRaised, border: `1px solid ${T.inkLine}`, color: T.textHi, marginBottom: 14, outline: "none",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((s) => (
            <div key={s.id} onClick={() => setActiveId(s.id)} style={{
              display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 14,
              background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer",
            }}>
              <div style={{ fontSize: 22 }}>{s.icon}</div>
              <div style={{ ...bodySans, fontSize: 14, color: T.textHi, flex: 1 }}>{s.label}</div>
              <span style={{ color: T.gold, fontSize: 16 }}>→</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ ...bodySans, fontSize: 13, color: T.textFaint, textAlign: "center", padding: "20px 0" }}>
              Nothing matches yet — more situations are being added.
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}

/* ============================================================
   SMALL UI PRIMITIVES
   ============================================================ */

function GeoDivider() {
  return (
    <svg width="72" height="10" viewBox="0 0 72 10" fill="none" style={{ opacity: 0.6 }}>
      {[0, 12, 24, 36, 48, 60].map((x) => (
        <path
          key={x}
          d={`M${x + 6} 0 L${x + 12} 5 L${x + 6} 10 L${x} 5 Z`}
          fill={T.gold}
          opacity={0.55}
        />
      ))}
    </svg>
  );
}

// Signature progress element: an eight-point star that fills in
// wedges as comprehension grows, evoking illuminated-manuscript
// medallions rather than a generic progress bar.
function IlluminationStar({ pct, size = 132, label, sub }) {
  const cx = size / 2, cy = size / 2, rOuter = size * 0.46, rInner = size * 0.22;
  const points = [];
  for (let i = 0; i < 16; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (Math.PI / 8) * i - Math.PI / 2;
    points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + "Z";
  const clipId = "star-clip-" + Math.round(pct * 1000);
  const fillHeight = size * (1 - pct / 100);

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <clipPath id={clipId}>
            <path d={path} />
          </clipPath>
        </defs>
        <path d={path} fill={T.inkLine} stroke={T.textFaint} strokeWidth="1" />
        <rect
          x="0" y={fillHeight} width={size} height={size}
          fill={T.gold} clipPath={`url(#${clipId})`}
          style={{ transition: "y 0.6s ease" }}
        />
        <path d={path} fill="none" stroke={T.goldSoft} strokeWidth="1.25" opacity="0.8" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ ...displaySerif, fontSize: size * 0.2, color: T.textHi, fontWeight: 600, lineHeight: 1 }}>{pct}%</div>
        {label && <div style={{ ...bodySans, fontSize: 9.5, color: T.textLo, marginTop: 3, textAlign: "center", maxWidth: size * 0.7 }}>{label}</div>}
      </div>
    </div>
  );
}

function Pill({ children, tone = "gold", style }) {
  const tones = {
    gold: { bg: "rgba(201,164,92,0.14)", fg: T.goldSoft, border: "rgba(201,164,92,0.35)" },
    teal: { bg: "rgba(46,125,83,0.14)", fg: T.tealSoft, border: "rgba(46,125,83,0.35)" },
    muted: { bg: "rgba(255,255,255,0.04)", fg: T.textLo, border: T.inkLine },
  };
  const c = tones[tone];
  return (
    <span style={{
      ...bodySans, fontSize: 11.5, padding: "3px 9px", borderRadius: 99,
      background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
      display: "inline-flex", alignItems: "center", gap: 4, ...style,
    }}>{children}</span>
  );
}

function TopBar({ title, onBack }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px 10px" }}>
      {onBack && (
        <button onClick={onBack} style={iconBtnStyle} aria-label="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke={T.textHi} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
      <div style={{ ...displaySerif, fontSize: 20, color: T.textHi, fontWeight: 600 }}>{title}</div>
    </div>
  );
}

const iconBtnStyle = {
  width: 32, height: 32, borderRadius: 10, background: T.inkRaised, border: `1px solid ${T.inkLine}`,
  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
};

function PrimaryButton({ children, onClick, disabled, style }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...bodySans, fontWeight: 600, fontSize: 14.5, padding: "13px 20px", borderRadius: 14,
        background: disabled ? T.inkLine : `linear-gradient(135deg, ${T.gold}, #B5893F)`,
        color: disabled ? T.textFaint : "#1A1305", border: "none", cursor: disabled ? "default" : "pointer",
        width: "100%", boxShadow: disabled ? "none" : "0 6px 20px -8px rgba(201,164,92,0.5)",
        transition: "transform 0.15s ease", ...style,
      }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(0.98)"; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
    >{children}</button>
  );
}

function GhostButton({ children, onClick, style }) {
  return (
    <button onClick={onClick} style={{
      ...bodySans, fontWeight: 500, fontSize: 13.5, padding: "10px 16px", borderRadius: 12,
      background: "transparent", color: T.textLo, border: `1px solid ${T.inkLine}`, cursor: "pointer", ...style,
    }}>{children}</button>
  );
}

function Screen({ children }) {
  return (
    <div style={{
      width: "100%", maxWidth: 430, margin: "0 auto", minHeight: "100vh",
      background: `radial-gradient(1200px 500px at 50% -10%, #1c3a2c 0%, ${T.ink} 55%)`,
      color: T.textHi, ...bodySans, paddingBottom: 90, position: "relative",
      // On a notched/Dynamic-Island iPhone (wrapped as the native app —
      // a plain mobile browser tab already reserves this space on its
      // own), the very top of the screen sits right under the status
      // bar without this. That's what made the back arrow in TopBar
      // visually overlap the status bar and become untappable —
      // this pushes all screen content below the real safe area
      // instead of assuming there isn't one.
      paddingTop: "env(safe-area-inset-top)",
    }}>
      {children}
    </div>
  );
}

/* ============================================================
   ARABIC CHUNK COMPONENT — the core interaction primitive
   ============================================================ */
// Per-chunk taps resolve audio in this priority order — and,
// critically, NEVER play a wider scope than the tapped word itself
// (no falling back to the full phrase or full ayah just because a
// single-word clip doesn't exist — that's confusing and was exactly
// what "unavailable" audio for حَمِدَهُ produced before this):
//
// 1. chunks[i].wordAudioUrl — a real, genuinely word-isolated clip
//    for that exact word. Used for salah words that also occur as
//    ordinary Quran vocabulary elsewhere, so a real per-word
//    recording exists even though the phrase itself isn't in the
//    Quran verbatim (see the ruku module for how these are sourced).
//
// 2. audioRef + wordRanges — for actual Quran ayah lessons, real
//    per-word recitation via each word's own position in the ayah.
//
// 3. If neither exists, the word has no verified isolated source at
//    all (confirmed by checking both the Quranic Corpus and Forvo
//    for حَمِدَهُ — it's on neither). Tapping it reveals the meaning
//    as normal but plays nothing, with an honest "no recitation
//    available for this word" note — never a guess, never a
//    TTS substitute, never someone else's word played instead.
//
// 4. Only when no real isolated clip exists anywhere for this exact
//    word (checked against the Quranic Corpus and Forvo — not
//    assumed) does this fall back to the synthesized voice. That's
//    still just this one word, never a wider scope — and if the
//    device has no Arabic voice, it reports that plainly instead of
//    staying silent.
function ArabicChunks({ chunks, revealed, onTap, size = 30, audioRef, ayahNum, wordRanges }) {
  const [speakingIdx, setSpeakingIdx] = useState(null);
  const [erroredIdx, setErroredIdx] = useState(null);
  const [erroredReason, setErroredReason] = useState(null);

  React.useEffect(() => () => {
    stopWordAudio();
    stopPhraseAudio();
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  function handleTap(i) {
    onTap(i);
    setErroredIdx((cur) => (cur === i ? null : cur));

    if (chunks[i].wordAudioUrl) {
      // A real, genuinely word-isolated clip for this exact word —
      // the same word as it occurs elsewhere in the Quran — takes
      // priority over anything else.
      setSpeakingIdx(i);
      playPhraseAudio(chunks[i].wordAudioUrl, {
        onStart: () => setSpeakingIdx(i),
        onEnd: () => setSpeakingIdx((cur) => (cur === i ? null : cur)),
        onError: () => { setErroredIdx(i); setSpeakingIdx((cur) => (cur === i ? null : cur)); },
      });
    } else if (audioRef && wordRanges) {
      const range = wordRanges[i];
      setSpeakingIdx(i);
      playWordRange({
        surahId: audioRef.surahId,
        ayahNum,
        startWord: range.start,
        endWord: range.end,
        onStart: () => setSpeakingIdx(i),
        onEnd: () => setSpeakingIdx((cur) => (cur === i ? null : cur)),
        onError: () => { setErroredIdx(i); setSpeakingIdx((cur) => (cur === i ? null : cur)); },
      });
    } else {
      setSpeakingIdx(i);
      speakArabic(chunks[i].ar, {
        onStart: () => setSpeakingIdx(i),
        onEnd: () => setSpeakingIdx((cur) => (cur === i ? null : cur)),
        onError: (reason) => { setErroredIdx(i); setErroredReason(reason); setSpeakingIdx((cur) => (cur === i ? null : cur)); },
      });
    }
  }

  return (
    <div dir="rtl" style={{ display: "flex", flexWrap: "wrap", gap: "10px 10px", justifyContent: "center" }}>
      {chunks.map((c, i) => {
        const isRevealed = revealed.has(i);
        const isSpeaking = speakingIdx === i;
        const isErrored = erroredIdx === i;
        return (
          <button
            key={i}
            onClick={() => handleTap(i)}
            style={{
              ...arabicFont, fontSize: size, lineHeight: 1.9, cursor: "pointer",
              background: isRevealed ? "rgba(201,164,92,0.16)" : "rgba(255,255,255,0.03)",
              border: `1.5px solid ${isErrored ? T.danger : isSpeaking ? T.gold : isRevealed ? "rgba(201,164,92,0.55)" : T.inkLine}`,
              borderRadius: 12, padding: "6px 12px", color: T.parchment,
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              transition: "all 0.2s ease", minWidth: 54,
              boxShadow: isSpeaking ? "0 0 0 3px rgba(201,164,92,0.18)" : "none",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {isErrored
                ? <RetryIcon size={11} color={T.danger} />
                : <SpeakerIcon size={11} color={isSpeaking ? T.gold : T.textFaint} active={isSpeaking} />}
              {c.ar}
            </span>
            {isRevealed && (
              <span style={{ ...bodySans, fontSize: 11, color: T.goldSoft, fontStyle: "normal", direction: "ltr" }}>{c.m}</span>
            )}
            {isErrored && (
              <span style={{ ...bodySans, fontSize: 9.5, color: T.danger, textAlign: "center" }}>
                {erroredReason === "no-arabic-voice" ? "no voice on device" : "tap to retry"}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Reciting-highlight color — a real orange, deliberately distinct
// from the app's gold accent, so "this word is playing right now"
// reads as its own unambiguous signal rather than blending into the
// UI's normal highlight/selected states.
const RECITING_ORANGE = "#E8720C";

function ArabicCenterpiece({ ar, small, translit, words, translitWords, activeWordIndex }) {
  // Word-aware mode (word arrays passed in) lights up the word
  // currently being recited, in both scripts, in sync with real
  // per-word audio — used by the memorization Listen step. Without
  // `words`, this renders exactly as before: one static block.
  const hasWords = Array.isArray(words) && words.length > 0;
  return (
    <div style={{
      background: `linear-gradient(180deg, ${T.parchment}, ${T.parchmentDim})`,
      borderRadius: 20, padding: small ? "22px 18px" : "34px 22px", textAlign: "center",
      boxShadow: "0 20px 40px -20px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(201,164,92,0.4)",
      position: "relative", overflow: "hidden",
    }}>
      <div style={{ position: "absolute", top: 8, left: 8, right: 8, bottom: 8, border: `1px solid rgba(201,164,92,0.35)`, borderRadius: 12, pointerEvents: "none" }} />
      {hasWords ? (
        <div dir="rtl" style={{ ...arabicFont, fontSize: small ? 26 : 32, lineHeight: 2 }}>
          {words.map((w, i) => (
            <span key={i} style={{
              color: i === activeWordIndex ? RECITING_ORANGE : "#26201a",
              fontWeight: i === activeWordIndex ? 700 : 400,
              transition: "color 0.15s ease",
            }}>{w}{i < words.length - 1 ? " " : ""}</span>
          ))}
        </div>
      ) : (
        <div dir="rtl" style={{ ...arabicFont, fontSize: small ? 26 : 32, color: "#26201a", lineHeight: 2 }}>{ar}</div>
      )}
      {translit && !hasWords && (
        <div style={{ ...mono, fontSize: small ? 12 : 13.5, color: "#6b5a3d", marginTop: 10, lineHeight: 1.6, letterSpacing: 0.2 }}>
          {translit}
        </div>
      )}
      {hasWords && translitWords && (
        <div style={{ ...mono, fontSize: small ? 12 : 13.5, marginTop: 10, lineHeight: 1.6, letterSpacing: 0.2 }}>
          {translitWords.map((w, i) => (
            <span key={i} style={{
              color: i === activeWordIndex ? RECITING_ORANGE : "#6b5a3d",
              fontWeight: i === activeWordIndex ? 700 : 400,
              transition: "color 0.15s ease",
            }}>{w}{i < translitWords.length - 1 ? " " : ""}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   MAIN APP
   ============================================================ */
// Loads once, synchronously, before first render — a lazy
// useState initializer function runs only once (not on every
// render), so this is safe to call directly inside each `useState`
// below without a separate loading phase or flash of empty state.
function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return deserializeAppState(raw ? JSON.parse(raw) : null);
  } catch {
    return deserializeAppState(null); // corrupt/unavailable storage -> safe defaults, never a crash
  }
}

export default function QuranUnderstandingApp() {
  const persisted = React.useRef(null);
  if (persisted.current === null) persisted.current = loadPersisted();

  const [view, setView] = useState(persisted.current.onboarded ? "home" : "onboarding");
  const [prevViews, setPrevViews] = useState([]);
  const [onboardStep, setOnboardStep] = useState(0);
  const [creatorCode, setCreatorCode] = useState("");
  const [creatorCodeMsg, setCreatorCodeMsg] = useState(null); // { ok: bool, text: string } | null
  const [prefs, setPrefs] = useState(persisted.current.prefs);

  const [progress, setProgress] = useState(persisted.current.progress);

  // Memorization: MemorizationItems keyed by "surahId:start-end", plus
  // a flat session log (per the spec's MemorizationSession — one
  // entry per drilled attempt, pass/fail + timestamp). The scheduler
  // itself (srs.js) is a pure module with no knowledge of this
  // state shape; this is just where its inputs/outputs get stored.
  const [memorization, setMemorization] = useState(persisted.current.memorization);
  const [memorizeSource, setMemorizeSource] = useState(null); // { surahId } | { surahId, chunk }
  const [memorizeSessionChunks, setMemorizeSessionChunks] = useState([]); // chained chunk texts learned THIS sitting
  const [memorizeDefaultLoops, setMemorizeDefaultLoops] = useState(5); // user-adjustable, per spec

  function getOrCreateMemItem(surahId, ayahStart, ayahEnd) {
    const id = `${surahId}:${ayahStart}-${ayahEnd}`;
    const existing = memorization.items[id];
    if (existing) return existing;
    const fresh = createMemorizationItem({ surahId, ayahStart, ayahEnd });
    setMemorization((m) => ({ ...m, items: { ...m.items, [id]: fresh } }));
    return fresh;
  }

  // Billing: NOT a gate on the recitation audio itself (that stays
  // free for every user, free or paid tier alike — the audio's own
  // license is non-commercial, so it's never the thing being sold).
  // What's actually metered is a free account's daily allowance of
  // BRAND NEW chunks started into memorization. Reviewing anything
  // already learned, or continuing a chunk already in progress, is
  // never limited — only starting something you've never attempted
  // before counts against the one-per-day free allowance.
  const [billing, setBilling] = useState(persisted.current.billing);
  // Two independent sources of premium access — a redeemed creator
  // code (sticky forever once granted, this app has no way to ever
  // revoke it) and a real, verified RevenueCat subscription
  // entitlement. Either alone is enough; a lapsed subscription must
  // never take away something a creator code already granted, and
  // vice versa isn't possible since codes never expire.
  const isPremium = billing.creatorUnlocked || billing.subscriptionActive;
  // Which reciter's voice actually plays. Free accounts are always
  // pinned to the default (Alafasy) regardless of what's stored here —
  // enforced at read-time below, not just at the picker UI, so a
  // stale premium selection can never keep playing after a
  // subscription lapses.
  const [selectedReciterId, setSelectedReciterId] = useState(persisted.current.selectedReciterId);
  const effectiveReciterId = isPremium && selectedReciterId ? selectedReciterId : RECITERS[0].id;

  function todayDateKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const usedNewChunksToday = billing.newChunksToday.date === todayDateKey() ? billing.newChunksToday.count : 0;
  const canStartNewChunk = isPremium || usedNewChunksToday < 1;

  // Real purchases (native iOS app only — never on the plain
  // website, which has no App Store to buy through). Configures
  // RevenueCat once, pulls the two real products with their real
  // store-localized prices, and keeps `subscriptionActive` in sync
  // with the ACTUAL entitlement RevenueCat reports — never just
  // trusted from a button tap, so a cancelled/refunded subscription
  // correctly loses access on its own.
  const [rcProducts, setRcProducts] = useState(null); // { monthly, annual } | null while still loading
  const [rcPurchasing, setRcPurchasing] = useState(false);
  const [rcError, setRcError] = useState(null);

  function applyCustomerInfo(customerInfo) {
    const active = !!customerInfo?.entitlements?.active?.[RC_ENTITLEMENT_ID];
    setBilling((b) => (b.subscriptionActive === active ? b : { ...b, subscriptionActive: active }));
  }

  React.useEffect(() => {
    if (!isNativeApp()) return; // no App Store on the plain website — nothing to configure
    let listenerId = null;
    let cancelled = false;
    (async () => {
      try {
        await Purchases.configure({ apiKey: REVENUECAT_API_KEY_IOS });
        const { customerInfo } = await Purchases.getCustomerInfo();
        if (cancelled) return;
        applyCustomerInfo(customerInfo);
        const { products } = await Purchases.getProducts({
          productIdentifiers: [RC_PRODUCT_IDS.monthly, RC_PRODUCT_IDS.annual],
        });
        if (cancelled) return;
        const byId = {};
        products.forEach((p) => { byId[p.identifier] = p; });
        setRcProducts({ monthly: byId[RC_PRODUCT_IDS.monthly] || null, annual: byId[RC_PRODUCT_IDS.annual] || null });
        listenerId = await Purchases.addCustomerInfoUpdateListener((info) => applyCustomerInfo(info));
      } catch {
        // Configure/network failure — creator codes still work fully
        // offline; this only means no live store prices/purchases
        // until it succeeds (e.g. tapping the paywall again later).
      }
    })();
    return () => {
      cancelled = true;
      if (listenerId) Purchases.removeCustomerInfoUpdateListener({ callbackId: listenerId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function purchasePlan(planKey) {
    const product = rcProducts?.[planKey];
    if (!product) return false;
    setRcError(null);
    setRcPurchasing(true);
    try {
      const { customerInfo } = await Purchases.purchaseStoreProduct({ product });
      applyCustomerInfo(customerInfo);
      return !!customerInfo?.entitlements?.active?.[RC_ENTITLEMENT_ID];
    } catch (err) {
      if (!err?.userCancelled) setRcError("That purchase didn't go through — try again, or restore purchases if you've already subscribed.");
      return false;
    } finally {
      setRcPurchasing(false);
    }
  }

  async function restorePurchases() {
    setRcError(null);
    setRcPurchasing(true);
    try {
      const { customerInfo } = await Purchases.restorePurchases();
      applyCustomerInfo(customerInfo);
    } catch {
      setRcError("Couldn't restore purchases — check your connection and try again.");
    } finally {
      setRcPurchasing(false);
    }
  }

  function recordNewChunkStarted() {
    setBilling((b) => {
      const today = todayDateKey();
      const priorCount = b.newChunksToday.date === today ? b.newChunksToday.count : 0;
      return { ...b, newChunksToday: { date: today, count: priorCount + 1 } };
    });
  }

  // Single entry point for every "start memorizing this chunk"
  // action in the app (the chunk-list picker, "Memorize this ayah
  // now" from a lesson, and "Memorize this" from the dua finder) —
  // so the free-tier daily limit can never be bypassed by going in
  // through a different door than the one that was actually checked.
  function startMemorizing(chunk) {
    const id = `${chunk.surahId}:${chunk.ayahStart}-${chunk.ayahEnd}`;
    // Brand-new means this exact item has never been created before —
    // NOT based on its status. A chunk that was opened once and
    // abandoned before ever attempting recall is still status "new",
    // but it's already been "started" for billing purposes, so
    // re-entering it must never trigger the paywall a second time.
    const isBrandNew = !memorization.items[id];
    if (isBrandNew && !canStartNewChunk) {
      goTo("paywall");
      return;
    }
    const item = getOrCreateMemItem(chunk.surahId, chunk.ayahStart, chunk.ayahEnd);
    if (isBrandNew) recordNewChunkStarted();
    setMemorizeSource({ surahId: chunk.surahId, chunk: { ...chunk, __itemId: item.id } });
    goTo("memorizeLearn");
  }

  // Streak: reconciled once per app load against the device's own
  // local calendar date (never touched mid-session otherwise, so
  // using the app across midnight doesn't double-count or flicker).
  // Free accounts lose the streak on any fully-skipped day, same as
  // before this existed at all (previously `streak` was just a
  // static number that nothing ever actually incremented). Premium
  // accounts never lose it to a missed day — "streak protection" is
  // an always-on subscriber benefit, not a limited number of passes.
  function daysBetweenDateKeys(a, b) {
    const [ay, am, ad] = a.split("-").map(Number);
    const [by, bm, bd] = b.split("-").map(Number);
    const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
    return Math.round(ms / (24 * 60 * 60 * 1000));
  }
  React.useEffect(() => {
    const today = todayDateKey();
    setProgress((p) => {
      if (p.lastActiveDate === today) return p; // already reconciled today
      if (!p.lastActiveDate) return { ...p, streak: Math.max(1, p.streak || 1), lastActiveDate: today };
      const gap = daysBetweenDateKeys(p.lastActiveDate, today);
      if (gap <= 0) return { ...p, lastActiveDate: today };
      if (gap === 1) return { ...p, streak: (p.streak || 0) + 1, lastActiveDate: today };
      // gap > 1: a day (or more) was fully missed.
      if (isPremium) return { ...p, lastActiveDate: today }; // protected — streak untouched
      return { ...p, streak: 1, lastActiveDate: today };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function recordMemResult(itemId, result) {
    setMemorization((m) => {
      const item = m.items[itemId];
      if (!item) return m;
      const updated = applyReviewResult(item, result);
      return {
        items: { ...m.items, [itemId]: updated },
        sessions: [...m.sessions, { itemId, result, timestamp: Date.now() }],
      };
    });
  }

  const memItemsList = useMemo(() => Object.values(memorization.items), [memorization.items]);
  const dueMemCount = useMemo(() => countDue(memItemsList), [memItemsList]);

  const [currentSurah, setCurrentSurah] = useState(persisted.current.currentSurah);
  const [currentAyahIdx, setCurrentAyahIdx] = useState(persisted.current.currentAyahIdx);

  // Save on every meaningful change — progress, memorization,
  // prefs, and reading position all persist across a reload/reopen
  // now, via localStorage (per-device only, same as the rest of the
  // web platform's storage model — there's no account/sync here).
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeAppState({
        prefs, progress, memorization, currentSurah, currentAyahIdx, billing, selectedReciterId,
        onboarded: view !== "onboarding",
      })));
    } catch {
      // Storage unavailable/full/blocked (private browsing, quota,
      // etc.) — the app still works for this session, it just won't
      // remember next time. Not worth surfacing as an error to the user.
    }
  });

  const [lessonSource, setLessonSource] = useState(null); // {type:'surah'|'salah', ...}
  const [surahSearch, setSurahSearch] = useState("");
  const [playingAyahKey, setPlayingAyahKey] = useState(null); // "surahId:ayahN" currently reciting, for the surah reader
  const [erroredAyahKey, setErroredAyahKey] = useState(null); // "surahId:ayahN" whose recitation failed to load

  function toggleAyahRecitation(surahId, ayahNum) {
    const key = `${surahId}:${ayahNum}`;
    if (playingAyahKey === key) {
      stopRecitation();
      setPlayingAyahKey(null);
      return;
    }
    setErroredAyahKey((cur) => (cur === key ? null : cur));
    playRecitation({
      surahId, ayahNum, preferredReciterId: effectiveReciterId,
      onStart: () => setPlayingAyahKey(key),
      onEnd: () => setPlayingAyahKey((cur) => (cur === key ? null : cur)),
      onError: () => setErroredAyahKey(key),
    });
  }

  const goTo = useCallback((v) => {
    setPrevViews((p) => [...p, view]);
    setView(v);
  }, [view]);
  const goBack = useCallback(() => {
    setPrevViews((p) => {
      if (p.length === 0) { setView("home"); return p; }
      const next = [...p];
      const last = next.pop();
      setView(last);
      return next;
    });
  }, []);

  const totalAyat = 6236;
  const ayahsExploredCount = progress.ayahsExplored.size;
  const wordsFamiliarCount = Object.keys(progress.words).length;
  const overallPct = Math.max(0.1, +((ayahsExploredCount / totalAyat) * 100).toFixed(1));

  function recordWordSeen(ar, meaning, audio) {
    setProgress((p) => {
      const words = { ...p.words };
      // Keep whichever audio source is already on record if this word
      // was seen before without one (e.g. an older session) — never
      // overwrite a real source with a missing one.
      const existingAudio = words[ar]?.audio;
      words[ar] = { count: (words[ar]?.count || 0) + 1, meaning, audio: audio || existingAudio || null };
      return { ...p, words };
    });
  }
  function markAyahExplored(surahId, n) {
    setProgress((p) => {
      const s = new Set(p.ayahsExplored);
      s.add(`${surahId}:${n}`);
      return { ...p, ayahsExplored: s };
    });
  }
  function markAyahUnderstood(surahId, n) {
    setProgress((p) => {
      const s = new Set(p.ayahsUnderstood);
      s.add(`${surahId}:${n}`);
      return { ...p, ayahsUnderstood: s };
    });
  }
  function markSurahQuizCompleted(surahId) {
    setProgress((p) => {
      const s = new Set(p.surahsCompleted);
      s.add(surahId);
      return { ...p, surahsCompleted: s };
    });
  }
  function markSalahDone(id) {
    setProgress((p) => {
      const s = new Set(p.salahDone);
      s.add(id);
      return { ...p, salahDone: s };
    });
  }
  function toggleBookmark(key) {
    setProgress((p) => {
      const s = new Set(p.bookmarks);
      s.has(key) ? s.delete(key) : s.add(key);
      return { ...p, bookmarks: s };
    });
  }

  /* ---------------- ONBOARDING ---------------- */
  if (view === "onboarding") {
    const steps = [
      {
        key: "goal",
        q: "What would you like to understand better?",
        options: [
          ["salah", "What I say during salah"],
          ["recite", "Surahs I already recite"],
          ["specific", "A specific surah"],
          ["all", "Eventually, the entire Quran"],
        ],
      },
      {
        key: "level",
        q: "How much Quran do you currently understand?",
        options: [
          ["none", "Almost none"],
          ["words", "Some common words"],
          ["ayat", "I understand some ayat"],
          ["most", "I understand quite a bit"],
        ],
      },
      {
        key: "time",
        q: "How much time would you like to spend?",
        options: [
          ["3", "3 minutes / day"],
          ["5", "5 minutes / day"],
          ["10", "10 minutes / day"],
          ["15", "15+ minutes / day"],
        ],
      },
    ];
    const step = steps[onboardStep];
    return (
      <Screen>
        <FontLoader />
        <div style={{ padding: "60px 26px 0" }}>
          <GeoDivider />
          {onboardStep === 0 && (
            <div style={{ ...bodySans, fontSize: 11, letterSpacing: 2, color: T.gold, textTransform: "uppercase", marginTop: 14 }}>
              SuraLink
            </div>
          )}
          <div style={{ ...displaySerif, fontSize: 28, marginTop: 10, color: T.textHi, fontStyle: "italic" }}>
            {onboardStep === 0 ? "Before we begin" : ""}
          </div>
          <div style={{ display: "flex", gap: 5, margin: "18px 0 26px" }}>
            {steps.map((_, i) => (
              <div key={i} style={{ height: 3, flex: 1, borderRadius: 2, background: i <= onboardStep ? T.gold : T.inkLine }} />
            ))}
          </div>
          <div style={{ ...displaySerif, fontSize: 22, color: T.textHi, marginBottom: 22, lineHeight: 1.35 }}>{step.q}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {step.options.map(([val, label]) => {
              const selected = prefs[step.key] === val;
              return (
                <button
                  key={val}
                  onClick={() => setPrefs((p) => ({ ...p, [step.key]: val }))}
                  style={{
                    ...bodySans, textAlign: "left", padding: "15px 16px", borderRadius: 14, fontSize: 14.5,
                    background: selected ? "rgba(201,164,92,0.12)" : T.inkRaised,
                    border: `1.5px solid ${selected ? T.gold : T.inkLine}`, color: T.textHi, cursor: "pointer",
                  }}
                >{label}</button>
              );
            })}
          </div>

          {onboardStep === 0 && (
            <div style={{ marginTop: 28 }}>
              {creatorCodeMsg?.ok ? (
                <div style={{ ...bodySans, fontSize: 12.5, color: T.tealSoft }}>✓ {creatorCodeMsg.text}</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={creatorCode}
                      onChange={(e) => { setCreatorCode(e.target.value); setCreatorCodeMsg(null); }}
                      placeholder="Have a creator code?"
                      style={{
                        flex: 1, ...bodySans, fontSize: 13, padding: "10px 12px", borderRadius: 10,
                        background: T.inkRaised, border: `1px solid ${T.inkLine}`, color: T.textHi, outline: "none",
                      }}
                    />
                    <GhostButton onClick={() => {
                      const code = creatorCode.trim().toUpperCase();
                      if (!code) return;
                      if (CREATOR_CODES.has(code)) {
                        setBilling((b) => ({ ...b, creatorUnlocked: true }));
                        setCreatorCodeMsg({ ok: true, text: "Unlocked — you've got SuraLink Unlimited." });
                      } else {
                        setCreatorCodeMsg({ ok: false, text: "That code didn't match — check it and try again." });
                      }
                    }}>Apply</GhostButton>
                  </div>
                  {creatorCodeMsg?.ok === false && (
                    <div style={{ ...bodySans, fontSize: 11.5, color: T.danger, marginTop: 6 }}>{creatorCodeMsg.text}</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, padding: "20px 20px calc(20px + env(safe-area-inset-bottom))", background: `linear-gradient(0deg, ${T.ink} 60%, transparent)` }}>
          <PrimaryButton
            disabled={!prefs[step.key]}
            onClick={() => {
              if (onboardStep < steps.length - 1) { setOnboardStep((s) => s + 1); return; }
              // Show the paywall once, immediately after onboarding,
              // before the person has even seen the free features —
              // skippable ("Not right now" on that screen), but seen
              // by everyone at least once. "home" goes on the history
              // stack first so the paywall's own back arrow lands
              // there, not back into onboarding.
              setPrevViews((p) => [...p, "home"]);
              setView(isPremium ? "home" : "paywall");
            }}
          >{onboardStep < steps.length - 1 ? "Continue" : "Begin"}</PrimaryButton>
        </div>
      </Screen>
    );
  }

  /* ---------------- HOME ---------------- */
  if (view === "qibla") {
    return <PrayerQiblaScreen goBack={goBack} />;
  }

  if (view === "duaFinder") {
    return <DuaFinderScreen onBack={goBack} preferredReciterId={effectiveReciterId} onMemorize={(situation) => {
      const ayat = (AYAT[situation.surahId] || []).filter((a) => a.n >= situation.ayahStart && a.n <= situation.ayahEnd);
      if (!ayat.length) return;
      const chunk = { surahId: situation.surahId, ayahStart: situation.ayahStart, ayahEnd: situation.ayahEnd, ayat, text: ayat.map((a) => a.ar).join(" ") };
      setMemorizeSessionChunks([]);
      startMemorizing(chunk);
    }} />;
  }

  if (view === "paywall") {
    return <PaywallScreen
      isPremium={isPremium}
      products={rcProducts}
      purchasing={rcPurchasing}
      error={rcError}
      isNative={isNativeApp()}
      onBack={goBack}
      onPurchase={async (planKey) => { const success = await purchasePlan(planKey); if (success) goBack(); }}
      onRestore={restorePurchases}
    />;
  }

  if (view === "memorizeSurahList") {
    return <MemorizeSurahListScreen items={memorization.items} onBack={goBack}
      onPickSurah={(surahId) => { setMemorizeSource({ surahId }); goTo("memorizeChunkList"); }} />;
  }

  if (view === "memorizeChunkList") {
    return <MemorizeChunkListScreen surahId={memorizeSource.surahId} items={memorization.items} now={Date.now()} onBack={goBack}
      onPickChunk={(chunk) => startMemorizing(chunk)} />;
  }

  if (view === "memorizeLearn") {
    return <MemorizeLearnScreen
      key={memorizeSource.chunk.__itemId}
      chunk={memorizeSource.chunk}
      priorSessionText={memorizeSessionChunks.join(" ")}
      defaultLoops={memorizeDefaultLoops}
      preferredReciterId={effectiveReciterId}
      logAttempt={(itemId, result) => recordMemResult(itemId, result)}
      onChunkLearned={() => setMemorizeSessionChunks((s) => [...s, memorizeSource.chunk.text])}
      onExit={() => {
        // After finishing (or abandoning) a chunk, drop straight
        // back to this surah's chunk list rather than all the way
        // out, since the natural next step is usually "the next
        // chunk" — matches the chaining flow's intent.
        setPrevViews((p) => p.slice(0, -1));
        setView("memorizeChunkList");
      }}
    />;
  }

  if (view === "memorizeReview") {
    const queue = sortByMostOverdue(memItemsList);
    return <MemorizeReviewScreen queue={queue}
      onResult={(itemId, result) => recordMemResult(itemId, result)}
      onExit={goBack} />;
  }

  if (view === "home") {
    const continueAyah = AYAT[currentSurah]?.[currentAyahIdx];
    const surahMeta = surahDirectory.find((s) => s.id === currentSurah);
    return (
      <Screen>
        <FontLoader />
        <div style={{ padding: "28px 22px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ ...bodySans, fontSize: 13, color: T.textLo }}>As-salamu alaykum</div>
              <div style={{ ...displaySerif, fontSize: 24, fontWeight: 600, color: T.textHi, marginTop: 2 }}>Your journey continues</div>
            </div>
            <Pill tone="gold">🔥 {progress.streak}d</Pill>
          </div>

          {/* Always-visible upgrade entry point for free accounts —
              not gated behind hitting a limit first, so upgrading is
              one tap away at any time, from the very first time
              someone opens the app. */}
          {!isPremium && (
            <div
              onClick={() => goTo("paywall")}
              style={{
                marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "10px 14px", borderRadius: 12, cursor: "pointer",
                background: `linear-gradient(90deg, rgba(201,164,92,0.16), rgba(201,164,92,0.06))`,
                border: `1px solid rgba(201,164,92,0.35)`,
              }}
            >
              <span style={{ ...bodySans, fontSize: 12.5, color: T.gold, fontWeight: 600 }}>✦ Upgrade to SuraLink Unlimited</span>
              <span style={{ color: T.gold, fontSize: 14 }}>→</span>
            </div>
          )}

          {/* Continue card */}
          <div
            onClick={() => {
              setLessonSource({ type: "surah", surahId: currentSurah, ayahIdx: currentAyahIdx });
              goTo("lesson");
            }}
            style={{
              marginTop: 22, borderRadius: 20, padding: 20, cursor: "pointer",
              background: `linear-gradient(150deg, ${T.inkRaised}, #1a3226)`,
              border: `1px solid ${T.inkLine}`, position: "relative", overflow: "hidden",
            }}
          >
            <div style={{ position: "absolute", right: -20, top: -20, opacity: 0.08 }}><IlluminationStar pct={100} size={140} /></div>
            <div style={{ ...bodySans, fontSize: 11.5, color: T.tealSoft, letterSpacing: 0.4, textTransform: "uppercase" }}>Continue where you left off</div>
            <div style={{ ...displaySerif, fontSize: 19, color: T.textHi, marginTop: 6 }}>
              {surahMeta?.nameEn} · Ayah {continueAyah?.n ?? 1}
            </div>
            <div dir="rtl" style={{ ...arabicFont, fontSize: 22, color: T.goldSoft, marginTop: 8 }}>
              {continueAyah?.ar?.slice(0, 30)}…
            </div>
            <div style={{ marginTop: 14, ...bodySans, fontSize: 13, color: T.gold, fontWeight: 600 }}>Resume →</div>
          </div>

          {/* Three journeys */}
          <div style={{ marginTop: 26, ...bodySans, fontSize: 12.5, color: T.textLo, letterSpacing: 0.3 }}>THREE WAYS TO BEGIN</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
            <JourneyCard
              icon="🕌" title="Understand My Salah"
              sub="What you say, every rak'ah"
              onClick={() => goTo("salah")}
            />
            <JourneyCard
              icon="📖" title="Understand My Surahs"
              sub="Browse, search, and learn ayah by ayah"
              onClick={() => goTo("surahs")}
            />
            <JourneyCard
              icon="🌙" title="Understand the Quran"
              sub={`${overallPct}% understood so far`}
              onClick={() => goTo("journeyAll")}
            />
          </div>

          {/* What Do I Say When...? — featured, above Qibla */}
          <div
            onClick={() => goTo("duaFinder")}
            style={{
              marginTop: 22, borderRadius: 16, padding: "16px 18px", cursor: "pointer",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              background: `linear-gradient(135deg, rgba(201,164,92,0.16), rgba(46,125,83,0.06))`,
              border: `1px solid rgba(201,164,92,0.4)`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ fontSize: 22 }}>🤲</div>
              <div>
                <div style={{ ...displaySerif, fontSize: 16, color: T.gold }}>What Do I Say When...?</div>
                <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginTop: 2 }}>Real duas for real moments</div>
              </div>
            </div>
            <span style={{ color: T.gold, fontSize: 18 }}>→</span>
          </div>

          {/* Qibla + prayer times */}
          <div
            onClick={() => goTo("qibla")}
            style={{
              marginTop: 22, display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "16px 18px", borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ fontSize: 22 }}>🧭</div>
              <div>
                <div style={{ ...displaySerif, fontSize: 16, color: T.textHi }}>Qibla & Prayer Times</div>
                <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginTop: 2 }}>Based on your location</div>
              </div>
            </div>
            <span style={{ color: T.gold, fontSize: 18 }}>→</span>
          </div>

          {/* Memorization: due-review badge takes priority over the
              generic entry card whenever something's actually due —
              reviews should be surfaced, not buried, per spec. */}
          {dueMemCount > 0 ? (
            <div
              onClick={() => goTo("memorizeReview")}
              style={{
                marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "16px 18px", borderRadius: 16, cursor: "pointer",
                background: `linear-gradient(135deg, rgba(201,164,92,0.16), rgba(201,164,92,0.05))`,
                border: `1px solid rgba(201,164,92,0.4)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ fontSize: 22 }}>🧠</div>
                <div>
                  <div style={{ ...displaySerif, fontSize: 16, color: T.gold }}>{dueMemCount} {dueMemCount === 1 ? "ayah" : "chunks"} due for review</div>
                  <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginTop: 2 }}>Recall them now before they fade</div>
                </div>
              </div>
              <span style={{ color: T.gold, fontSize: 18 }}>→</span>
            </div>
          ) : (
            <div
              onClick={() => { setMemorizeSessionChunks([]); goTo("memorizeSurahList"); }}
              style={{
                marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "16px 18px", borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ fontSize: 22 }}>🧠</div>
                <div>
                  <div style={{ ...displaySerif, fontSize: 16, color: T.textHi }}>Memorize the Quran</div>
                  <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginTop: 2 }}>{memItemsList.length === 0 ? "Active recall, spaced over time" : `${memItemsList.filter((it) => it.status === "learned").length} chunks memorized`}</div>
                </div>
              </div>
              <span style={{ color: T.gold, fontSize: 18 }}>→</span>
            </div>
          )}

          {/* Quick review */}
          <div
            onClick={() => goTo("review")}
            style={{
              marginTop: 22, display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "16px 18px", borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer",
            }}
          >
            <div>
              <div style={{ ...displaySerif, fontSize: 17, color: T.textHi }}>Quick Review</div>
              <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo, marginTop: 2 }}>3 minutes · {Math.min(5, wordsFamiliarCount)} words · 2 ayat</div>
            </div>
            <span style={{ color: T.gold, fontSize: 18 }}>→</span>
          </div>

          {/* Progress snapshot */}
          <div
            onClick={() => goTo("progress")}
            style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 16, padding: "16px 18px", borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer" }}
          >
            <IlluminationStar pct={overallPct} size={68} />
            <div>
              <div style={{ ...displaySerif, fontSize: 16, color: T.textHi }}>Your Progress</div>
              <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo, marginTop: 3 }}>{ayahsExploredCount} ayat explored · {wordsFamiliarCount} words familiar</div>
            </div>
          </div>
        </div>
        <BottomNav view={view} goTo={goTo} />
      </Screen>
    );
  }

  /* ---------------- SALAH JOURNEY ---------------- */
  if (view === "salah") {
    return (
      <Screen>
        <FontLoader />
        <TopBar title="Understand My Salah" onBack={goBack} />
        <div style={{ padding: "0 20px" }}>
          <p style={{ ...bodySans, fontSize: 13.5, color: T.textLo, lineHeight: 1.6, margin: "4px 0 20px" }}>
            Short lessons on what you're already saying, so your next prayer feels different.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {SALAH_MODULES.map((m) => {
              const done = progress.salahDone.has(m.id);
              return (
                <div
                  key={m.id}
                  onClick={() => { setLessonSource({ type: "salah", id: m.id }); goTo("lesson"); }}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "16px 16px", borderRadius: 16, background: T.inkRaised,
                    border: `1px solid ${done ? "rgba(46,125,83,0.4)" : T.inkLine}`, cursor: "pointer",
                  }}
                >
                  <div>
                    <div style={{ ...displaySerif, fontSize: 16.5, color: T.textHi }}>{m.title}</div>
                    <div dir="rtl" style={{ ...arabicFont, fontSize: 17, color: T.goldSoft, marginTop: 4 }}>{m.ar}</div>
                  </div>
                  {done ? <Pill tone="teal">Understood</Pill> : <span style={{ color: T.textFaint, fontSize: 17 }}>→</span>}
                </div>
              );
            })}
          </div>
        </div>
        <BottomNav view={view} goTo={goTo} />
      </Screen>
    );
  }

  /* ---------------- SURAH BROWSER ---------------- */
  if (view === "surahs") {
    const filtered = surahDirectory.filter((s) =>
      s.nameEn.toLowerCase().includes(surahSearch.toLowerCase()) || s.nameAr.includes(surahSearch)
    );
    return (
      <Screen>
        <FontLoader />
        <TopBar title="Understand My Surahs" onBack={goBack} />
        <div style={{ padding: "0 20px" }}>
          <input
            value={surahSearch}
            onChange={(e) => setSurahSearch(e.target.value)}
            placeholder="Search surahs…"
            style={{
              width: "100%", ...bodySans, fontSize: 14, padding: "12px 14px", borderRadius: 12,
              background: T.inkRaised, border: `1px solid ${T.inkLine}`, color: T.textHi, marginBottom: 14, outline: "none",
            }}
          />
          <div style={{ maxHeight: "62vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map((s) => {
              const explored = Array.from(progress.ayahsExplored).filter((k) => k.startsWith(`${s.id}:`)).length;
              const hasContent = !!AYAT[s.id];
              return (
                <div
                  key={s.id}
                  onClick={() => { if (hasContent) { setCurrentSurah(s.id); goTo("surahReader"); } }}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 14px",
                    borderRadius: 12, background: T.inkRaised, border: `1px solid ${T.inkLine}`,
                    cursor: hasContent ? "pointer" : "default", opacity: hasContent ? 1 : 0.55,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{
                      width: 30, height: 30, borderRadius: 9, border: `1px solid ${T.gold}`, color: T.gold,
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, ...mono,
                    }}>{s.id}</div>
                    <div>
                      <div style={{ ...bodySans, fontSize: 14, color: T.textHi, fontWeight: 500 }}>{s.nameEn}</div>
                      <div style={{ ...bodySans, fontSize: 11.5, color: T.textFaint }}>{s.meaning || "—"} · {s.ayahCount} ayat</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {explored > 0 && <Pill tone="teal">{explored}/{s.ayahCount}</Pill>}
                    <div dir="rtl" style={{ ...arabicFont, fontSize: 17, color: T.textLo }}>{s.nameAr}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <BottomNav view={view} goTo={goTo} />
      </Screen>
    );
  }

  /* ---------------- SURAH READER ---------------- */
  if (view === "surahReader") {
    const meta = surahDirectory.find((s) => s.id === currentSurah);
    const ayat = AYAT[currentSurah] || [];
    const understoodCount = ayat.filter((a) => progress.ayahsUnderstood.has(`${currentSurah}:${a.n}`)).length;
    const pct = ayat.length ? Math.round((understoodCount / ayat.length) * 100) : 0;
    const allUnderstood = ayat.length > 0 && understoodCount === ayat.length;
    const quizTaken = progress.surahsCompleted.has(currentSurah);
    return (
      <Screen>
        <FontLoader />
        <TopBar title={meta?.nameEn} onBack={goBack} />
        <div style={{ padding: "0 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo }}>{meta?.meaning} · {meta?.revelation}</div>
              <div style={{ ...bodySans, fontSize: 13, color: T.gold, marginTop: 2 }}>{pct}% understood · {understoodCount}/{ayat.length} ayat</div>
            </div>
            <div style={{ height: 6, width: 90, borderRadius: 4, background: T.inkLine, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: T.gold }} />
            </div>
          </div>

          {allUnderstood && (
            <div
              onClick={() => goTo("surahQuiz")}
              style={{
                display: "flex", alignItems: "center", gap: 14, padding: "16px 18px", borderRadius: 16, marginBottom: 16,
                background: `linear-gradient(150deg, rgba(201,164,92,0.14), rgba(46,125,83,0.08))`,
                border: `1px solid rgba(201,164,92,0.4)`, cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 26 }}>🕌</div>
              <div style={{ flex: 1 }}>
                <div style={{ ...displaySerif, fontSize: 17, color: T.textHi }}>
                  {quizTaken ? "Retake the Full Surah Quiz" : "You understand every ayah!"}
                </div>
                <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginTop: 2 }}>
                  {quizTaken ? `${meta?.nameEn} · quiz passed` : `Take the final quiz to put all of ${meta?.nameEn} together`}
                </div>
              </div>
              <span style={{ color: T.gold, fontSize: 18 }}>→</span>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {ayat.map((a, idx) => {
              const key = `${currentSurah}:${a.n}`;
              const understood = progress.ayahsUnderstood.has(key);
              const bookmarked = progress.bookmarks.has(key);
              return (
                <div key={a.n} style={{ borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <Pill tone={understood ? "teal" : "muted"}>Ayah {a.n}{understood ? " · understood" : ""}</Pill>
                    <button onClick={() => toggleBookmark(key)} style={{ ...iconBtnStyle, borderColor: bookmarked ? T.gold : T.inkLine }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill={bookmarked ? T.gold : "none"} stroke={bookmarked ? T.gold : T.textLo} strokeWidth="2"><path d="M6 3h12v18l-6-4-6 4z" /></svg>
                    </button>
                  </div>
                  <button
                    onClick={() => toggleAyahRecitation(currentSurah, a.n)}
                    dir="rtl"
                    style={{
                      ...arabicFont, fontSize: 21, color: T.parchment, lineHeight: 2, textAlign: "right",
                      width: "100%", background: "none", border: "none", cursor: "pointer",
                      display: "flex", alignItems: "flex-start", justifyContent: "flex-end", gap: 8,
                    }}
                  >
                    {a.ar}
                    <span style={{ marginTop: 10 }}>
                      {erroredAyahKey === key
                        ? <RetryIcon size={14} color={T.danger} />
                        : playingAyahKey === key
                        ? <PlayPauseIcon playing size={14} color={T.gold} />
                        : <SpeakerIcon size={14} color={T.goldSoft} active />}
                    </span>
                  </button>
                  {erroredAyahKey === key && (
                    <div style={{ ...bodySans, fontSize: 11, color: T.danger, textAlign: "right", marginTop: 2 }}>
                      Couldn't load recitation — tap to retry
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <GhostButton onClick={() => { setLessonSource({ type: "surah", surahId: currentSurah, ayahIdx: idx }); goTo("lesson"); }} style={{ flex: 1, borderColor: T.gold, color: T.gold }}>
                      Understand this ayah
                    </GhostButton>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <BottomNav view={view} goTo={goTo} />
      </Screen>
    );
  }

  /* ---------------- SURAH-WIDE CAPSTONE QUIZ ---------------- */
  if (view === "surahQuiz") {
    const meta = surahDirectory.find((s) => s.id === currentSurah);
    const ayat = AYAT[currentSurah] || [];
    return (
      <Screen>
        <FontLoader />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px 6px" }}>
          <button onClick={goBack} style={iconBtnStyle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke={T.textHi} strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
          <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo }}>{meta?.nameEn} · Full Surah Quiz</div>
          <div style={{ width: 32 }} />
        </div>
        <div style={{ padding: "6px 20px 0" }}>
          <QuizSession
            mode="surah" surahId={currentSurah} ayat={ayat} surahName={meta?.nameEn}
            onComplete={() => { markSurahQuizCompleted(currentSurah); goBack(); }}
          />
        </div>
      </Screen>
    );
  }

  /* ---------------- LESSON (CORE LEARNING LOOP) ---------------- */
  if (view === "lesson") {
    let ayah, title, subtitle, keyId, onDone, audioRef = null;
    if (lessonSource?.type === "surah") {
      const meta = surahDirectory.find((s) => s.id === lessonSource.surahId);
      ayah = AYAT[lessonSource.surahId][lessonSource.ayahIdx];
      title = meta?.nameEn;
      subtitle = `Ayah ${ayah.n}`;
      keyId = `${lessonSource.surahId}:${ayah.n}`;
      onDone = () => { markAyahExplored(lessonSource.surahId, ayah.n); markAyahUnderstood(lessonSource.surahId, ayah.n); };
      audioRef = { surahId: lessonSource.surahId, ayahNum: ayah.n };
    } else {
      const mod = SALAH_MODULES.find((m) => m.id === lessonSource.id);
      ayah = mod;
      title = "Salah";
      subtitle = mod.title;
      keyId = `salah:${mod.id}`;
      onDone = () => markSalahDone(mod.id);
      // Salah phrases (takbir, tasbih, etc.) aren't standalone Quran
      // ayat, so there's no per-ayah recitation clip to fetch — these
      // stay on the synthesized voice.
    }
    const onMemorize = audioRef ? () => {
      const chunk = { surahId: audioRef.surahId, ayahStart: ayah.n, ayahEnd: ayah.n, ayat: [ayah], text: ayah.ar };
      setMemorizeSessionChunks([]);
      startMemorizing(chunk);
    } : null;
    return <LessonFlow key={keyId} ayah={ayah} title={title} subtitle={subtitle} audioRef={audioRef} preferredReciterId={effectiveReciterId}
      onExit={goBack} onFinish={() => { onDone(); goBack(); }} onWordSeen={recordWordSeen} onMemorize={onMemorize} />;
  }

  /* ---------------- JOURNEY 3: WHOLE QURAN ---------------- */
  if (view === "journeyAll") {
    const surahsWithContent = ALL_SURAHS.length;
    const completed = ALL_SURAHS.filter((s) => {
      const ayat = AYAT[s.id] || [];
      return ayat.length > 0 && ayat.every((a) => progress.ayahsUnderstood.has(`${s.id}:${a.n}`));
    }).length;
    return (
      <Screen>
        <FontLoader />
        <TopBar title="Your Quran Journey" onBack={goBack} />
        <div style={{ padding: "10px 20px 0", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <IlluminationStar pct={overallPct} size={180} label={`${ayahsExploredCount} / ${totalAyat} ayat explored`} />
          <div style={{ display: "flex", gap: 10, marginTop: 22, width: "100%" }}>
            <Stat label="Words familiar" value={wordsFamiliarCount} />
            <Stat label="Surahs completed" value={`${completed}/${surahsWithContent}`} />
            <Stat label="Streak" value={`${progress.streak}d`} />
          </div>
          <p style={{ ...bodySans, fontSize: 13, color: T.textLo, textAlign: "center", lineHeight: 1.6, margin: "24px 6px" }}>
            You're not collecting points — you're slowly unlocking a text you'll be reciting your whole life.
            Every ayah you understand once tends to stay understood.
          </p>
          <PrimaryButton onClick={() => goTo("surahs")}>Keep exploring surahs</PrimaryButton>
        </div>
        <BottomNav view={view} goTo={goTo} />
      </Screen>
    );
  }

  /* ---------------- REVIEW ---------------- */
  if (view === "review") {
    const words = Object.entries(progress.words).slice(0, 5);
    const [reviewIdx, setIdx] = [0, () => {}]; // simple static demo list
    return (
      <Screen>
        <FontLoader />
        <TopBar title="Quick Review" onBack={goBack} />
        <div style={{ padding: "0 20px" }}>
          <p style={{ ...bodySans, fontSize: 13, color: T.textLo, marginBottom: 18 }}>
            A short, frictionless pass over words and ayat you've already met.
          </p>
          <div style={{ ...bodySans, fontSize: 12, color: T.textFaint, marginBottom: 8, letterSpacing: 0.3 }}>WORDS TO RECOGNIZE</div>
          {words.length === 0 && (
            <div style={{ ...bodySans, fontSize: 13, color: T.textFaint, padding: "18px 0" }}>
              Nothing to review yet — explore an ayah first and words will show up here.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {words.map(([ar, data]) => (
              <ReviewWordCard key={ar} ar={ar} meaning={data.meaning} count={data.count} audio={data.audio} />
            ))}
          </div>

          <div style={{ ...bodySans, fontSize: 12, color: T.textFaint, margin: "22px 0 8px", letterSpacing: 0.3 }}>AYAT TO REVISIT</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Array.from(progress.ayahsUnderstood).slice(0, 2).map((key) => {
              const [sid, n] = key.split(":").map(Number);
              const a = AYAT[sid]?.find((x) => x.n === n);
              const meta = surahDirectory.find((s) => s.id === sid);
              if (!a) return null;
              return (
                <div key={key} style={{ borderRadius: 14, background: T.inkRaised, border: `1px solid ${T.inkLine}`, padding: 14 }}>
                  <div style={{ ...bodySans, fontSize: 11.5, color: T.textLo, marginBottom: 6 }}>{meta?.nameEn} · Ayah {n}</div>
                  <div dir="rtl" style={{ ...arabicFont, fontSize: 18, color: T.parchment }}>{a.ar}</div>
                </div>
              );
            })}
            {progress.ayahsUnderstood.size === 0 && (
              <div style={{ ...bodySans, fontSize: 13, color: T.textFaint }}>No ayat reviewed yet.</div>
            )}
          </div>
        </div>
        <BottomNav view={view} goTo={goTo} />
      </Screen>
    );
  }

  /* ---------------- PROGRESS ---------------- */
  if (view === "progress") {
    return (
      <Screen>
        <FontLoader />
        <TopBar title="Your Progress" onBack={goBack} />
        <div style={{ padding: "0 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <IlluminationStar pct={overallPct} size={160} label={`${ayahsExploredCount} / ${totalAyat} ayat`} />
          <div style={{ display: "flex", gap: 10, marginTop: 20, width: "100%" }}>
            <Stat label="Words familiar" value={wordsFamiliarCount} />
            <Stat label="Salah phrases" value={`${progress.salahDone.size}/${SALAH_MODULES.length}`} />
            <Stat label="Streak" value={`${progress.streak}d${isPremium ? " 🛡️" : ""}`} />
          </div>

          <div style={{ width: "100%", marginTop: 24 }}>
            <div style={{ ...bodySans, fontSize: 12, color: T.textFaint, marginBottom: 10, letterSpacing: 0.3 }}>RECITER</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {ALL_RECITERS.map((r) => {
                const isLocked = !isPremium && !RECITERS.some((free) => free.id === r.id);
                const isSelected = effectiveReciterId === r.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => (isLocked ? goTo("paywall") : setSelectedReciterId(r.id))}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "11px 14px", borderRadius: 12, cursor: "pointer", textAlign: "left",
                      background: isSelected ? "rgba(201,164,92,0.12)" : T.inkRaised,
                      border: `1px solid ${isSelected ? T.gold : T.inkLine}`,
                    }}
                  >
                    <span style={{ ...bodySans, fontSize: 13.5, color: isLocked ? T.textFaint : T.textHi }}>{r.label}</span>
                    {isLocked ? <span style={{ fontSize: 13 }}>🔒</span> : isSelected ? <span style={{ color: T.gold, fontSize: 14 }}>✓</span> : null}
                  </button>
                );
              })}
            </div>
            {!isPremium && (
              <div style={{ ...bodySans, fontSize: 11, color: T.textFaint, marginTop: 8 }}>
                More reciters are a SuraLink Unlimited perk.
              </div>
            )}
          </div>

          <div style={{ width: "100%", marginTop: 26 }}>
            <div style={{ ...bodySans, fontSize: 12, color: T.textFaint, marginBottom: 10, letterSpacing: 0.3 }}>SURAH PROGRESS</div>
            {ALL_SURAHS.filter((s) => AYAT[s.id]).map((s) => {
              const ayat = AYAT[s.id];
              const done = ayat.filter((a) => progress.ayahsUnderstood.has(`${s.id}:${a.n}`)).length;
              const pct = Math.round((done / ayat.length) * 100);
              return (
                <div key={s.id} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 5 }}>
                    <span style={{ color: T.textHi }}>{s.nameEn}</span>
                    <span style={{ color: T.textLo }}>{pct}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 4, background: T.inkLine, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: pct === 100 ? T.teal : T.gold }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ width: "100%", marginTop: 12 }}>
            <div style={{ ...bodySans, fontSize: 12, color: T.textFaint, marginBottom: 10, letterSpacing: 0.3 }}>QURANIC WORDS YOU RECOGNIZE</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {Object.entries(progress.words).length === 0 && <div style={{ fontSize: 12.5, color: T.textFaint }}>None yet.</div>}
              {Object.entries(progress.words).map(([ar, d]) => (
                <div key={ar} style={{ padding: "8px 12px", borderRadius: 10, background: T.inkRaised, border: `1px solid ${T.inkLine}`, textAlign: "center" }}>
                  <div dir="rtl" style={{ ...arabicFont, fontSize: 16, color: T.goldSoft }}>{ar}</div>
                  <div style={{ ...mono, fontSize: 9.5, color: T.textFaint, marginTop: 2 }}>×{d.count}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ width: "100%", marginTop: 24, paddingTop: 16, borderTop: `1px solid ${T.inkLine}` }}>
            <div style={{ ...bodySans, fontSize: 11, color: T.textFaint, lineHeight: 1.5 }}>
              Word meanings adapted from the Quranic Arabic Corpus
              (corpus.quran.com), used with attribution. Recitation
              audio from verified reciters, everyayah.com, and Hisn
              al-Muslim — except the word "حَمِدَهُ" in Rising from
              Ruku', which is AI-generated speech (no real recording
              of that exact word form exists) rather than a human
              reciter.
            </div>
          </div>
        </div>
        <BottomNav view={view} goTo={goTo} />
      </Screen>
    );
  }

  return null;
}

/* ============================================================
   QUIZ ENGINE
   Content (question generation) is fully separate from
   presentation (QuizSession + per-type renderers below). Adding a
   new question type means: (1) a case in buildQuizQuestions that
   produces a plain data object, (2) a branch in QuizQuestionCard
   that renders it. Nothing else needs to know about it.

   Every question is a plain object:
     { id, type, concept, difficulty, prompt, arabic?, translation?,
       options?, correctAnswer, explanation, audio?, chunks? }

   `concept` identifies which chunk (word/phrase) is being tested,
   so mistakes on the same concept can be tracked and re-asked in a
   different format. `difficulty` drives checkpoint placement and
   is a hook for real spaced repetition later — buildFollowUp is
   already the seam where a persisted per-word mastery score would
   plug in instead of "just ask it differently right now".
   ============================================================ */

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hapticPulse(pattern) {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) { /* haptics are a nice-to-have, never required */ }
}

function prefersReducedMotion() {
  try {
    return typeof window !== "undefined" && window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { return false; }
}

let quizQuestionCounter = 0;
function nextQuizId() { return `qq${++quizQuestionCounter}`; }

// Generic distractors so single-word ayahs (e.g. "وَالْعَصْرِ" alone)
// never run out of real, non-duplicate wrong options.
const GENERIC_MEANING_DISTRACTORS = ["the earth", "a mountain", "the night sky", "a garden", "the sea", "a lamp", "the moon", "a fire"];
const GENERIC_ARABIC_DISTRACTORS = ["الْأَرْضِ", "السَّمَاءِ", "الْبَحْرِ", "الْجَبَلِ", "الْقَمَرِ"];

function buildMCQOptions(correctText, pool, genericPool, count = 3) {
  let distractors = shuffleArray(pool.filter((t) => t !== correctText)).slice(0, count - 1);
  if (distractors.length < count - 1) {
    const extra = shuffleArray(genericPool.filter((t) => t !== correctText && !distractors.includes(t)));
    distractors = distractors.concat(extra).slice(0, count - 1);
  }
  while (distractors.length < count - 1) distractors.push("something else");
  return shuffleArray([correctText, ...distractors]);
}

// A readable full-phrase translation for the order/mastery question,
// built straight from the same chunk meanings shown everywhere else
// in the lesson — not a separate translation to keep in sync.
function phraseTranslation(chunks) {
  const joined = chunks.map((c) => c.m).filter(Boolean).join(" ").trim();
  if (!joined) return "";
  return joined.charAt(0).toUpperCase() + joined.slice(1) + (/[.!?]$/.test(joined) ? "" : ".");
}

function buildQuizQuestions(chunks, resolveChunkAudio) {
  const meanings = chunks.map((c) => c.m);
  const arabics = chunks.map((c) => c.ar);
  const order = shuffleArray(chunks.map((_, i) => i));
  const qs = [];

  // Phase 1 — easy recall: tap the correct translation.
  order.forEach((i) => {
    qs.push({
      id: nextQuizId(), type: "mcq", concept: i, difficulty: "easy",
      prompt: "Tap the meaning",
      arabic: chunks[i].ar,
      correctAnswer: chunks[i].m,
      options: buildMCQOptions(chunks[i].m, meanings, GENERIC_MEANING_DISTRACTORS),
      explanation: `${chunks[i].ar} means "${chunks[i].m}."`,
      audio: resolveChunkAudio(i),
    });
  });

  // Phase 2 — harder recall: audio recognition where a real clip
  // exists; otherwise tap the Arabic that matches a given meaning —
  // same difficulty tier, opposite direction of recall.
  order.forEach((i) => {
    const audio = resolveChunkAudio(i);
    if (audio) {
      qs.push({
        id: nextQuizId(), type: "audio", concept: i, difficulty: "medium",
        prompt: "Listen. What does it mean?",
        correctAnswer: chunks[i].m,
        options: buildMCQOptions(chunks[i].m, meanings, GENERIC_MEANING_DISTRACTORS),
        explanation: `That's ${chunks[i].ar} — "${chunks[i].m}."`,
        audio,
      });
    } else {
      qs.push({
        id: nextQuizId(), type: "reverse", concept: i, difficulty: "medium",
        prompt: "Tap the word that means:",
        translation: chunks[i].m,
        correctAnswer: chunks[i].ar,
        options: buildMCQOptions(chunks[i].ar, arabics, GENERIC_ARABIC_DISTRACTORS),
        explanation: `${chunks[i].ar} means "${chunks[i].m}."`,
        audio: resolveChunkAudio(i),
      });
    }
  });

  // Phase 3 — contextual: recognize a word inside the full phrase.
  if (chunks.length >= 2) {
    const targetI = order[0];
    qs.push({
      id: nextQuizId(), type: "tapAyah", concept: targetI, difficulty: "hard",
      prompt: `Tap the word that means "${chunks[targetI].m}"`,
      chunks, correctAnswer: targetI,
      wordAudio: chunks.map((_, i) => resolveChunkAudio(i)),
      explanation: `${chunks[targetI].ar} means "${chunks[targetI].m}."`,
    });
  }

  // Phase 4 — mastery: build the whole phrase in order.
  if (chunks.length >= 2) {
    qs.push({
      id: nextQuizId(), type: "order", concept: "order", difficulty: "mastery",
      prompt: "Put the phrase in order",
      chunks, correctAnswer: chunks.map((_, i) => i),
      wordAudio: chunks.map((_, i) => resolveChunkAudio(i)),
      translation: phraseTranslation(chunks),
      explanation: "That's the full phrase, in order.",
    });
  }

  return qs;
}

// A follow-up question for a concept just missed, in a different
// format than the one that was missed. This is the seam a real
// spaced-repetition system would plug into later — swap the format
// choice below for one driven by a persisted per-word mastery score
// instead of "just ask differently right now".
function buildFollowUp(concept, missedType, chunks, resolveChunkAudio) {
  if (concept === "order") {
    return {
      id: nextQuizId(), type: "order", concept: "order", difficulty: "mastery",
      prompt: "Let's try that order again",
      chunks, correctAnswer: chunks.map((_, i) => i),
      wordAudio: chunks.map((_, i) => resolveChunkAudio(i)),
      translation: phraseTranslation(chunks),
      explanation: "That's the full phrase, in order.",
    };
  }
  const i = concept;
  const meanings = chunks.map((c) => c.m);
  const arabics = chunks.map((c) => c.ar);
  const audio = resolveChunkAudio(i);
  if (missedType !== "reverse") {
    return {
      id: nextQuizId(), type: "reverse", concept: i, difficulty: "medium",
      prompt: "Tap the word that means:", translation: chunks[i].m,
      correctAnswer: chunks[i].ar, options: buildMCQOptions(chunks[i].ar, arabics, GENERIC_ARABIC_DISTRACTORS),
      explanation: `${chunks[i].ar} means "${chunks[i].m}."`, audio,
    };
  }
  return {
    id: nextQuizId(), type: "mcq", concept: i, difficulty: "easy",
    prompt: "Tap the meaning", arabic: chunks[i].ar,
    correctAnswer: chunks[i].m, options: buildMCQOptions(chunks[i].m, meanings, GENERIC_MEANING_DISTRACTORS),
    explanation: `${chunks[i].ar} means "${chunks[i].m}."`, audio,
  };
}

// Injects short checkpoint interstitials at natural phase
// boundaries — "you now recognize these by ear too" between easy
// and medium, "let's put it all together" before the contextual /
// mastery questions.
function withQuizCheckpoints(questions, wordCount) {
  const out = [];
  let lastDifficulty = null;
  questions.forEach((q) => {
    if (q.difficulty !== lastDifficulty) {
      if (lastDifficulty === "easy" && q.difficulty === "medium") {
        out.push({ id: nextQuizId(), type: "checkpoint", message: "You're recognizing these by ear too." });
      } else if (lastDifficulty === "medium" && (q.difficulty === "hard" || q.difficulty === "mastery")) {
        out.push({
          id: nextQuizId(), type: "checkpoint",
          message: `You've learned ${wordCount} new word${wordCount === 1 ? "" : "s"} in this ayah. Let's put it all together.`,
        });
      }
      lastDifficulty = q.difficulty;
    }
    out.push(q);
  });
  return out;
}

/* ============================================================
   SURAH-WIDE CAPSTONE QUIZ
   Once every ayah in a surah is individually understood, this
   builds one comprehensive quiz spanning the whole surah — reusing
   the exact same question types, real-audio resolution, and
   QuizSession machinery as the per-ayah quiz, just fed from every
   ayah's chunks instead of one. Concepts are namespaced
   "ayahNum:chunkIdx" (or "ayahNum:order") so a miss can be traced
   back to the right ayah and word for its follow-up.
   ============================================================ */
function computeWordRanges(chunks) {
  let cursor = 1;
  return chunks.map((c) => {
    const count = c.ar.trim().split(/\s+/).length;
    const range = { start: cursor, end: cursor + count - 1 };
    cursor += count;
    return range;
  });
}

function resolveAyahChunkAudio(surahId, ayah, chunkIdx, wordRanges) {
  const c = ayah.chunks[chunkIdx];
  if (c.wordAudioUrl) return { kind: "word", url: c.wordAudioUrl };
  const range = wordRanges[chunkIdx];
  return { kind: "quranWord", surahId, ayahNum: ayah.n, start: range.start, end: range.end };
}

function buildSurahQuizQuestions(surahId, ayat) {
  const words = []; // { ayahNum, idx, ar, m, audio }
  ayat.forEach((ayah) => {
    const ranges = computeWordRanges(ayah.chunks);
    ayah.chunks.forEach((c, i) => {
      words.push({ ayahNum: ayah.n, idx: i, ar: c.ar, m: c.m, audio: resolveAyahChunkAudio(surahId, ayah, i, ranges) });
    });
  });
  const allMeanings = words.map((w) => w.m);
  const order = shuffleArray(words.map((_, i) => i));
  const qs = [];

  // Phase 1 — one recall question per word across the whole surah,
  // alternating between reading and listening so it doesn't feel
  // repetitive across a longer list.
  order.forEach((wi, n) => {
    const w = words[wi];
    const concept = `${w.ayahNum}:${w.idx}`;
    if (n % 2 === 1 && w.audio) {
      qs.push({
        id: nextQuizId(), type: "audio", concept, difficulty: "easy",
        prompt: "Listen. What does it mean?",
        correctAnswer: w.m, options: buildMCQOptions(w.m, allMeanings, GENERIC_MEANING_DISTRACTORS),
        explanation: `That's ${w.ar} — "${w.m}."`, audio: w.audio,
      });
    } else {
      qs.push({
        id: nextQuizId(), type: "mcq", concept, difficulty: "easy",
        prompt: "Tap the meaning", arabic: w.ar,
        correctAnswer: w.m, options: buildMCQOptions(w.m, allMeanings, GENERIC_MEANING_DISTRACTORS),
        explanation: `${w.ar} means "${w.m}."`, audio: w.audio,
      });
    }
  });

  // Phase 2 — contextual: tap the right word inside each full ayah.
  ayat.forEach((ayah) => {
    if (ayah.chunks.length < 2) return;
    const targetI = Math.floor(Math.random() * ayah.chunks.length);
    const ranges = computeWordRanges(ayah.chunks);
    qs.push({
      id: nextQuizId(), type: "tapAyah", concept: `${ayah.n}:${targetI}`, difficulty: "hard",
      prompt: `Ayah ${ayah.n} — tap the word that means "${ayah.chunks[targetI].m}"`,
      chunks: ayah.chunks, correctAnswer: targetI,
      wordAudio: ayah.chunks.map((_, i) => resolveAyahChunkAudio(surahId, ayah, i, ranges)),
      explanation: `${ayah.chunks[targetI].ar} means "${ayah.chunks[targetI].m}."`,
    });
  });

  // Phase 3 — mastery: rebuild every ayah, in order.
  ayat.forEach((ayah) => {
    if (ayah.chunks.length < 2) return;
    const ranges = computeWordRanges(ayah.chunks);
    qs.push({
      id: nextQuizId(), type: "order", concept: `${ayah.n}:order`, difficulty: "mastery",
      prompt: `Ayah ${ayah.n} — put it in order`,
      chunks: ayah.chunks, correctAnswer: ayah.chunks.map((_, i) => i),
      wordAudio: ayah.chunks.map((_, i) => resolveAyahChunkAudio(surahId, ayah, i, ranges)),
      translation: phraseTranslation(ayah.chunks),
      explanation: "That's the full ayah, in order.",
    });
  });

  return { questions: qs, wordCount: words.length };
}

// Concept strings from buildSurahQuizQuestions are "ayahNum:chunkIdx"
// or "ayahNum:order" — this decodes one to build a differently
// formatted follow-up, the same way buildFollowUp does for a single
// ayah's quiz.
function buildSurahFollowUp(concept, missedType, surahId, ayat) {
  const [ayahNumStr, rest] = concept.split(":");
  const ayahNum = Number(ayahNumStr);
  const ayah = ayat.find((a) => a.n === ayahNum);
  if (!ayah) return null;

  if (rest === "order") {
    const ranges = computeWordRanges(ayah.chunks);
    return {
      id: nextQuizId(), type: "order", concept, difficulty: "mastery",
      prompt: `Ayah ${ayahNum} — let's try that order again`,
      chunks: ayah.chunks, correctAnswer: ayah.chunks.map((_, i) => i),
      wordAudio: ayah.chunks.map((_, i) => resolveAyahChunkAudio(surahId, ayah, i, ranges)),
      translation: phraseTranslation(ayah.chunks),
      explanation: "That's the full ayah, in order.",
    };
  }

  const idx = Number(rest);
  const c = ayah.chunks[idx];
  const ranges = computeWordRanges(ayah.chunks);
  const audio = resolveAyahChunkAudio(surahId, ayah, idx, ranges);
  const meanings = ayah.chunks.map((x) => x.m);
  const arabics = ayah.chunks.map((x) => x.ar);
  if (missedType !== "reverse") {
    return {
      id: nextQuizId(), type: "reverse", concept, difficulty: "medium",
      prompt: "Tap the word that means:", translation: c.m,
      correctAnswer: c.ar, options: buildMCQOptions(c.ar, arabics, GENERIC_ARABIC_DISTRACTORS),
      explanation: `${c.ar} means "${c.m}."`, audio,
    };
  }
  return {
    id: nextQuizId(), type: "mcq", concept, difficulty: "easy",
    prompt: "Tap the meaning", arabic: c.ar,
    correctAnswer: c.m, options: buildMCQOptions(c.m, meanings, GENERIC_MEANING_DISTRACTORS),
    explanation: `${c.ar} means "${c.m}."`, audio,
  };
}

function withSurahCheckpoints(questions, surahName, wordCount) {
  const out = [];
  let lastDifficulty = null;
  questions.forEach((q) => {
    if (q.difficulty !== lastDifficulty) {
      if (lastDifficulty === "easy" && q.difficulty === "hard") {
        out.push({
          id: nextQuizId(), type: "checkpoint",
          message: `You know all ${wordCount} words in ${surahName}. Now let's see them in context.`,
        });
      } else if ((lastDifficulty === "easy" || lastDifficulty === "hard") && q.difficulty === "mastery" && lastDifficulty !== "mastery") {
        out.push({ id: nextQuizId(), type: "checkpoint", message: `Let's rebuild every ayah of ${surahName}, one at a time.` });
      }
      lastDifficulty = q.difficulty;
    }
    out.push(q);
  });
  return out;
}

function QuizStyles() {
  return (
    <style>{`
      @keyframes quizPop { 0% { transform: scale(0.92); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
      @keyframes quizShake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
      @keyframes quizCheck { 0% { transform: scale(0.4); opacity: 0; } 70% { transform: scale(1.2); } 100% { transform: scale(1); opacity: 1; } }
    `}</style>
  );
}

function QuizProgressBar({ total, done, streak, reducedMotion }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 4, background: T.inkLine, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${pct}%`, borderRadius: 4,
          background: `linear-gradient(90deg, ${T.gold}, ${T.goldSoft})`,
          transition: reducedMotion ? "none" : "width 0.4s ease",
        }} />
      </div>
      {streak >= 2 && (
        <div style={{
          ...bodySans, fontSize: 12, fontWeight: 600, color: T.gold, display: "flex", alignItems: "center", gap: 3,
          padding: "3px 9px", borderRadius: 99, background: "rgba(201,164,92,0.14)", border: "1px solid rgba(201,164,92,0.35)",
          whiteSpace: "nowrap",
        }}>🔥 {streak}</div>
      )}
    </div>
  );
}

function MilestoneBanner({ text, reducedMotion }) {
  return (
    <div style={{
      ...bodySans, fontSize: 13, fontWeight: 600, color: "#1A1305", textAlign: "center",
      padding: "9px 14px", borderRadius: 12, marginBottom: 16,
      background: `linear-gradient(135deg, ${T.gold}, ${T.goldSoft})`,
      animation: reducedMotion ? "none" : "quizPop 0.35s ease",
    }}>{text}</div>
  );
}

function CheckBadge({ reducedMotion }) {
  return (
    <span style={{ animation: reducedMotion ? "none" : "quizCheck 0.3s ease", display: "flex", flexShrink: 0 }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="11" fill={T.teal} />
        <path d="M7 12.5l3 3 7-7" stroke="#0D1512" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
function XBadge() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="11" fill={T.danger} />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#2A120D" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function QuizFeedback({ correct, explanation, reducedMotion }) {
  const [line] = useState(() => {
    const pool = ["Perfect!", "Exactly!", "You got it!", "Beautiful.", "That's it.", "Well done."];
    return pool[Math.floor(Math.random() * pool.length)];
  });
  return (
    <div style={{
      marginTop: 16, padding: 14, borderRadius: 14,
      background: correct ? "rgba(46,125,83,0.10)" : "rgba(201,122,107,0.10)",
      border: `1px solid ${correct ? "rgba(46,125,83,0.35)" : "rgba(201,122,107,0.35)"}`,
      animation: reducedMotion ? "none" : "quizPop 0.3s ease",
    }}>
      <div style={{ ...bodySans, fontWeight: 600, fontSize: 14, color: correct ? T.tealSoft : T.textHi, marginBottom: correct ? 0 : 4 }}>
        {correct ? line : "Not quite — here's the meaning:"}
      </div>
      {!correct && <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo, lineHeight: 1.5 }}>{explanation}</div>}
    </div>
  );
}

function QuizOptionButton({ label, status, rtl, onClick, reducedMotion }) {
  const styles = {
    idle: { bg: T.inkRaised, border: T.inkLine },
    selected: { bg: "rgba(201,164,92,0.10)", border: T.gold },
    correct: { bg: "rgba(46,125,83,0.16)", border: T.teal },
    incorrect: { bg: "rgba(201,122,107,0.16)", border: T.danger },
  }[status];
  return (
    <button
      onClick={onClick}
      dir={rtl ? "rtl" : "ltr"}
      style={{
        fontSize: rtl ? 20 : 14.5, padding: "15px 16px", borderRadius: 14,
        textAlign: rtl ? "center" : "left",
        background: styles.bg, border: `1.5px solid ${styles.border}`, color: T.textHi, cursor: "pointer",
        minHeight: 52, display: "flex", alignItems: "center", justifyContent: rtl ? "center" : "space-between", gap: 8,
        fontFamily: rtl ? "'Amiri', serif" : "'Inter', sans-serif",
        animation: status === "incorrect" && !reducedMotion ? "quizShake 0.35s ease" : "none",
        transition: "background 0.2s ease, border-color 0.2s ease",
      }}
    >
      <span>{label}</span>
      {status === "correct" && <CheckBadge reducedMotion={reducedMotion} />}
      {status === "incorrect" && <XBadge />}
    </button>
  );
}

// Shared renderer for mcq / reverse / audio — they're all "pick the
// right option from a list", just differing in what's shown above
// the options (Arabic text, a translation, or a play button).
function QuestionOptions({ q, phase, selected, onSelect, onAnswer, reducedMotion }) {
  const [playing, setPlaying] = useState(false);
  const [audioErrored, setAudioErrored] = useState(false);
  const autoPlayed = React.useRef(false);

  function playPrompt() {
    if (!q.audio) return;
    setAudioErrored(false);
    playResolvedAudio(q.audio, {
      onStart: () => setPlaying(true),
      onEnd: () => setPlaying(false),
      onError: () => { setAudioErrored(true); setPlaying(false); },
    });
  }

  React.useEffect(() => {
    if (q.type === "audio" && !autoPlayed.current) {
      autoPlayed.current = true;
      playPrompt();
    }
    return () => stopResolvedAudio();
  }, [q.id]);

  function choose(opt) {
    if (phase !== "question") return;
    onSelect(opt);
    onAnswer(opt === q.correctAnswer, q.concept, q.type);
  }

  return (
    <div>
      <div style={{ ...bodySans, fontSize: 13, color: T.textLo, textAlign: "center", marginBottom: 14 }}>{q.prompt}</div>

      {q.type === "mcq" && (
        <button onClick={playPrompt} dir="rtl" style={{ display: "block", width: "100%", background: "none", border: "none", cursor: q.audio ? "pointer" : "default", marginBottom: 22, padding: 0 }}>
          <div style={{ ...arabicFont, fontSize: 34, color: T.parchment, textAlign: "center", lineHeight: 1.6 }}>{q.arabic}</div>
          {q.audio && <div style={{ marginTop: 6, display: "flex", justifyContent: "center" }}><SpeakerIcon size={14} color={T.goldSoft} active={playing} /></div>}
        </button>
      )}

      {q.type === "reverse" && (
        <div style={{ ...displaySerif, fontSize: 22, color: T.textHi, textAlign: "center", fontStyle: "italic", marginBottom: 22 }}>
          "{q.translation}"
        </div>
      )}

      {q.type === "audio" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 26 }}>
          <button onClick={playPrompt} style={{
            ...iconBtnStyle, width: 64, height: 64, borderRadius: 99,
            background: audioErrored ? "transparent" : T.gold, borderColor: audioErrored ? T.danger : T.gold,
            boxShadow: playing && !reducedMotion ? "0 0 0 8px rgba(201,164,92,0.16)" : "none", transition: "box-shadow 0.2s ease",
          }}>
            {audioErrored ? <RetryIcon color={T.danger} size={22} /> : <PlayPauseIcon playing={playing} size={22} />}
          </button>
          <div style={{ ...bodySans, fontSize: 11.5, color: audioErrored ? T.danger : T.textFaint, marginTop: 8 }}>
            {audioErrored ? "Couldn't play — tap to retry" : playing ? "Playing…" : "Tap to listen again"}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {q.options.map((opt) => {
          const isCorrect = opt === q.correctAnswer;
          const isSelected = selected === opt;
          let status = "idle";
          if (phase === "feedback") status = isCorrect ? "correct" : (isSelected ? "incorrect" : "idle");
          else if (isSelected) status = "selected";
          return (
            <QuizOptionButton key={opt} label={opt} status={status} rtl={q.type === "reverse"} onClick={() => choose(opt)} reducedMotion={reducedMotion} />
          );
        })}
      </div>

      {phase === "feedback" && <QuizFeedback correct={selected === q.correctAnswer} explanation={q.explanation} reducedMotion={reducedMotion} />}
    </div>
  );
}

// Tap the word inside the full phrase that matches the given
// meaning. Every tap also plays that word's real audio — so it
// doubles as pronunciation practice, right or wrong, before the
// selection locks the question in.
function QuestionTapAyah({ q, phase, onAnswer, reducedMotion }) {
  const [tapped, setTapped] = useState(null);
  const [speakingIdx, setSpeakingIdx] = useState(null);

  React.useEffect(() => () => stopResolvedAudio(), []);

  function tap(i) {
    if (phase !== "question") return;
    const audio = q.wordAudio?.[i];
    if (audio) {
      setSpeakingIdx(i);
      playResolvedAudio(audio, {
        onStart: () => setSpeakingIdx(i),
        onEnd: () => setSpeakingIdx((cur) => (cur === i ? null : cur)),
        onError: () => setSpeakingIdx((cur) => (cur === i ? null : cur)),
      });
    }
    setTapped(i);
    onAnswer(i === q.correctAnswer, q.concept, q.type);
  }
  return (
    <div>
      <div style={{ ...bodySans, fontSize: 13, color: T.textLo, textAlign: "center", marginBottom: 18 }}>{q.prompt}</div>
      <div dir="rtl" style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", padding: "22px 14px", borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}` }}>
        {q.chunks.map((c, i) => {
          let status = "idle";
          if (phase === "feedback") status = i === q.correctAnswer ? "correct" : (i === tapped ? "incorrect" : "idle");
          else if (i === tapped) status = "selected";
          const s = {
            idle: { bg: "transparent", border: "transparent" },
            selected: { bg: "rgba(201,164,92,0.12)", border: T.gold },
            correct: { bg: "rgba(46,125,83,0.18)", border: T.teal },
            incorrect: { bg: "rgba(201,122,107,0.18)", border: T.danger },
          }[status];
          return (
            <button key={i} onClick={() => tap(i)} style={{
              ...arabicFont, fontSize: 26, color: T.parchment, background: s.bg,
              border: `1.5px solid ${s.border}`, borderRadius: 10, padding: "5px 9px", cursor: "pointer",
              boxShadow: speakingIdx === i && !reducedMotion ? "0 0 0 3px rgba(201,164,92,0.18)" : "none",
              animation: status === "incorrect" && !reducedMotion ? "quizShake 0.35s ease" : "none",
            }}>{c.ar}</button>
          );
        })}
      </div>
      {phase === "feedback" && <QuizFeedback correct={tapped === q.correctAnswer} explanation={q.explanation} reducedMotion={reducedMotion} />}
    </div>
  );
}

// Build the whole phrase by tapping its words in the correct order.
function QuestionOrder({ q, phase, onAnswer, reducedMotion }) {
  const [pool, setPool] = useState(() => shuffleArray(q.chunks.map((_, i) => i)));
  const [built, setBuilt] = useState([]);
  const [wrong, setWrong] = useState(false);
  const [speakingIdx, setSpeakingIdx] = useState(null);
  const [erroredIdx, setErroredIdx] = useState(null);

  React.useEffect(() => () => stopResolvedAudio(), []);

  function place(i) {
    if (phase !== "question") return;
    const nextBuilt = [...built, i];
    setBuilt(nextBuilt);
    setPool((p) => p.filter((x) => x !== i));
    if (nextBuilt.length === q.chunks.length) {
      const correct = nextBuilt.every((v, idx) => v === q.correctAnswer[idx]);
      setWrong(!correct);
      onAnswer(correct, q.concept, q.type);
    }
  }
  function removeLast() {
    if (phase !== "question" || !built.length) return;
    const last = built[built.length - 1];
    setBuilt((b) => b.slice(0, -1));
    setPool((p) => [...p, last]);
  }
  // Hearing a word is independent of placing it — a separate tap
  // target on each tile, so tapping to listen never accidentally
  // places the word too.
  function hearWord(i, e) {
    e.stopPropagation();
    const audio = q.wordAudio?.[i];
    setErroredIdx((cur) => (cur === i ? null : cur));
    if (!audio) {
      setSpeakingIdx(i);
      speakArabic(q.chunks[i].ar, {
        onStart: () => setSpeakingIdx(i),
        onEnd: () => setSpeakingIdx((cur) => (cur === i ? null : cur)),
        onError: () => { setErroredIdx(i); setSpeakingIdx((cur) => (cur === i ? null : cur)); },
      });
      return;
    }
    setSpeakingIdx(i);
    playResolvedAudio(audio, {
      onStart: () => setSpeakingIdx(i),
      onEnd: () => setSpeakingIdx((cur) => (cur === i ? null : cur)),
      onError: () => { setErroredIdx(i); setSpeakingIdx((cur) => (cur === i ? null : cur)); },
    });
  }

  return (
    <div>
      <div style={{ ...bodySans, fontSize: 13, color: T.textLo, textAlign: "center", marginBottom: 4 }}>{q.prompt}</div>
      {q.translation && (
        <div style={{ ...displaySerif, fontSize: 17, color: T.textHi, fontStyle: "italic", textAlign: "center", lineHeight: 1.4, margin: "6px 10px 10px" }}>
          "{q.translation}"
        </div>
      )}
      <div style={{ ...bodySans, fontSize: 11, color: T.textFaint, textAlign: "center", marginBottom: 14 }}>Tap 🔊 to hear a word before placing it</div>
      <div
        dir="rtl"
        onClick={removeLast}
        style={{
          minHeight: 64, borderRadius: 14, border: `1.5px dashed ${wrong && phase === "feedback" ? T.danger : T.inkLine}`,
          background: T.inkRaised, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "center",
          padding: 12, marginBottom: 18, cursor: built.length ? "pointer" : "default",
          animation: wrong && phase === "feedback" && !reducedMotion ? "quizShake 0.35s ease" : "none",
        }}
      >
        {built.length === 0 && <span style={{ ...bodySans, fontSize: 12, color: T.textFaint }}>Tap words below, in order</span>}
        {built.map((i, pos) => (
          <span key={pos} style={{ ...arabicFont, fontSize: 24, color: T.goldSoft }}>{q.chunks[i].ar}</span>
        ))}
      </div>
      <div dir="rtl" style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
        {pool.map((i) => {
          const isSpeaking = speakingIdx === i;
          const isErrored = erroredIdx === i;
          return (
            <div key={i} style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              background: "rgba(255,255,255,0.03)",
              border: `1.5px solid ${isErrored ? T.danger : isSpeaking ? T.gold : T.inkLine}`,
              borderRadius: 12, padding: "7px 12px 8px",
              boxShadow: isSpeaking && !reducedMotion ? "0 0 0 3px rgba(201,164,92,0.16)" : "none",
              transition: "border-color 0.2s ease, box-shadow 0.2s ease",
            }}>
              <button
                onClick={(e) => hearWord(i, e)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
                aria-label="Hear this word"
              >
                {isErrored ? <RetryIcon size={12} color={T.danger} /> : <SpeakerIcon size={12} color={isSpeaking ? T.gold : T.textFaint} active={isSpeaking} />}
              </button>
              <button
                onClick={() => place(i)} disabled={phase !== "question"}
                style={{ ...arabicFont, fontSize: 22, color: T.parchment, background: "none", border: "none", padding: 0, cursor: "pointer" }}
              >{q.chunks[i].ar}</button>
            </div>
          );
        })}
      </div>
      {phase === "feedback" && wrong && (
        <div dir="rtl" style={{ ...bodySans, fontSize: 11.5, color: T.textFaint, textAlign: "center", marginTop: 12 }}>
          Correct order: <span style={{ ...arabicFont, fontSize: 16, color: T.tealSoft }}>{q.correctAnswer.map((i) => q.chunks[i].ar).join(" ")}</span>
        </div>
      )}
      {phase === "feedback" && <QuizFeedback correct={!wrong} explanation={q.explanation} reducedMotion={reducedMotion} />}
    </div>
  );
}

function Checkpoint({ message, onContinue }) {
  return (
    <div style={{ padding: "44px 6px 0", textAlign: "center" }}>
      <div style={{ fontSize: 30, marginBottom: 14 }}>✨</div>
      <div style={{ ...displaySerif, fontSize: 20, color: T.textHi, fontStyle: "italic", lineHeight: 1.4, marginBottom: 30 }}>{message}</div>
      <PrimaryButton onClick={onContinue}>Continue</PrimaryButton>
    </div>
  );
}

function CompletionRow({ icon, text }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 12, background: T.inkRaised, border: `1px solid ${T.inkLine}` }}>
      <div style={{ fontSize: 18 }}>{icon}</div>
      <div style={{ ...bodySans, fontSize: 13.5, color: T.textHi }}>{text}</div>
    </div>
  );
}

function QuizCompletion({ mode, wordCount, ayahCount, surahName, accuracy, bestStreak, hasMistakes, onContinue, onReviewMistakes }) {
  const isSurah = mode === "surah";
  return (
    <div style={{ textAlign: "center", padding: "16px 4px 0" }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>{isSurah ? "🕌" : "🌙"}</div>
      <div style={{ ...displaySerif, fontSize: 24, fontWeight: 600, color: T.textHi, marginBottom: 4 }}>
        {isSurah ? `${surahName} Complete` : "Lesson Complete"}
      </div>
      <div style={{ ...bodySans, fontSize: 13, color: T.textLo, marginBottom: 24 }}>You learned:</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, textAlign: "left", marginBottom: 24 }}>
        <CompletionRow icon="📖" text={`${wordCount} Quranic word${wordCount === 1 ? "" : "s"}`} />
        {isSurah
          ? <CompletionRow icon="🕊️" text={`Every ayah of ${surahName}${ayahCount ? ` — all ${ayahCount}` : ""}`} />
          : <CompletionRow icon="🕊️" text="The meaning of this phrase" />}
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 26 }}>
        <Stat label="Accuracy" value={`${accuracy}%`} />
        <Stat label="Best streak" value={bestStreak > 0 ? `🔥 ${bestStreak}` : "—"} />
      </div>
      <PrimaryButton onClick={onContinue}>Continue</PrimaryButton>
      {hasMistakes && (
        <button onClick={onReviewMistakes} style={{ ...bodySans, fontSize: 13, color: T.textLo, background: "none", border: "none", marginTop: 14, cursor: "pointer", textDecoration: "underline" }}>
          Review what I missed
        </button>
      )}
    </div>
  );
}

function QuizQuestionCard({ q, phase, selected, onSelect, onAnswer, reducedMotion }) {
  if (q.type === "order") return <QuestionOrder q={q} phase={phase} onAnswer={onAnswer} reducedMotion={reducedMotion} />;
  if (q.type === "tapAyah") return <QuestionTapAyah q={q} phase={phase} onAnswer={onAnswer} reducedMotion={reducedMotion} />;
  return <QuestionOptions q={q} phase={phase} selected={selected} onSelect={onSelect} onAnswer={onAnswer} reducedMotion={reducedMotion} />;
}

// Orchestrates the whole practice session: builds the question
// queue, tracks streak/accuracy/mistakes, and adaptively appends a
// differently-formatted follow-up whenever a concept is missed.
// mode "ayah" (default): chunks + resolveChunkAudio, as before.
// mode "surah": surahId + ayat (all of a surah's AYAT entries) —
// spans every ayah's chunks in one comprehensive session, using the
// exact same question renderers and real-audio resolution.
function QuizSession({ mode = "ayah", chunks, resolveChunkAudio, surahId, ayat, surahName, onComplete }) {
  const reducedMotion = React.useMemo(prefersReducedMotion, []);
  const [{ initialQueue, wordCount: totalWordCount }] = useState(() => {
    if (mode === "surah") {
      const built = buildSurahQuizQuestions(surahId, ayat);
      return { initialQueue: withSurahCheckpoints(built.questions, surahName, built.wordCount), wordCount: built.wordCount };
    }
    return { initialQueue: withQuizCheckpoints(buildQuizQuestions(chunks, resolveChunkAudio), chunks.length), wordCount: chunks.length };
  });
  const [queue, setQueue] = useState(initialQueue);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState("question"); // question | feedback | complete
  const [selected, setSelected] = useState(null);
  const [lastCorrect, setLastCorrect] = useState(true);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [missed, setMissed] = useState(() => new Set());
  const [milestone, setMilestone] = useState(null);
  const shownMilestones = React.useRef(new Set());
  const advanceTimer = React.useRef(null);
  const milestoneTimer = React.useRef(null);
  // A ref (not state) guards against a question being answered more
  // than once — child components check the `phase` prop before
  // calling onAnswer, but that's a snapshot from the last render, so
  // two taps arriving in the same tick (a fast double-tap, or a
  // stray extra event) could both read "question" and both fire.
  // The ref updates synchronously, so the second call is always
  // rejected regardless of render timing.
  const answerLockRef = React.useRef(false);

  React.useEffect(() => () => {
    clearTimeout(advanceTimer.current);
    clearTimeout(milestoneTimer.current);
    stopResolvedAudio();
  }, []);

  const current = queue[index];
  const answerableTotal = queue.filter((q) => q.type !== "checkpoint").length;
  const answerableSoFar = queue.slice(0, index).filter((q) => q.type !== "checkpoint").length;

  function goNext() {
    stopResolvedAudio();
    setSelected(null);
    answerLockRef.current = false;
    setIndex((i) => {
      const next = i + 1;
      if (next >= queue.length) { setPhase("complete"); return i; }
      setPhase(queue[next].type === "checkpoint" ? "checkpoint" : "question");
      return next;
    });
  }

  function handleAnswer(isCorrect, concept, missedType) {
    if (answerLockRef.current) return;
    answerLockRef.current = true;
    setAnsweredCount((c) => c + 1);
    hapticPulse(isCorrect ? 10 : [15, 40, 15]);
    if (isCorrect) {
      setCorrectCount((c) => c + 1);
      // Getting it right this time — even via the immediate
      // different-format retry a miss triggers — means they no
      // longer need it flagged for the end-of-session review loop.
      // Only a concept that's STILL wrong when the session ends
      // stays queued for "Review what I missed".
      setMissed((m) => (m.has(concept) ? (() => { const n = new Set(m); n.delete(concept); return n; })() : m));
      setStreak((s) => {
        const next = s + 1;
        setBestStreak((b) => Math.max(b, next));
        if ([3, 5, 10].includes(next) && !shownMilestones.current.has(next)) {
          shownMilestones.current.add(next);
          setMilestone(next === 10 ? "10 in a row 🔥🔥" : next === 5 ? "5 in a row 🔥" : "3 in a row");
          clearTimeout(milestoneTimer.current);
          milestoneTimer.current = setTimeout(() => setMilestone(null), 1400);
        }
        return next;
      });
    } else {
      setStreak(0);
      setMissed((m) => new Set(m).add(concept));
      const followUp = mode === "surah"
        ? buildSurahFollowUp(concept, missedType, surahId, ayat)
        : buildFollowUp(concept, missedType, chunks, resolveChunkAudio);
      if (followUp) setQueue((q) => [...q, followUp]);
    }
    setLastCorrect(isCorrect);
    setPhase("feedback");
    clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(goNext, isCorrect ? 1000 : 1900);
  }

  function handleReviewMistakes() {
    const seen = new Set();
    const fresh = [];
    queue.forEach((q) => {
      if (q.type === "checkpoint" || !missed.has(q.concept) || seen.has(q.concept)) return;
      seen.add(q.concept);
      const followUp = mode === "surah"
        ? buildSurahFollowUp(q.concept, "__review__", surahId, ayat)
        : buildFollowUp(q.concept, "__review__", chunks, resolveChunkAudio);
      if (followUp) fresh.push(followUp);
    });
    if (!fresh.length) return;
    answerLockRef.current = false;
    setQueue(fresh);
    setIndex(0);
    // Cleared, not just hidden — this pass's own right/wrong answers
    // repopulate it, so if something is missed again the review
    // option comes right back at the next completion screen. That's
    // what makes this a loop rather than a one-shot retry: keep
    // reviewing the same concept, in a fresh format each time, until
    // an entire pass comes back clean.
    setMissed(new Set());
    setSelected(null);
    setPhase("question");
  }

  if (phase === "complete") {
    return (
      <div>
        <QuizStyles />
        <QuizCompletion
          mode={mode}
          wordCount={totalWordCount}
          ayahCount={mode === "surah" ? ayat.length : undefined}
          surahName={surahName}
          accuracy={answeredCount ? Math.round((correctCount / answeredCount) * 100) : 100}
          bestStreak={bestStreak}
          hasMistakes={missed.size > 0}
          onContinue={onComplete}
          onReviewMistakes={handleReviewMistakes}
        />
      </div>
    );
  }

  return (
    <div>
      <QuizStyles />
      <QuizProgressBar total={answerableTotal} done={answerableSoFar} streak={streak} reducedMotion={reducedMotion} />
      {milestone && <MilestoneBanner text={milestone} reducedMotion={reducedMotion} />}
      {phase === "checkpoint"
        ? <Checkpoint message={current.message} onContinue={goNext} />
        : current && (
          <QuizQuestionCard
            key={current.id}
            q={current} phase={phase} selected={selected}
            onSelect={setSelected} onAnswer={handleAnswer} reducedMotion={reducedMotion}
          />
        )}
    </div>
  );
}

/* ============================================================
   LESSON FLOW — the 8-step core learning loop
   ============================================================ */
function LessonFlow({ ayah, title, subtitle, audioRef, preferredReciterId, onExit, onFinish, onWordSeen, onMemorize }) {
  const [step, setStep] = useState(0); // 0 hear/discover, 1 practice (quiz), 2 understand, 3 hear again/check, 4 connect
  const [revealed, setRevealed] = useState(new Set());
  const [reciting, setReciting] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const [voiceErrorReason, setVoiceErrorReason] = useState(null); // salah (TTS) failures only
  const [activeReciter, setActiveReciter] = useState(null);

  const chunks = ayah.chunks;
  const allRevealed = revealed.size === chunks.length;

  // Each chunk's Arabic text is a space-separated slice of the full
  // ayah, so its word position range within the ayah can be derived
  // just by counting words as we walk the chunks in order — no
  // hand-maintained word-index data needed, and it can't drift out
  // of sync with the chunk text itself.
  const wordRanges = useMemo(() => {
    let cursor = 1;
    return chunks.map((c) => {
      const count = c.ar.trim().split(/\s+/).length;
      const range = { start: cursor, end: cursor + count - 1 };
      cursor += count;
      return range;
    });
  }, [chunks]);

  // Every chunk having its own verified word clip (true for takbir)
  // means the full phrase can be built from real audio too, even
  // with no continuous recording of the phrase to draw on.
  const wordSequence = React.useMemo(
    () => chunks.every((c) => c.wordAudioUrl) ? chunks.map((c) => c.wordAudioUrl) : null,
    [chunks]
  );

  // Toggle real recitation, in priority order: verified Qari
  // recitation for Quran ayat; a real recorded clip (Hisn al-Muslim)
  // for salah phrases that have one; a sequence of real per-word
  // clips for phrases with neither but where every word is
  // individually verified (takbir); the synthesized voice only as
  // an absolute last resort — and if that fails too, playback
  // reports an error rather than staying silent.
  function toggleRecitation() {
    if (reciting) {
      stopRecitation();
      stopPhraseAudio();
      setReciting(false);
      return;
    }
    if (audioRef) {
      setAudioError(false);
      playRecitation({
        surahId: audioRef.surahId,
        ayahNum: audioRef.ayahNum,
        preferredReciterId,
        onStart: (reciter) => { setReciting(true); setActiveReciter(reciter); },
        onEnd: () => setReciting(false),
        onError: () => setAudioError(true),
      });
    } else if (ayah.audioUrl) {
      setAudioError(false);
      playPhraseAudio(ayah.audioUrl, {
        startTime: ayah.audioStart,
        endTime: ayah.audioEnd,
        onStart: () => setReciting(true),
        onEnd: () => setReciting(false),
        onError: () => setAudioError(true),
      });
    } else if (wordSequence) {
      setAudioError(false);
      playAudioSequence(wordSequence, {
        onStart: () => setReciting(true),
        onEnd: () => setReciting(false),
        onError: () => setAudioError(true),
      });
    } else {
      setAudioError(false);
      setVoiceErrorReason(null);
      speakArabic(ayah.ar, {
        rate: 0.75,
        onStart: () => setReciting(true),
        onEnd: () => setReciting(false),
        onError: (reason) => { setReciting(false); setAudioError(true); setVoiceErrorReason(reason); },
      });
    }
  }

  // Stop any in-flight recitation when the step changes (or the
  // lesson is exited), so audio never keeps running in the background.
  React.useEffect(() => {
    return () => {
      stopRecitation();
      stopWordAudio();
      stopPhraseAudio();
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, []);
  React.useEffect(() => {
    stopRecitation();
    stopWordAudio();
    stopPhraseAudio();
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    setReciting(false);
    setAudioError(false);
    setVoiceErrorReason(null);
  }, [step]);

  // Resolves the same real-audio source a chunk's own tap would play,
  // in the same priority order used everywhere else — so anything
  // that replays this word later (Quiz, Quick Review) uses real
  // audio too. Deliberately does NOT fall back to the full phrase
  // or the synthesized voice when a word has no isolated source —
  // a per-word tap should only ever produce that word's own audio,
  // or an honest "not available", never a broader scope.
  function resolveChunkAudio(i) {
    if (chunks[i].wordAudioUrl) return { kind: "word", url: chunks[i].wordAudioUrl };
    if (audioRef && wordRanges) {
      const range = wordRanges[i];
      return { kind: "quranWord", surahId: audioRef.surahId, ayahNum: audioRef.ayahNum, start: range.start, end: range.end };
    }
    return null; // no verified isolated source for this word
  }

  function tapChunk(i) {
    setRevealed((r) => {
      const n = new Set(r);
      n.add(i);
      return n;
    });
    onWordSeen(chunks[i].ar, chunks[i].m, resolveChunkAudio(i));
  }


  const steps = ["Hear it", "Discover it", "Understand it", "Hear it again", "Connect it"];

  return (
    <Screen>
      <FontLoader />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px 6px" }}>
        <button onClick={onExit} style={iconBtnStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke={T.textHi} strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo }}>{title} · {subtitle}</div>
        <div style={{ width: 32 }} />
      </div>
      <div style={{ display: "flex", gap: 4, padding: "0 20px 10px" }}>
        {steps.map((_, i) => (
          <div key={i} style={{ height: 3, flex: 1, borderRadius: 2, background: i <= step ? T.gold : T.inkLine }} />
        ))}
      </div>

      <div style={{ padding: "6px 20px 0" }}>
        {/* STEP 0: Hear it / Discover it */}
        {step === 0 && (
          <>
            <StepLabel n={1} text="Hear it" />
            <div style={{ marginTop: 12 }}>
              <ArabicCenterpiece ar={ayah.ar} />
              <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
                <button
                  onClick={toggleRecitation}
                  style={{
                    ...iconBtnStyle, width: 46, height: 46, borderRadius: 99,
                    background: audioError ? "transparent" : T.gold,
                    borderColor: audioError ? T.danger : T.gold,
                    boxShadow: reciting ? "0 0 0 6px rgba(201,164,92,0.16)" : "none", transition: "box-shadow 0.2s ease",
                  }}
                >
                  {audioError ? <RetryIcon color={T.danger} /> : <PlayPauseIcon playing={reciting} />}
                </button>
              </div>
              <div style={{ ...bodySans, fontSize: 12, color: audioError ? T.danger : T.textFaint, textAlign: "center", marginTop: 8 }}>
                {audioError
                  ? (voiceErrorReason === "no-arabic-voice"
                      ? "No Arabic voice found on this device — tap to retry"
                      : "Couldn't play pronunciation — tap to retry")
                  : reciting ? "Playing…" : "Tap to play recitation"}
                {!audioError && (
                  <span style={{ display: "block", fontSize: 10.5, marginTop: 2, color: T.textFaint }}>
                    {audioRef
                      ? (activeReciter?.label || RECITERS[0].label)
                      : ayah.audioUrl ? SALAH_AUDIO_LABEL
                      : wordSequence ? "Real Quran word audio"
                      : "Synthesized voice"}
                  </span>
                )}
              </div>
            </div>

            <StepLabel n={2} text="Discover it" style={{ marginTop: 28 }} />
            <p style={{ ...bodySans, fontSize: 12.5, color: T.textLo, margin: "6px 0 14px" }}>Tap each piece to reveal its meaning.</p>
            <ArabicChunks
              chunks={chunks} revealed={revealed} onTap={tapChunk}
              audioRef={audioRef} ayahNum={audioRef?.ayahNum} wordRanges={wordRanges}
            />
          </>
        )}

        {/* STEP 1: Practice (adaptive quiz session) */}
        {step === 1 && (
          <QuizSession chunks={chunks} resolveChunkAudio={resolveChunkAudio} onComplete={() => setStep(2)} />
        )}

        {/* STEP 2: Understand it */}
        {step === 2 && (
          <>
            <StepLabel n={4} text="Understand it" />
            <div style={{ marginTop: 12 }}><ArabicCenterpiece ar={ayah.ar} small /></div>
            <div style={{ marginTop: 16, padding: 16, borderRadius: 14, background: T.inkRaised, border: `1px solid ${T.inkLine}` }}>
              <div style={{ ...bodySans, fontSize: 11.5, color: T.textFaint, marginBottom: 6 }}>WHAT THIS MEANS</div>
              <div style={{ ...bodySans, fontSize: 14, color: T.textHi, lineHeight: 1.6 }}>{ayah.gist}</div>
            </div>
          </>
        )}

        {/* STEP 3: Hear it again / check understanding */}
        {step === 3 && (
          <>
            <StepLabel n={5} text="Hear it again" />
            <p style={{ ...bodySans, fontSize: 13, color: T.textLo, margin: "8px 0 14px" }}>No translation this time. Just listen — and notice what you understand.</p>
            <ArabicCenterpiece ar={ayah.ar} />
            <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
              <button
                onClick={toggleRecitation}
                style={{
                  ...iconBtnStyle, width: 46, height: 46, borderRadius: 99,
                  background: audioError ? "transparent" : T.gold,
                  borderColor: audioError ? T.danger : T.gold,
                  boxShadow: reciting ? "0 0 0 6px rgba(201,164,92,0.16)" : "none", transition: "box-shadow 0.2s ease",
                }}
              >
                {audioError ? <RetryIcon color={T.danger} /> : <PlayPauseIcon playing={reciting} />}
              </button>
            </div>
            {audioError && (
              <div style={{ ...bodySans, fontSize: 12, color: T.danger, textAlign: "center", marginTop: 8 }}>
                {voiceErrorReason === "no-arabic-voice"
                  ? "No Arabic voice found on this device — tap to retry"
                  : "Couldn't play pronunciation — tap to retry"}
              </div>
            )}
          </>
        )}

        {/* STEP 4: Connect it */}
        {step === 4 && (
          <>
            <StepLabel n={6} text="Connect it" />
            <div style={{ marginTop: 14, padding: 18, borderRadius: 16, background: `linear-gradient(150deg, rgba(201,164,92,0.1), rgba(46,125,83,0.06))`, border: `1px solid rgba(201,164,92,0.3)` }}>
              <div style={{ ...bodySans, fontSize: 11.5, color: T.gold, marginBottom: 8, letterSpacing: 0.3 }}>WHAT THIS MEANS FOR YOU</div>
              <div style={{ ...displaySerif, fontSize: 17, color: T.textHi, lineHeight: 1.5, fontStyle: "italic" }}>{ayah.connect}</div>
            </div>
            <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 22 }}>✨</div>
              <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo }}>You understood this without needing the full English underneath. That's the whole point.</div>
            </div>
            {onMemorize && (
              <div
                onClick={onMemorize}
                style={{
                  marginTop: 18, display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "14px 16px", borderRadius: 14, background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 20 }}>🧠</div>
                  <div>
                    <div style={{ ...displaySerif, fontSize: 15, color: T.textHi }}>Memorize this ayah now</div>
                    <div style={{ ...bodySans, fontSize: 11.5, color: T.textLo, marginTop: 2 }}>Right while the meaning's fresh</div>
                  </div>
                </div>
                <span style={{ color: T.gold, fontSize: 16 }}>→</span>
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, padding: 20, background: `linear-gradient(0deg, ${T.ink} 60%, transparent)` }}>
        {step === 0 && <PrimaryButton disabled={!allRevealed} onClick={() => setStep(1)}>{allRevealed ? "Continue" : "Reveal every piece to continue"}</PrimaryButton>}
        {/* Step 1 (practice) manages its own inline actions — the quiz
            questions auto-advance, and the completion screen has its
            own Continue button — so the fixed bar stays empty here. */}
        {step === 2 && <PrimaryButton onClick={() => setStep(3)}>Hear it once more</PrimaryButton>}
        {step === 3 && <PrimaryButton onClick={() => setStep(4)}>I understood it</PrimaryButton>}
        {step === 4 && <PrimaryButton onClick={onFinish}>Done</PrimaryButton>}
      </div>
    </Screen>
  );
}

function StepLabel({ n, text, style }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, ...style }}>
      <div style={{ width: 22, height: 22, borderRadius: 99, border: `1px solid ${T.gold}`, color: T.gold, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", ...mono }}>{n}</div>
      <div style={{ ...displaySerif, fontSize: 18, color: T.textHi, fontStyle: "italic" }}>{text}</div>
    </div>
  );
}

/* ============================================================
   MEMORIZATION — recall input (speech, with typed fallback)
   Speech recognition here is the BROWSER's own on-device/cloud STT
   (Web Speech API), not a synthesized-voice concern — it's input,
   not output, so it doesn't touch the app's "never synthesize
   Quran recitation" rule at all. Browser support for Arabic speech
   recognition is genuinely inconsistent (spotty on desktop Safari
   and some Android browsers), so this always offers typed recall
   as a real, equally-functional fallback, not just an error state.
   ============================================================ */
// Whether the BROWSER's own SpeechRecognition API exists. This is
// never true inside the native iOS build's webview — WebKit has
// never implemented it there — which is exactly why the native
// branch below exists as the real substitute for that platform.
function browserSpeechRecognitionSupported() {
  return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
// True only once actually running as the wrapped native app (never
// on the plain website, where this is always false and every call
// below is skipped in favor of the browser API).
function isNativeApp() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}
function speechRecognitionSupported() {
  return isNativeApp() || browserSpeechRecognitionSupported();
}

// A rough visual placeholder for an unspoken word — a run of tatweel
// (Arabic kashida) dashes, roughly scaled to the real word's length,
// so the blank page has the right "shape" before anything fills in.
function arabicWordPlaceholder(word) {
  const len = Math.max(2, Math.min(7, word.replace(/[^ء-ي]/g, "").length || 3));
  return "ـ".repeat(len);
}

// The Tartil-style "blank Quran page that fills in as you recite"
// display. `wordResults` (from recallMatch.matchRecall, recomputed
// live on every speech-recognition update) is aligned index-for-
// index with `expectedWords` — a word is only ever revealed once
// recognition has actually matched (or misheard) something against
// its position; everything after the furthest point reached stays a
// blank placeholder, exactly like an empty manuscript line waiting
// to be written.
function QuranPageReveal({ expectedWords, wordResults, listening }) {
  const nextIndex = wordResults ? wordResults.findIndex((w) => !w) : 0;
  return (
    <div style={{
      background: `linear-gradient(180deg, ${T.parchment}, ${T.parchmentDim})`,
      borderRadius: 20, padding: "26px 20px", textAlign: "center", minHeight: 120,
      boxShadow: "0 20px 40px -20px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(201,164,92,0.4)",
      position: "relative", overflow: "hidden",
    }}>
      <div style={{ position: "absolute", top: 8, left: 8, right: 8, bottom: 8, border: `1px solid rgba(201,164,92,0.35)`, borderRadius: 12, pointerEvents: "none" }} />
      <div dir="rtl" style={{ ...arabicFont, fontSize: 24, lineHeight: 2.2, display: "flex", flexWrap: "wrap", gap: "2px 10px", justifyContent: "center" }}>
        {expectedWords.map((w, i) => {
          const r = wordResults?.[i];
          const isNext = listening && i === nextIndex;
          if (r?.status === "correct") {
            return <span key={i} style={{ color: "#26201a", transition: "color 0.2s ease" }}>{w}</span>;
          }
          if (r?.status === "wrong") {
            return (
              <span key={i} style={{ color: T.danger, textDecoration: "underline wavy", textUnderlineOffset: 3 }}>
                {w}
              </span>
            );
          }
          return (
            <span key={i} style={{
              color: "rgba(38,32,26,0.24)",
              paddingBottom: isNext ? 1 : 0,
              borderBottom: isNext ? `2px solid ${T.gold}` : "2px solid transparent",
              transition: "border-color 0.2s ease",
            }}>{arabicWordPlaceholder(w)}</span>
          );
        })}
      </div>
    </div>
  );
}

function RecallInput({ expectedText, onResult }) {
  const supported = useMemo(() => speechRecognitionSupported(), []);
  const [mode, setMode] = useState(supported ? "speech" : "text");
  const [listening, setListening] = useState(false);
  const [typedValue, setTypedValue] = useState("");
  const [speechError, setSpeechError] = useState(null);
  const [finalHeard, setFinalHeard] = useState("");   // confirmed-final chunks, accumulated
  const [interimHeard, setInterimHeard] = useState(""); // current in-progress guess, replaced each event
  const recognitionRef = React.useRef(null);
  const nativeMatchesRef = React.useRef([]); // latest partialResults matches from the native plugin
  const nativeListenerRef = React.useRef(null);
  const native = useMemo(() => isNativeApp(), []);

  React.useEffect(() => () => {
    recognitionRef.current?.stop();
    if (native) {
      NativeSpeechRecognition.stop().catch(() => {});
      NativeSpeechRecognition.removeAllListeners().catch(() => {});
    }
  }, [native]);

  const liveHeard = (finalHeard + " " + interimHeard).trim();
  const expectedWords = useMemo(() => expectedText.trim().split(/\s+/), [expectedText]);
  // Recomputed on every recognition update (final AND interim, so
  // the page fills in continuously rather than jumping only when a
  // result finalizes) — matchRecall's own word alignment is what
  // decides which expected words are "reached" yet, reused as-is
  // rather than a separate live-only matcher.
  const liveWordResults = useMemo(
    () => (liveHeard ? matchRecall(expectedText, liveHeard).wordResults : null),
    [liveHeard, expectedText]
  );

  function finishWith(transcript) {
    setListening(false);
    if (!transcript.trim()) {
      setSpeechError("Didn't catch anything that time — try again, or type it instead.");
      return;
    }
    onResult(matchRecall(expectedText, transcript), transcript);
    setFinalHeard("");
    setInterimHeard("");
  }

  // Native path (the real iOS app build): the browser's
  // SpeechRecognition API doesn't exist inside that webview at
  // all, so this goes through @capacitor-community/speech-
  // recognition instead, which bridges to iOS's own on-device
  // speech recognizer. Same end result — live partial text feeds
  // the same QuranPageReveal component, and finishWith() does the
  // same real scoring either way — just a different source feeding it.
  async function startListeningNative() {
    setSpeechError(null);
    setFinalHeard("");
    setInterimHeard("");
    nativeMatchesRef.current = [];
    try {
      let perm = await NativeSpeechRecognition.checkPermissions();
      if (perm.speechRecognition !== "granted") {
        perm = await NativeSpeechRecognition.requestPermissions();
      }
      if (perm.speechRecognition !== "granted") {
        setSpeechError("Microphone/speech access was denied — allow it in your device's Settings, or type instead.");
        return;
      }
      nativeListenerRef.current = await NativeSpeechRecognition.addListener("partialResults", (data) => {
        const matches = data?.matches || [];
        nativeMatchesRef.current = matches;
        setInterimHeard(matches[0] || "");
      });
      setListening(true);
      // partialResults:true makes this resolve right away (results
      // stream through the listener above instead), matching the
      // browser path's "live as you go" feel rather than waiting
      // silently for one final blob of text.
      await NativeSpeechRecognition.start({ language: "ar-SA", partialResults: true, popup: false, maxResults: 5 });
    } catch {
      setListening(false);
      setSpeechError("Couldn't start the microphone — try again, or type instead.");
    }
  }

  async function stopListeningNative() {
    try { await NativeSpeechRecognition.stop(); } catch {}
    try { await nativeListenerRef.current?.remove(); } catch {}
    const matches = nativeMatchesRef.current || [];
    // Same "which alternative actually matches the real ayah"
    // scoring trick used on the browser path, applied to whatever
    // the native recognizer's own ranked alternatives were.
    let best = matches[0] || "";
    if (matches.length > 1) {
      let bestScore = -1;
      for (const m of matches) {
        const acc = matchRecall(expectedText, m).accuracy;
        if (acc > bestScore) { bestScore = acc; best = m; }
      }
    }
    finishWith(best);
  }

  function startListening() {
    if (native) { startListeningNative(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setMode("text"); return; }
    setSpeechError(null);
    setFinalHeard("");
    setInterimHeard("");
    const rec = new SR();
    rec.lang = "ar-SA";
    rec.interimResults = true; // live "as you go" feedback — this was previously off, which is why nothing visibly happened while listening
    rec.continuous = true;     // keep listening through natural pauses in the ayah instead of cutting off after the first one
    // Multiple alternatives per result, not just the engine's single
    // top guess — Arabic recitation has a lot of near-homophones the
    // STT engine ranks close together, and its #1 guess is often not
    // the one that actually matches real Quran text. Whenever a
    // result finalizes, every alternative is scored against the
    // expected ayah (via the same matchRecall used for grading) and
    // whichever one aligns best is kept — a cheap, real accuracy win
    // since we actually know what the "correct answer" should sound
    // like, unlike a generic dictation use case.
    rec.maxAlternatives = 5;
    // Plain closure variables, not state — onend needs the truly
    // latest value the instant recognition stops, and reading React
    // state from inside this closure would be stale (captured at
    // the render where startListening was created, not updated live).
    let finalAcc = "";
    let interimAcc = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          let bestChunk = result[0]?.transcript || "";
          if (result.length > 1) {
            let bestScore = -1;
            for (let a = 0; a < result.length; a++) {
              const candidate = result[a]?.transcript || "";
              const acc = matchRecall(expectedText, (finalAcc + " " + candidate).trim()).accuracy;
              if (acc > bestScore) { bestScore = acc; bestChunk = candidate; }
            }
          }
          finalAcc = (finalAcc + " " + bestChunk).trim();
        } else {
          interim += result[0]?.transcript || "";
        }
      }
      interimAcc = interim;
      setFinalHeard(finalAcc);
      setInterimHeard(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech") return; // continuous mode: let onend handle it, don't interrupt an otherwise-working session
      setListening(false);
      setSpeechError(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access was denied — allow it in your browser, or type instead."
          : "Couldn't hear that clearly — try again, or switch to typing."
      );
    };
    rec.onend = () => {
      // Whatever was heard — finalized or still just an interim guess
      // at the moment recognition stopped — is what gets checked.
      // Previously only a true "final" result counted, so a session
      // that ended (browser timeout, tapping stop) before the engine
      // finalized anything looked like it did nothing at all.
      finishWith((finalAcc + " " + interimAcc).trim());
    };
    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  }
  function stopListening() {
    if (native) { stopListeningNative(); return; }
    recognitionRef.current?.stop(); // triggers onend, which finalizes with whatever's been heard so far
  }
  function submitTyped() {
    if (!typedValue.trim()) return;
    onResult(matchRecall(expectedText, typedValue), typedValue);
    setTypedValue("");
  }

  if (mode === "speech") {
    return (
      <div style={{ textAlign: "center" }}>
        <div style={{ marginBottom: 16 }}>
          <QuranPageReveal expectedWords={expectedWords} wordResults={liveWordResults} listening={listening} />
        </div>
        <button
          onClick={listening ? stopListening : startListening}
          style={{
            width: 72, height: 72, borderRadius: 99, border: "none", cursor: "pointer",
            background: listening ? `linear-gradient(135deg, ${T.gold}, #B5893F)` : T.inkRaised,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28,
            boxShadow: listening ? "0 0 0 8px rgba(201,164,92,0.15)" : "none",
            transition: "box-shadow 0.3s ease",
          }}
          aria-label={listening ? "Stop listening" : "Tap to recite"}
        >🎙️</button>
        <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo, marginTop: 10 }}>
          {listening ? "Listening… tap the mic when you're done" : "Tap and recite it aloud"}
        </div>
        <div style={{ ...bodySans, fontSize: 10.5, color: T.textFaint, marginTop: 6, lineHeight: 1.4 }}>
          Uses your microphone only to check what you recited against the real text — nothing is recorded, saved, or sent anywhere beyond that one check.
        </div>
        {speechError && (
          <div style={{ ...bodySans, fontSize: 11.5, color: T.danger, marginTop: 8 }}>{speechError}</div>
        )}
        <div style={{ marginTop: 12 }}>
          <GhostButton onClick={() => { stopListening(); setMode("text"); }}>Type it instead</GhostButton>
        </div>
      </div>
    );
  }

  return (
    <div>
      <textarea
        dir="rtl"
        value={typedValue}
        onChange={(e) => setTypedValue(e.target.value)}
        placeholder="اكتب الآية…"
        rows={3}
        style={{
          width: "100%", ...arabicFont, fontSize: 20, padding: "14px 16px", borderRadius: 14,
          background: T.inkRaised, border: `1px solid ${T.inkLine}`, color: T.textHi, outline: "none", resize: "none",
          boxSizing: "border-box",
        }}
      />
      <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
        <PrimaryButton onClick={submitTyped} disabled={!typedValue.trim()}>Check</PrimaryButton>
        {supported && <GhostButton onClick={() => setMode("speech")}>Use voice instead</GhostButton>}
      </div>
    </div>
  );
}

// Renders a recall result's per-word breakdown — correct words in
// the normal ink color, wrong words struck through in the danger
// color with what was actually heard/typed underneath, missing
// words shown as a dashed placeholder. This is the visible half of
// error isolation: the user sees exactly which word broke.
function RecallResultWords({ result }) {
  return (
    <div dir="rtl" style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px", justifyContent: "center" }}>
      {result.wordResults.map((w, i) => (
        <div key={i} style={{ textAlign: "center" }}>
          <div style={{
            ...arabicFont, fontSize: 20,
            color: w.status === "correct" ? T.textHi : T.danger,
            textDecoration: w.status === "wrong" ? "line-through" : "none",
            opacity: w.status === "missing" ? 0.5 : 1,
            borderBottom: w.status === "missing" ? `1.5px dashed ${T.danger}` : "none",
          }}>
            {w.word || "—"}
          </div>
          {w.status !== "correct" && w.heard && (
            <div style={{ ...bodySans, fontSize: 9.5, color: T.textFaint, marginTop: 2 }}>heard: {w.heard}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   MEMORIZATION — Learn flow (one chunk, 1-3 ayat)
   Implements the full learning-science sequence from the spec:
   translation first (reusing ArabicChunks — same component the
   understanding feature uses, not a duplicate) -> capped audio
   loops with a visible counter -> blind recall (testing effect,
   not more listening) -> on failure, isolate + replay only the
   broken word(s) via real per-word audio, then re-attempt the
   FULL chunk -> on success, chain: recall this chunk plus every
   prior chunk from this session together, before the chunk is
   marked learned and enters the spaced-repetition queue.
   ============================================================ */
function MemorizeLearnScreen({ chunk, priorSessionText, defaultLoops, preferredReciterId, onChunkLearned, onExit, logAttempt }) {
  const [phase, setPhase] = useState("translation"); // translation -> listen -> recall -> isolateReplay -> chainRecall -> done
  const [loopsTarget, setLoopsTarget] = useState(defaultLoops);
  const [loopsCompleted, setLoopsCompleted] = useState(0);
  // "normal" plays the real continuous ayah recording (natural,
  // fluent pace — the same audio the rest of the app uses), with
  // word-highlight timing ESTIMATED proportionally from each word's
  // length, since a single continuous file has no per-word markers.
  // "slower" plays real isolated per-word clips back to back — an
  // inherently slower, more deliberate pace (that's what per-word
  // recordings sound like) but with EXACT highlight sync, since we
  // know precisely when each individual clip starts.
  const [speedMode, setSpeedMode] = useState("normal");
  const [playingLoops, setPlayingLoops] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [failCount, setFailCount] = useState(0);
  const [showTranslit, setShowTranslit] = useState(true); // on by default, per explicit request — toggleable for those who don't want it
  const [activeWordIdx, setActiveWordIdx] = useState(null);
  const cancelPlaybackRef = React.useRef(null);
  const chunkWords = useMemo(() => chunk.text.trim().split(/\s+/), [chunk.text]);
  const chunkTranslitWords = useMemo(() => transliterateWords(chunk.text), [chunk.text]);
  const chunkTranslit = useMemo(() => chunkTranslitWords.join(" "), [chunkTranslitWords]);

  React.useEffect(() => () => cancelPlaybackRef.current?.(), []);

  // Word-by-word playback (real per-word clips, same source as the
  // Discover-it tap feature) rather than one continuous ayah
  // recording — this is what makes it possible to know exactly
  // which word is playing at any moment and highlight it live,
  // instead of guessing from elapsed time against a single file.
  function startLoops() {
    setAudioError(false);
    setLoopsCompleted(0);
    setPlayingLoops(true);
    cancelPlaybackRef.current = speedMode === "slower"
      ? playChunkWordsLoop(chunk, {
          loops: loopsTarget,
          onWordStart: (i) => setActiveWordIdx(i),
          onLoopStart: (n) => setLoopsCompleted(n - 1),
          onEnd: () => { setLoopsCompleted(loopsTarget); setPlayingLoops(false); setActiveWordIdx(null); },
          onError: () => { setPlayingLoops(false); setAudioError(true); setActiveWordIdx(null); },
        })
      : playChunkContinuousWithEstimatedHighlight(chunk, chunkTranslitWords, {
          loops: loopsTarget, preferredReciterId,
          onWordStart: (i) => setActiveWordIdx(i),
          onLoopStart: (n) => setLoopsCompleted(n - 1),
          onEnd: () => { setLoopsCompleted(loopsTarget); setPlayingLoops(false); setActiveWordIdx(null); },
          onError: () => { setPlayingLoops(false); setAudioError(true); setActiveWordIdx(null); },
        });
  }

  // The play button doubles as pause: tapping it again mid-playback
  // cancels the in-flight sequence (this was previously impossible —
  // the button was `disabled` while playing, so it did nothing).
  // Pausing stops cleanly rather than resuming mid-ayah; tapping
  // play again restarts the full loop count from the top.
  function pauseLoops() {
    cancelPlaybackRef.current?.();
    setPlayingLoops(false);
    setActiveWordIdx(null);
  }
  function toggleLoops() {
    if (playingLoops) pauseLoops();
    else startLoops();
  }

  function handleRecallResult(result) {
    setLastResult(result);
    logAttempt(chunk.__itemId, result.passed ? "pass" : "fail", result.accuracy);
    if (result.passed) {
      setFailCount(0);
      setPhase(priorSessionText ? "chainRecall" : "done");
      if (!priorSessionText) onChunkLearned();
    } else {
      setFailCount((n) => n + 1);
      setPhase("isolateReplay");
    }
  }

  function handleChainResult(result) {
    setLastResult(result);
    logAttempt(chunk.__itemId, result.passed ? "pass" : "fail", result.accuracy);
    // Chaining is reinforcement, not a gate: this chunk already
    // proved itself in the standalone recall above, so a rough
    // chain attempt doesn't undo that — it's fine to let the user
    // retry the chain or just move on either way.
    setPhase("done");
    onChunkLearned();
  }

  function replayBroken() {
    cancelPlaybackRef.current = playIsolatedWords(chunk, lastResult.brokenIndices, {
      onEnd: () => setPhase("recall"),
    });
  }

  return (
    <Screen>
      <FontLoader />
      <TopBar title={`Ayah${chunk.ayahEnd > chunk.ayahStart ? "s" : ""} ${chunk.ayahStart}${chunk.ayahEnd > chunk.ayahStart ? `–${chunk.ayahEnd}` : ""}`} onBack={onExit} />
      <div style={{ padding: "0 20px" }}>

        {phase === "translation" && (
          <>
            <StepLabel n={1} text="Meaning first" />
            <div style={{ marginTop: 16 }}>
              {chunk.ayat.map((ayah) => (
                <div key={ayah.n} style={{ marginBottom: 14 }}>
                  <ArabicChunks
                    chunks={ayah.chunks}
                    revealed={new Set(ayah.chunks.map((_, i) => i))}
                    onTap={() => {}}
                    audioRef={{ surahId: chunk.surahId }}
                    ayahNum={ayah.n}
                    wordRanges={computeWordRanges(ayah.chunks)}
                  />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8, ...bodySans, fontSize: 12.5, color: T.textLo, textAlign: "center" }}>
              You already understand this — now let's memorize it.
            </div>
          </>
        )}

        {phase === "listen" && (
          <>
            <StepLabel n={2} text="Listen" />
            <div style={{ marginTop: 14 }}>
              <ArabicCenterpiece
                ar={chunk.text}
                words={chunkWords}
                translitWords={showTranslit ? chunkTranslitWords : null}
                activeWordIndex={activeWordIdx}
              />
            </div>
            <div style={{ marginTop: 8, textAlign: "center" }}>
              <GhostButton onClick={() => setShowTranslit((v) => !v)}>
                {showTranslit ? "Hide" : "Show"} English transliteration
              </GhostButton>
            </div>
            <div style={{ marginTop: 18, textAlign: "center" }}>
              <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginBottom: 10 }}>
                Loop count: {loopsTarget} {!playingLoops && (
                  <span style={{ marginLeft: 8 }}>
                    {[1, 3, 5].map((n) => (
                      <button key={n} onClick={() => { setLoopsTarget(n); setLoopsCompleted(0); }} style={{
                        ...mono, fontSize: 11, padding: "3px 8px", marginLeft: 4, borderRadius: 8, cursor: "pointer",
                        background: loopsTarget === n ? T.gold : T.inkRaised, color: loopsTarget === n ? "#1A1305" : T.textLo,
                        border: `1px solid ${T.inkLine}`,
                      }}>{n}</button>
                    ))}
                  </span>
                )}
              </div>
              <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginBottom: 14 }}>
                Speed:
                <span style={{ marginLeft: 8 }}>
                  {[{ label: "Normal", value: "normal" }, { label: "Slower", value: "slower" }].map((opt) => (
                    <button key={opt.value} disabled={playingLoops} onClick={() => setSpeedMode(opt.value)} style={{
                      ...mono, fontSize: 11, padding: "3px 8px", marginLeft: 4, borderRadius: 8,
                      cursor: playingLoops ? "default" : "pointer", opacity: playingLoops ? 0.6 : 1,
                      background: speedMode === opt.value ? T.gold : T.inkRaised, color: speedMode === opt.value ? "#1A1305" : T.textLo,
                      border: `1px solid ${T.inkLine}`,
                    }}>{opt.label}</button>
                  ))}
                </span>
              </div>
              <button onClick={toggleLoops} style={{
                width: 64, height: 64, borderRadius: 99, border: "none", cursor: "pointer",
                background: audioError ? "transparent" : `linear-gradient(135deg, ${T.gold}, #B5893F)`,
                borderColor: audioError ? T.danger : T.gold,
                display: "flex", alignItems: "center", justifyContent: "center",
              }} aria-label={playingLoops ? "Pause" : "Play"}>
                {audioError ? <RetryIcon color={T.danger} size={22} /> : <PlayPauseIcon playing={playingLoops} size={22} />}
              </button>
              <div style={{ ...bodySans, fontSize: 12, color: audioError ? T.danger : T.textFaint, marginTop: 10 }}>
                {audioError ? "Recitation unavailable — tap to retry" : `${loopsCompleted} / ${loopsTarget} loops played`}
              </div>
            </div>
          </>
        )}

        {phase === "recall" && (
          <>
            <StepLabel n={3} text="Recall it — no peeking" />
            <div style={{ marginTop: 6, ...bodySans, fontSize: 12.5, color: T.textLo, textAlign: "center" }}>
              {failCount > 0 ? "Try the full chunk again." : "Say or type the ayah from memory."}
            </div>
            <div style={{ marginTop: 18 }}>
              <RecallInput expectedText={chunk.text} onResult={handleRecallResult} />
            </div>
          </>
        )}

        {phase === "isolateReplay" && lastResult && (
          <>
            <StepLabel n={3} text="Close — let's fix the broken part" />
            <div style={{ marginTop: 14, padding: 16, borderRadius: 14, background: T.inkRaised, border: `1px solid ${T.inkLine}` }}>
              <RecallResultWords result={lastResult} />
              <div style={{ ...bodySans, fontSize: 11.5, color: T.textFaint, marginTop: 12, textAlign: "center" }}>
                {Math.round(lastResult.accuracy * 100)}% — only the word(s) above need work, not the whole ayah.
              </div>
            </div>
            <div style={{ marginTop: 18, textAlign: "center" }}>
              <PrimaryButton onClick={replayBroken}>Hear just the broken word(s)</PrimaryButton>
              <div style={{ marginTop: 10 }}>
                <GhostButton onClick={() => setPhase("recall")}>Skip straight to retry</GhostButton>
              </div>
            </div>
          </>
        )}

        {phase === "chainRecall" && (
          <>
            <StepLabel n={4} text="Chain it together" />
            <div style={{ marginTop: 6, ...bodySans, fontSize: 12.5, color: T.textLo, textAlign: "center" }}>
              This chunk is solid. Now recall everything you've learned this session, back to back.
            </div>
            <div style={{ marginTop: 18 }}>
              <RecallInput expectedText={`${priorSessionText} ${chunk.text}`} onResult={handleChainResult} />
            </div>
          </>
        )}

        {phase === "done" && lastResult && (
          <div style={{ marginTop: 40, textAlign: "center" }}>
            <div style={{ fontSize: 40 }}>✅</div>
            <div style={{ ...displaySerif, fontSize: 20, color: T.textHi, marginTop: 10 }}>Chunk memorized</div>
            <div style={{ ...bodySans, fontSize: 13, color: T.textLo, marginTop: 6 }}>
              It's now in your review queue — you'll be prompted to recall it again at increasing intervals.
            </div>
          </div>
        )}
      </div>

      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, padding: 20, background: `linear-gradient(0deg, ${T.ink} 60%, transparent)` }}>
        {phase === "translation" && <PrimaryButton onClick={() => setPhase("listen")}>Continue to listening</PrimaryButton>}
        {phase === "listen" && <PrimaryButton disabled={loopsCompleted < loopsTarget} onClick={() => setPhase("recall")}>{loopsCompleted < loopsTarget ? "Finish the loops first" : "I'm ready to recall it"}</PrimaryButton>}
        {phase === "done" && <PrimaryButton onClick={onExit}>Continue</PrimaryButton>}
      </div>
    </Screen>
  );
}

/* ============================================================
   MEMORIZATION — Review flow (spaced-repetition queue)
   Blind recall first, always — the whole point of testing-effect
   review is that re-exposure (seeing the text) only happens AFTER
   a failed attempt, as a hint, or if the user explicitly asks for
   one. On pass, the item's interval grows (srs.js); on fail, it
   resets to near-term rotation, not removed from the queue.
   ============================================================ */
function MemorizeReviewScreen({ queue, onResult, onExit }) {
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState("recall"); // recall -> hint (after fail) -> recall (retry)
  const [lastResult, setLastResult] = useState(null);
  const [stats, setStats] = useState({ pass: 0, fail: 0 });

  const item = queue[i];
  const chunk = item ? chunkForMemItem(item) : null;

  function handleResult(result) {
    setLastResult(result);
    if (result.passed) {
      setStats((s) => ({ ...s, pass: s.pass + 1 }));
      onResult(item.id, "pass");
      advance();
    } else {
      setStats((s) => ({ ...s, fail: s.fail + 1 }));
      onResult(item.id, "fail");
      setPhase("hint");
    }
  }

  function advance() {
    setPhase("recall");
    setLastResult(null);
    setI((n) => n + 1);
  }

  if (!item || !chunk) {
    return (
      <Screen>
        <FontLoader />
        <TopBar title="Review" onBack={onExit} />
        <div style={{ padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>🌙</div>
          <div style={{ ...displaySerif, fontSize: 20, color: T.textHi, marginTop: 10 }}>
            {stats.pass + stats.fail === 0 ? "Nothing due for review right now." : "Review complete"}
          </div>
          {stats.pass + stats.fail > 0 && (
            <div style={{ ...bodySans, fontSize: 13, color: T.textLo, marginTop: 8 }}>
              {stats.pass} recalled well · {stats.fail} need more practice
            </div>
          )}
          <div style={{ marginTop: 24 }}><PrimaryButton onClick={onExit}>Done</PrimaryButton></div>
        </div>
      </Screen>
    );
  }

  const surahMeta = ALL_SURAHS.find((s) => s.id === item.surahId);

  return (
    <Screen>
      <FontLoader />
      <TopBar title={`Review · ${i + 1}/${queue.length}`} onBack={onExit} />
      <div style={{ padding: "0 20px" }}>
        <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo, textAlign: "center", marginBottom: 12 }}>
          {surahMeta?.nameEn} · Ayah{chunk.ayahEnd > chunk.ayahStart ? "s" : ""} {chunk.ayahStart}{chunk.ayahEnd > chunk.ayahStart ? `–${chunk.ayahEnd}` : ""}
        </div>

        {phase === "recall" && (
          <>
            <StepLabel n="?" text="Recall from memory" />
            <div style={{ marginTop: 18 }}>
              <RecallInput expectedText={chunk.text} onResult={handleResult} />
            </div>
          </>
        )}

        {phase === "hint" && lastResult && (
          <>
            <StepLabel n="!" text="Here's a hint" />
            <div style={{ marginTop: 14, padding: 16, borderRadius: 14, background: T.inkRaised, border: `1px solid ${T.inkLine}` }}>
              <RecallResultWords result={lastResult} />
            </div>
            <div style={{ marginTop: 16 }}>
              <ArabicCenterpiece ar={chunk.text} small />
            </div>
            <div style={{ marginTop: 18, textAlign: "center" }}>
              <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginBottom: 10 }}>
                {Math.round(lastResult.accuracy * 100)}% — this dropped back into near-term rotation. Take another look, then move on.
              </div>
              <PrimaryButton onClick={advance}>Next</PrimaryButton>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

/* ============================================================
   PAYWALL — free tier hits its daily new-chunk limit
   Deliberately NOT a gate on the recitation audio itself (every
   source that audio comes from licenses it for free, non-commercial
   use only — see the app's audio-source comments above). What's
   metered here is purely this app's own feature: how many BRAND
   NEW chunks a free account can start memorizing per day. Reviewing
   anything already learned is never limited, and never shown here.
   Real purchases go through Apple's own In-App Purchase (StoreKit),
   via RevenueCat — App Store rules require that for any digital-
   content purchase; a webview payment form isn't allowed and
   wouldn't be trustworthy here anyway. `products` carries the real,
   store-localized prices once RevenueCat's finished loading them
   (null on the plain website, or briefly while the native app is
   still fetching them) — the hardcoded fallback text below that
   point is never what an actual purchase charges, just a reasonable
   placeholder while real numbers are still loading.
   ============================================================ */
function PaywallScreen({ isPremium, products, purchasing, error, isNative, onBack, onPurchase, onRestore }) {
  const monthlyPrice = products?.monthly?.priceString || "$12.99/mo";
  const annualPrice = products?.annual?.priceString || "$79.99/yr";
  return (
    <Screen>
      <FontLoader />
      <TopBar title="SuraLink Unlimited" onBack={onBack} />
      <div style={{ padding: "0 20px", textAlign: "center" }}>
        <div style={{ marginTop: 30, fontSize: 40 }}>🧠</div>
        <div style={{ ...displaySerif, fontSize: 22, color: T.textHi, marginTop: 12 }}>
          Go further with SuraLink
        </div>
        <p style={{ ...bodySans, fontSize: 13.5, color: T.textLo, lineHeight: 1.6, margin: "10px 0 0" }}>
          The free plan lets you start one brand-new chunk of memorization every day — reviewing what you've already learned is always unlimited, no matter what. Unlimited removes that daily cap entirely, plus a few other things.
        </p>
        <div style={{
          marginTop: 26, padding: 20, borderRadius: 16, textAlign: "left",
          background: `linear-gradient(150deg, rgba(201,164,92,0.14), rgba(46,125,83,0.08))`,
          border: `1px solid rgba(201,164,92,0.4)`,
        }}>
          <div style={{ ...displaySerif, fontSize: 17, color: T.gold, marginBottom: 10 }}>SuraLink Unlimited</div>
          {[
            "Start as many new memorization chunks a day as you want",
            "Choose your reciter — Abdul Basit, Al-Minshawi, As-Sudais, Ash-Shuraym",
            "Never lose your streak to a missed day",
            "Offline listening — no signal needed",
          ].map((line) => (
            <div key={line} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
              <span style={{ color: T.gold, marginTop: 1 }}>✦</span>
              <span style={{ ...bodySans, fontSize: 13, color: T.textHi }}>{line}</span>
            </div>
          ))}
        </div>

        {isNative ? (
          <>
            <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
              <PrimaryButton disabled={purchasing} onClick={() => onPurchase("annual")}>
                {purchasing ? "Processing…" : `Annual — ${annualPrice} (best value)`}
              </PrimaryButton>
              <GhostButton onClick={() => onPurchase("monthly")} style={{ opacity: purchasing ? 0.6 : 1 }}>
                {purchasing ? "Processing…" : `Monthly — ${monthlyPrice}`}
              </GhostButton>
            </div>
            {error && (
              <div style={{ ...bodySans, fontSize: 12, color: T.danger, marginTop: 12 }}>{error}</div>
            )}
            <div style={{ marginTop: 14 }}>
              <button
                onClick={onRestore}
                disabled={purchasing}
                style={{ ...bodySans, fontSize: 12, color: T.textLo, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
              >Restore purchases</button>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 22, ...bodySans, fontSize: 12.5, color: T.textFaint, lineHeight: 1.5 }}>
            Subscribing is only available in the SuraLink app on your phone, not on the website.
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <button
            onClick={onBack}
            style={{ ...bodySans, fontSize: 12, color: T.textFaint, background: "none", border: "none", cursor: "pointer" }}
          >Continue for free</button>
        </div>
        <div style={{ ...bodySans, fontSize: 10.5, color: T.textFaint, marginTop: 18, lineHeight: 1.5 }}>
          Come back tomorrow for another free chunk, no purchase needed.
        </div>
      </div>
    </Screen>
  );
}

/* ============================================================
   MEMORIZATION — surah/chunk picker
   Reuses ALL_SURAHS/AYAT (the same data the understanding feature
   browses) rather than a separate content list — only surahs with
   real ayah content can be chunked and memorized.
   ============================================================ */
function MemorizeSurahListScreen({ items, onPickSurah, onBack }) {
  const surahsWithContent = ALL_SURAHS.filter((s) => AYAT[s.id]);
  return (
    <Screen>
      <FontLoader />
      <TopBar title="Memorize the Quran" onBack={onBack} />
      <div style={{ padding: "0 20px" }}>
        <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo, marginBottom: 16, lineHeight: 1.5 }}>
          Pick a surah. Each is broken into small 1–3 ayah chunks you actively recall, not just repeat-listen to.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {surahsWithContent.map((s) => {
            const chunks = buildChunksForSurah(s.id);
            const learned = chunks.filter((c) => items[`${s.id}:${c.ayahStart}-${c.ayahEnd}`]?.status === "learned").length;
            return (
              <div key={s.id} onClick={() => onPickSurah(s.id)} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "14px 16px", borderRadius: 14, background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer",
              }}>
                <div>
                  <div style={{ ...displaySerif, fontSize: 16, color: T.textHi }}>{s.nameEn}</div>
                  <div style={{ ...bodySans, fontSize: 11.5, color: T.textLo, marginTop: 2 }}>{learned}/{chunks.length} chunks memorized</div>
                </div>
                <span style={{ color: T.gold, fontSize: 16 }}>→</span>
              </div>
            );
          })}
        </div>
      </div>
    </Screen>
  );
}

function MemorizeChunkListScreen({ surahId, items, now, onPickChunk, onBack }) {
  const meta = ALL_SURAHS.find((s) => s.id === surahId);
  const chunks = buildChunksForSurah(surahId);
  return (
    <Screen>
      <FontLoader />
      <TopBar title={meta?.nameEn || "Surah"} onBack={onBack} />
      <div style={{ padding: "0 20px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {chunks.map((c) => {
            const id = `${surahId}:${c.ayahStart}-${c.ayahEnd}`;
            const item = items[id];
            const status = item?.status || "new";
            const due = item ? isDue(item, now) : false;
            const badge = status === "learned" ? (due ? "Due for review" : "Learned") : status === "learning" ? "In progress" : "Not started";
            const badgeColor = status === "learned" ? (due ? T.gold : T.teal) : status === "learning" ? T.danger : T.textFaint;
            return (
              <div key={id} onClick={() => onPickChunk(c)} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "14px 16px", borderRadius: 14, background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer",
              }}>
                <div>
                  <div dir="rtl" style={{ ...arabicFont, fontSize: 17, color: T.parchment }}>{c.text.slice(0, 40)}{c.text.length > 40 ? "…" : ""}</div>
                  <div style={{ ...bodySans, fontSize: 11.5, color: T.textLo, marginTop: 4 }}>Ayah{c.ayahEnd > c.ayahStart ? "s" : ""} {c.ayahStart}{c.ayahEnd > c.ayahStart ? `–${c.ayahEnd}` : ""}</div>
                </div>
                <span style={{ ...bodySans, fontSize: 10.5, fontWeight: 600, color: badgeColor }}>{badge}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Screen>
  );
}

function JourneyCard({ icon, title, sub, onClick }) {
  return (
    <div onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 14, padding: "15px 16px", borderRadius: 16,
      background: T.inkRaised, border: `1px solid ${T.inkLine}`, cursor: "pointer",
    }}>
      <div style={{ fontSize: 24 }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ ...displaySerif, fontSize: 16.5, color: T.textHi }}>{title}</div>
        <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginTop: 2 }}>{sub}</div>
      </div>
      <span style={{ color: T.textFaint, fontSize: 16 }}>→</span>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ flex: 1, padding: "12px 10px", borderRadius: 12, background: T.inkRaised, border: `1px solid ${T.inkLine}`, textAlign: "center" }}>
      <div style={{ ...displaySerif, fontSize: 19, color: T.gold, fontWeight: 600 }}>{value}</div>
      <div style={{ ...bodySans, fontSize: 10.5, color: T.textLo, marginTop: 2 }}>{label}</div>
    </div>
  );
}

// audio (optional): the same resolved-audio descriptor recorded when
// this word was first tapped in a lesson — replaying it here uses
// that same real, verified source. Only words seen before this
// tracking existed (or with no verified source at all) fall back to
// the synthesized voice.
function ReviewWordCard({ ar, meaning, count, audio }) {
  const [flipped, setFlipped] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [errored, setErrored] = useState(false);

  React.useEffect(() => () => {
    stopResolvedAudio();
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  function handleTap() {
    setFlipped((f) => !f);
    setErrored(false);
    const cb = {
      onStart: () => setSpeaking(true),
      onEnd: () => setSpeaking(false),
      onError: () => { setErrored(true); setSpeaking(false); },
    };
    if (audio) playResolvedAudio(audio, cb);
    else speakArabic(ar, cb);
  }

  return (
    <button
      onClick={handleTap}
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px",
        borderRadius: 14, background: T.inkRaised,
        border: `1px solid ${errored ? T.danger : speaking ? T.gold : T.inkLine}`, cursor: "pointer", width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {errored
          ? <RetryIcon size={13} color={T.danger} />
          : <SpeakerIcon size={13} color={speaking ? T.gold : T.textFaint} active={speaking} />}
        <div dir="rtl" style={{ ...arabicFont, fontSize: 20, color: T.goldSoft }}>{ar}</div>
        {flipped && !errored && <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo }}>{meaning}</div>}
        {errored && <div style={{ ...bodySans, fontSize: 11.5, color: T.danger }}>tap to retry</div>}
      </div>
      <Pill tone="muted">seen ×{count}</Pill>
    </button>
  );
}

/* ============================================================
   QIBLA + PRAYER TIMES
   Both need the device's location, so they share one screen and
   one geolocation request. Qibla direction is computed locally
   (great-circle bearing to the Kaaba — no network needed). Prayer
   times come from the Aladhan API (api.aladhan.com), a free,
   no-key-required public prayer-time calculator — not something
   this app can compute correctly on its own (it depends on solar
   position + a calculation method), so unlike the Quran/salah
   content, this one real feature does rely on a live third-party
   API rather than a bundled data source.
   ============================================================ */
const KAABA_LAT = 21.4225;
const KAABA_LON = 39.8262;

function qiblaBearing(lat, lon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(lat), φ2 = toRad(KAABA_LAT);
  const Δλ = toRad(KAABA_LON - lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PRAYER_ORDER = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

function formatClock(hhmm) {
  // Aladhan returns "HH:MM" (24h, sometimes with a trailing
  // " (TZ)" annotation) — render as a plain 12h clock string.
  const clean = hhmm.split(" ")[0];
  const [h, m] = clean.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// DD-MM-YYYY, per Aladhan's date-parameterized endpoint — built
// from the DEVICE's own local calendar date, not left to default to
// whatever date Aladhan's server happens to think it is. That
// distinction matters right around midnight in any timezone that
// isn't the API's own.
function localDateKey(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

// A short list of common cities as a manual fallback when browser
// geolocation is denied or unavailable — not a replacement for real
// GPS (it's city-level, not exact), but enough to actually use the
// Qibla direction and prayer times instead of being blocked.
const COMMON_CITIES = [
  { label: "Washington, DC", lat: 38.9072, lon: -77.0369 },
  { label: "New York, NY", lat: 40.7128, lon: -74.0060 },
  { label: "Los Angeles, CA", lat: 34.0522, lon: -118.2437 },
  { label: "Chicago, IL", lat: 41.8781, lon: -87.6298 },
  { label: "Toronto, ON", lat: 43.6532, lon: -79.3832 },
  { label: "London, UK", lat: 51.5072, lon: -0.1276 },
];

function CityPicker({ onPick }) {
  return (
    <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
      {COMMON_CITIES.map((c) => (
        <button key={c.label} onClick={() => onPick(c)} style={{
          ...bodySans, fontSize: 13, padding: "10px 14px", borderRadius: 10, cursor: "pointer",
          background: T.inkLine, border: "none", color: T.textHi, textAlign: "left",
        }}>{c.label}</button>
      ))}
    </div>
  );
}

function PrayerQiblaScreen({ goBack }) {
  const [status, setStatus] = useState("idle"); // idle | locating | ready | denied | error
  const [coords, setCoords] = useState(null);
  const [isManualLocation, setIsManualLocation] = useState(false);
  const [showCityPicker, setShowCityPicker] = useState(false);

  function useManualCity(city) {
    setCoords({ lat: city.lat, lon: city.lon });
    setIsManualLocation(true);
    setShowCityPicker(false);
    setStatus("ready");
  }
  const [heading, setHeading] = useState(null); // live device compass, if available
  const [headingAvailable, setHeadingAvailable] = useState(false);
  const [timings, setTimings] = useState(null);
  const [timingsError, setTimingsError] = useState(false);

  function requestLocation() {
    setStatus("locating");
    if (!navigator.geolocation) { setStatus("error"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setStatus("ready");
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "error"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // `dateKey` is the device's own local calendar date — bumping it
  // (either right away when coords change, or when the periodic
  // check below notices the day has rolled over) is what re-triggers
  // the fetch effect, so "today" always means today on THIS device,
  // not whatever day the request happens to land on Aladhan's server.
  const [dateKey, setDateKey] = useState(localDateKey());

  // Fetch prayer times whenever we have coordinates, and again
  // whenever the local date changes — explicitly requesting that
  // date from Aladhan rather than trusting its own default "today".
  React.useEffect(() => {
    if (!coords) return;
    let cancelled = false;
    setTimingsError(false);
    fetch(`https://api.aladhan.com/v1/timings/${dateKey}?latitude=${coords.lat}&longitude=${coords.lon}&method=2`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.data?.timings) setTimings(data.data.timings);
        else setTimingsError(true);
      })
      .catch(() => { if (!cancelled) setTimingsError(true); });
    return () => { cancelled = true; };
  }, [coords, dateKey]);

  // If this screen is left open across midnight, notice the local
  // date has changed and refetch — otherwise it would keep showing
  // yesterday's times until the user manually leaves and returns.
  // Checked every minute rather than scheduled exactly at midnight:
  // simpler, and correct even if the device's clock/timezone shifts
  // (e.g. travel) while the screen is open.
  React.useEffect(() => {
    const id = setInterval(() => {
      const today = localDateKey();
      setDateKey((prev) => (prev === today ? prev : today));
    }, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Live compass, tried in order of how reliable each source
  // actually is for a real true-north heading:
  //  1. AbsoluteOrientationSensor (Generic Sensor API) — the modern,
  //     standards-track API, and the one Android Chrome supports
  //     most consistently. This is new here; it wasn't tried before,
  //     and on many Android phones it's the ONLY thing that actually
  //     reports a usable heading — plain deviceorientation events
  //     often fire with `absolute: false` on Android, meaning the
  //     previous code correctly refused to trust them (unreliable,
  //     drifts from whatever direction the phone started facing)
  //     but had nothing better to fall back to.
  //  2. deviceorientationabsolute / webkitCompassHeading — iOS
  //     Safari and some Android browsers.
  //  3. Otherwise: the static "face North, turn X°" reading stays.
  const [compassDenied, setCompassDenied] = useState(false);
  const [compassSource, setCompassSource] = useState(null); // "sensor" | "event" | null — which method is actually feeding the arrow
  const [compassDebug, setCompassDebug] = useState([]); // visible step-by-step log — this is how we find out what's ACTUALLY happening on a real device instead of guessing
  const sensorRef = React.useRef(null);
  const debugTimeoutRef = React.useRef(null);

  function logDebug(msg) {
    setCompassDebug((d) => [...d, msg].slice(-8));
  }

  async function tryAbsoluteOrientationSensor() {
    if (typeof AbsoluteOrientationSensor === "undefined") {
      logDebug("AbsoluteOrientationSensor: not supported by this browser");
      return false;
    }
    try {
      if (navigator.permissions?.query) {
        const results = await Promise.all(
          ["accelerometer", "magnetometer", "gyroscope"].map((name) =>
            navigator.permissions.query({ name })
              .then((r) => { logDebug(`permission ${name}: ${r.state}`); return r; })
              .catch((err) => { logDebug(`permission ${name}: query failed (${err.message})`); return { state: "granted" }; })
          )
        );
        if (results.some((r) => r.state === "denied")) {
          logDebug("AbsoluteOrientationSensor: a required sensor permission is denied");
          return false;
        }
      }
      const sensor = new AbsoluteOrientationSensor({ frequency: 10, referenceFrame: "device" });
      sensor.addEventListener("reading", () => {
        const [x, y, z, w] = sensor.quaternion;
        const yawRad = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
        const deg = (360 - ((yawRad * 180) / Math.PI + 360) % 360) % 360;
        setHeading(deg);
        setHeadingAvailable(true);
        setCompassSource("sensor");
        logDebug(`sensor reading: ${Math.round(deg)}°`);
      });
      sensor.addEventListener("error", (e) => {
        logDebug(`AbsoluteOrientationSensor error: ${e.error?.name || "unknown"} — ${e.error?.message || ""}`);
        sensorRef.current = null;
      });
      sensor.start();
      sensorRef.current = sensor;
      logDebug("AbsoluteOrientationSensor: started, waiting for first reading…");
      return true;
    } catch (err) {
      logDebug(`AbsoluteOrientationSensor: threw — ${err.name}: ${err.message}`);
      return false;
    }
  }

  function enableCompass() {
    setCompassDenied(false);
    setCompassDebug([]);
    logDebug(`UA: ${navigator.userAgent}`);
    tryAbsoluteOrientationSensor().then((started) => {
      if (!started) {
        logDebug("Falling back to deviceorientation events…");
        if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
          logDebug("DeviceOrientationEvent.requestPermission exists (iOS-style) — requesting…");
          DeviceOrientationEvent.requestPermission().then((res) => {
            logDebug(`requestPermission result: ${res}`);
            if (res === "granted") {
              window.addEventListener("deviceorientationabsolute", onOrientation, true);
              window.addEventListener("deviceorientation", onOrientation, true);
            } else {
              setCompassDenied(true);
            }
          }).catch((err) => { logDebug(`requestPermission threw: ${err.message}`); setCompassDenied(true); });
        } else {
          logDebug("No requestPermission API — attaching event listeners directly");
          window.addEventListener("deviceorientationabsolute", onOrientation, true);
          window.addEventListener("deviceorientation", onOrientation, true);
        }
      }
      // If nothing has reported a heading within 4s of any path, say
      // so explicitly instead of leaving the user staring at "waiting".
      clearTimeout(debugTimeoutRef.current);
      debugTimeoutRef.current = setTimeout(() => {
        setHeadingAvailable((cur) => {
          if (!cur) logDebug("No heading received after 4s — this browser/device isn't reporting orientation data at all.");
          return cur;
        });
      }, 4000);
    });
  }
  function onOrientation(e) {
    logDebug(`deviceorientation event: absolute=${e.absolute}, alpha=${e.alpha == null ? "null" : Math.round(e.alpha)}, webkitCompassHeading=${e.webkitCompassHeading ?? "n/a"}`);
    const h = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
    if (h != null) {
      setCompassSource("event");
      setHeading(h);
      setHeadingAvailable(true);
    }
  }
  React.useEffect(() => () => {
    window.removeEventListener("deviceorientationabsolute", onOrientation, true);
    window.removeEventListener("deviceorientation", onOrientation, true);
    try { sensorRef.current?.stop(); } catch {}
  }, []);

  const bearing = coords ? qiblaBearing(coords.lat, coords.lon) : null;
  const distanceKm = coords ? Math.round(haversineKm(coords.lat, coords.lon, KAABA_LAT, KAABA_LON)) : null;
  const arrowRotation = bearing != null ? bearing - (headingAvailable ? heading : 0) : 0;

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let nextPrayer = null;
  if (timings) {
    for (const name of PRAYER_ORDER) {
      const [h, m] = timings[name].split(" ")[0].split(":").map(Number);
      if (h * 60 + m > nowMin) { nextPrayer = name; break; }
    }
  }

  return (
    <Screen>
      <FontLoader />
      <TopBar title="Qibla & Prayer Times" onBack={goBack} />
      <div style={{ padding: "0 20px" }}>
        {status === "idle" && (
          <div style={{ marginTop: 20, padding: 20, borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, textAlign: "center" }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>🧭</div>
            <div style={{ ...displaySerif, fontSize: 16, color: T.textHi }}>Uses your location</div>
            <div style={{ ...bodySans, fontSize: 12.5, color: T.textLo, marginTop: 6, lineHeight: 1.5 }}>
              To point you toward the Kaaba and calculate today's prayer times, this needs your device's location. Nothing is stored or sent anywhere except the prayer-time lookup itself.
            </div>
            <div style={{ marginTop: 16 }}>
              <PrimaryButton onClick={() => { requestLocation(); enableCompass(); }}>Enable location</PrimaryButton>
            </div>
            <div style={{ marginTop: 10 }}>
              <GhostButton onClick={() => setShowCityPicker((v) => !v)}>Use a city instead</GhostButton>
            </div>
            {showCityPicker && <CityPicker onPick={useManualCity} />}
          </div>
        )}

        {status === "locating" && (
          <div style={{ marginTop: 40, textAlign: "center", ...bodySans, fontSize: 13.5, color: T.textLo }}>Finding your location…</div>
        )}

        {status === "denied" && (
          <div style={{ marginTop: 20, padding: 20, borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, textAlign: "center" }}>
            <div style={{ ...bodySans, fontSize: 13.5, color: T.textLo, lineHeight: 1.5 }}>
              Location access was denied. You'll need to allow it in your browser's site settings for this page, then try again.
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "center" }}>
              <GhostButton onClick={requestLocation}>Try again</GhostButton>
              <GhostButton onClick={() => setShowCityPicker(true)}>Use a city instead</GhostButton>
            </div>
            {showCityPicker && <CityPicker onPick={useManualCity} />}
          </div>
        )}

        {status === "error" && (
          <div style={{ marginTop: 20, padding: 20, borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, textAlign: "center" }}>
            <div style={{ ...bodySans, fontSize: 13.5, color: T.textLo }}>Couldn't get your location. Check your connection and try again.</div>
            <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "center" }}>
              <GhostButton onClick={requestLocation}>Try again</GhostButton>
              <GhostButton onClick={() => setShowCityPicker(true)}>Use a city instead</GhostButton>
            </div>
            {showCityPicker && <CityPicker onPick={useManualCity} />}
          </div>
        )}

        {status === "ready" && coords && (
          <>
            {isManualLocation && (
              <div style={{ marginTop: 16, ...bodySans, fontSize: 11.5, color: T.textFaint, textAlign: "center" }}>
                Using an approximate city location, not live GPS.{" "}
                <span onClick={() => setShowCityPicker((v) => !v)} style={{ color: T.gold, cursor: "pointer" }}>Change</span>
                {showCityPicker && <CityPicker onPick={useManualCity} />}
              </div>
            )}
            {/* Qibla compass */}
            <div style={{ marginTop: 20, padding: 20, borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}`, textAlign: "center" }}>
              <div style={{ ...bodySans, fontSize: 11.5, color: T.textLo, letterSpacing: 0.4, textTransform: "uppercase" }}>Qibla direction</div>
              <div style={{ position: "relative", width: 180, height: 180, margin: "16px auto" }}>
                <svg width="180" height="180" viewBox="0 0 180 180">
                  <circle cx="90" cy="90" r="86" fill="none" stroke={T.inkLine} strokeWidth="2" />
                  <text x="90" y="20" textAnchor="middle" fill={T.textFaint} fontSize="11">N</text>
                  <text x="90" y="168" textAnchor="middle" fill={T.textFaint} fontSize="11">S</text>
                  <text x="14" y="94" textAnchor="middle" fill={T.textFaint} fontSize="11">W</text>
                  <text x="166" y="94" textAnchor="middle" fill={T.textFaint} fontSize="11">E</text>
                  <g transform={`rotate(${arrowRotation} 90 90)`}>
                    <line x1="90" y1="90" x2="90" y2="26" stroke={T.gold} strokeWidth="3" strokeLinecap="round" />
                    <path d="M90 16 L82 32 L98 32 Z" fill={T.gold} />
                    <text x="90" y="14" textAnchor="middle" fontSize="16" transform={`rotate(${-arrowRotation} 90 16)`}>🕋</text>
                  </g>
                  <circle cx="90" cy="90" r="4" fill={T.gold} />
                </svg>
              </div>
              <div style={{ ...displaySerif, fontSize: 18, color: T.gold }}>This is the Kaaba</div>
              <div style={{ ...bodySans, fontSize: 12, color: T.textLo, marginTop: 4 }}>
                {headingAvailable
                  ? "The arrow points at the Kaaba as you move your phone."
                  : "Face North, then turn your body until the arrow points straight up."}
                {" "}· {distanceKm.toLocaleString()} km away
              </div>
              {!headingAvailable && (
                <div style={{ marginTop: 12 }}>
                  <GhostButton onClick={enableCompass}>Enable live compass</GhostButton>
                  {compassDenied && (
                    <div style={{ ...bodySans, fontSize: 11, color: T.danger, marginTop: 8, lineHeight: 1.4 }}>
                      Motion access was denied. Allow it in Settings for this app, then tap again — or your device may just not support a live compass, in which case the manual reading above still works.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Prayer times */}
            <div style={{ marginTop: 16, padding: 20, borderRadius: 16, background: T.inkRaised, border: `1px solid ${T.inkLine}` }}>
              <div style={{ ...bodySans, fontSize: 11.5, color: T.textLo, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 12 }}>Today's prayer times</div>
              {timingsError && (
                <div style={{ ...bodySans, fontSize: 13, color: T.textLo, textAlign: "center", padding: "8px 0" }}>
                  Couldn't reach the prayer-time service. <span onClick={() => setCoords({ ...coords })} style={{ color: T.gold, cursor: "pointer" }}>Retry</span>
                </div>
              )}
              {!timings && !timingsError && (
                <div style={{ ...bodySans, fontSize: 13, color: T.textLo, textAlign: "center", padding: "8px 0" }}>Loading…</div>
              )}
              {timings && PRAYER_ORDER.map((name) => {
                const isNext = name === nextPrayer;
                return (
                  <div key={name} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "10px 4px", borderBottom: `1px solid ${T.inkLine}`,
                  }}>
                    <div style={{ ...bodySans, fontSize: 14, color: isNext ? T.gold : T.textHi, fontWeight: isNext ? 600 : 400 }}>
                      {isNext && "→ "}{name}
                    </div>
                    <div style={{ ...mono, fontSize: 13.5, color: isNext ? T.gold : T.textLo }}>{formatClock(timings[name])}</div>
                  </div>
                );
              })}
              <div style={{ ...bodySans, fontSize: 10.5, color: T.textFaint, marginTop: 10, textAlign: "center" }}>
                Calculated by Aladhan (ISNA method) for your current location.
              </div>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

function BottomNav({ view, goTo }) {
  const items = [
    ["home", "🏠", "Home"],
    ["surahs", "📖", "Surahs"],
    ["review", "🔁", "Review"],
    ["progress", "🌙", "Progress"],
  ];
  return (
    <div style={{
      position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430,
      display: "flex", background: T.inkRaised, borderTop: `1px solid ${T.inkLine}`,
      padding: "10px 6px calc(14px + env(safe-area-inset-bottom))",
    }}>
      {items.map(([key, icon, label]) => {
        const active = view === key;
        return (
          <button key={key} onClick={() => goTo(key)} style={{
            flex: 1, background: "transparent", border: "none", cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            color: active ? T.gold : T.textFaint,
          }}>
            <div style={{ fontSize: 17 }}>{icon}</div>
            <div style={{ ...bodySans, fontSize: 10 }}>{label}</div>
          </button>
        );
      })}
    </div>
  );
}
