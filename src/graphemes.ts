/**
 * Grapheme cluster segmentation used by the search index.
 *
 * It follows UAX #29 extended grapheme clusters (TR29). A single linear
 * regex pass handles the common cases (Latin with combining marks, German
 * sharp s, fullwidth/compatibility characters, ZWJ emoji sequences,
 * regional-indicator flags, Hangul, surrogate pairs, …). V8's
 * `Grapheme_Extend` property table differs slightly from ICU's GCB data, so
 * the regex Extend class is built from several properties and, for the
 * handful of edge scripts where no property escape matches ICU exactly, we
 * transparently fall back to the always-available `Intl.Segmenter`.
 *
 * This hybrid matters for performance: `Intl.Segmenter` is the reference
 * implementation but is very slow for long strings (seconds for ~100k
 * clusters), whereas the regex path is sub-millisecond for such inputs.
 */

// --- Hangul jamo classes (explicit ranges; enumerated HST unsupported) ---
const L = '[\\u1100-\\u115F\\uA960-\\uA97C]';
const V = '[\\u1160-\\u11A7\\uD7B0-\\uD7C6]';
const T = '[\\u11A8-\\u11FF\\uD7CB-\\uD7FB]';
// Precomposed LV syllables are exactly AC00 + 28k (399 code points).
const LV_LIST = (() => {
  const out: string[] = [];
  for (let cp = 0xac00; cp <= 0xd7a3; cp += 28) {
    out.push('\\u' + cp.toString(16).toUpperCase().padStart(4, '0'));
  }
  return out.join('');
})();
const LV = '[' + LV_LIST + ']';

// Grapheme_Extend aligned to ICU's GCB (V8 omits emoji modifiers, Mc spacing
// marks, Thai/Lao legacy marks and Unicode tag characters).
const TAGS_EXTEND = '\\u{E0020}-\\u{E007F}';
const EXTEND_NO_MOD =
  '\\p{Grapheme_Extend}|\\p{Mc}|\\u0E33|\\u0EB3|' + TAGS_EXTEND;
// Extending marks, including emoji skin-tone modifiers (which ICU binds to
// any base but V8 omits from Grapheme_Extend).
const MM = '(?:' + EXTEND_NO_MOD + '|\\p{Emoji_Modifier})';
// Tail for a base (letter, syllable, jamo, …): marks and emoji modifiers,
// plus ZWJ-continuation runs. ICU binds a modifier directly after every base
// type, and marks/modifiers following a ZWJ attach as well.
const BASE_TAIL = MM + '*(?:\\u200D' + MM + '*)*';
const ET = MM + '*';

const EP = '\\p{Extended_Pictographic}';
// GB11: ( EP (Extend|Mod)* ZWJ )* EP (Extend|Mod)*, then the GB9 tail.
const EMOJI = '(?:' + EP + ET + '\\u200D)*' + EP + BASE_TAIL;

// Breaking controls (GCB Control/CR/LF) as observed in this ICU revision.
// U+FEFF behaves as a breaking control here (newer Unicode makes it Extend).
// U+E0001 is the language tag and U+E0000/U+E0002..U+E001F are tag-control
// characters (the printable tags U+E0020..U+E007F are GCB Extend instead).
const CTRL_RANGES =
  '\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E' +
  '\\u200B\\u200E-\\u200F\\u2028-\\u202E\\u2060-\\u206F' +
  '\\uFFF9-\\uFFFB\\uFEFF\\u{1BCA0}-\\u{1BCA3}' +
  '\\u{E0000}\\u{E0001}\\u{E0002}-\\u{E001F}';

// Hangul GB6/7/8 cores, each carrying the same GB9 tail.
const HANGUL =
  L + '*' + LV + V + '*' + T + '*' + BASE_TAIL +
  '|' + L + '+[\\uAC00-\\uD7A3]' + T + '*' + BASE_TAIL +
  '|[\\uAC00-\\uD7A3]' + T + '*' + BASE_TAIL +
  '|' + L + '*' + V + '+' + T + '*' + BASE_TAIL +
  '|' + L + '+' + BASE_TAIL +
  '|' + T + '+' + BASE_TAIL;

// GB9a Prepend set used by this ICU revision (enumerated empirically). These
// join with the cluster that follows them. Only BMP members live in this
// class: astral Prepend code points cannot be placed in a BMP character
// class (a fixed-width 5-hex-digit escape is parsed as a 4-digit escape plus
// a literal fifth character), so they are routed to the Intl.Segmenter
// fallback instead (see ASTRAL_PREPEND_RANGES).
const PREPEND =
  '[\\u0600-\\u0605\\u06DD\\u070F\\u0890-\\u0891\\u08E2\\u0D4E]';

// Halfwidth/halfwidth-form filler jamo U+FFF0..U+FFF8 are isolated Other
// bases that reject every tail (Extend, modifier and ZWJ all break).
const NAKED = '\\uFFF0-\\uFFF8';

// GB999 generic base: anything that is not an extend/mark/control/RI/ZWJ,
// not a Hangul code point, not a naked filler jamo, and not a BMP Prepend.
const BASE = '[^\\p{Grapheme_Extend}\\p{Emoji_Modifier}\\p{Mc}\\u0E33\\u0EB3' + TAGS_EXTEND +
  '\\p{Regional_Indicator}' + CTRL_RANGES + '\\u200D' + NAKED +
  '\\u0600-\\u0605\\u06DD\\u070F\\u0890-\\u0891\\u08E2\\u0D4E' +
  L.slice(1, -1) + V.slice(1, -1) + T.slice(1, -1) + '\\uAC00-\\uD7A3]';
// Orphan cluster: a run of marks (incl. modifiers) and ZWJ; handles leading
// combining marks and consecutive joiners.
const ORPHAN = '(?:' + MM + '|\\u200D)+';

// GB9a: an optional run of Prepend characters precedes a joinable cluster.
const P = PREPEND + '*';
// The core of a cluster that a Prepend may attach to (emoji / RI / hangul /
// ordinary base / orphan marks). Prepend does NOT cross controls or naked
// filler jamo, so those are matched separately without a Prepend prefix.
const JOINABLE =
  EMOJI +
  '|\\p{Regional_Indicator}\\p{Regional_Indicator}?' + BASE_TAIL +
  '|' + HANGUL +
  '|' + BASE + BASE_TAIL +
  '|' + ORPHAN;
const RE = new RegExp(
  P + '(?:' + JOINABLE + ')' +
  // CRLF / controls and naked filler jamo break before Prepend
  '|\\r\\n'
  + '|[' + CTRL_RANGES + ']'
  + '|[' + NAKED + ']' +
  // a trailing run of Prepend characters with nothing joinable following
  '|' + PREPEND + '+'
, 'gu');

// Fallback triggers. The regex fast path models all common text exactly; we
// defer to Intl.Segmenter only for rare exotic cases the regex cannot
// express with the Unicode property escapes V8 provides:
//   - GCB SpacingMark characters (\p{Mc}) and legacy Thai/Lao marks
//     U+0E33/U+0EB3, whose interaction with GB11 emoji chains differs from
//     plain Extend;
//   - astral Prepend characters (surrogate pairs cannot be excluded from the
//     BMP generic-base character class, so they would otherwise be matched
//     as ordinary bases instead of joining the following cluster).
const ASTRAL_PREPEND_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x110bd, 0x110bd], [0x110cd, 0x110cd],
  [0x111c2, 0x111c3], [0x113d1, 0x113d1], [0x1193f, 0x1193f],
  [0x11941, 0x11941], [0x11a84, 0x11a89], [0x11d46, 0x11d46], [0x11f02, 0x11f02],
];
const FALLBACK_RE = new RegExp(
  '\\p{Mc}|\\u0E33|\\u0EB3|[' +
    ASTRAL_PREPEND_RANGES
      .map(([a, b]) => (a === b ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`))
      .join('') +
    ']',
  'u',
);

function needsFallback(s: string): boolean {
  FALLBACK_RE.lastIndex = 0;
  return FALLBACK_RE.test(s);
}

const icuSegmenter = new Intl.Segmenter();

/**
 * Split `s` into extended grapheme clusters. Fast regex path for common
 * text (Latin + combining marks, CJK, Hangul, emoji/ZWJ, flags, surrogate
 * pairs); reference `Intl.Segmenter` fallback when rare characters are
 * present whose GCB behaviour cannot be expressed with V8's Unicode
 * property escapes (non-Latin spacing marks, astral Prepend code points).
 */
export function segmentGraphemes(s: string): string[] {
  if (needsFallback(s)) {
    const out: string[] = [];
    for (const seg of icuSegmenter.segment(s)) out.push(seg.segment);
    return out;
  }
  RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = RE.exec(s)) !== null) out.push(m[0]);
  return out;
}
