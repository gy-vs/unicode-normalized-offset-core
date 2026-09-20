/**
 * Normalized text search with accurate original-string range mapping.
 *
 * The search representation is built per grapheme cluster, so every folded
 * character can be traced back to the source grapheme(s) that produced it
 * (many-to-many: ß -> "ss", fullwidth compatibility folding, decomposed
 * marks that disappear, etc.). Mapping never re-normalizes prefixes and is
 * therefore linear rather than quadratic.
 */

import { segmentGraphemes } from './graphemes.js';

export interface SearchOptions {
  /** Compose the folded representation. @default true */
  nfc?: boolean;
  /** Apply NFKD compatibility decomposition (fullwidth, ligatures, …). @default true */
  compatibility?: boolean;
  /** Case fold, including ß -> ss handling. @default true */
  caseFold?: boolean;
  /** Strip combining marks and variation selectors. @default true */
  stripMarks?: boolean;
  /**
   * Drop ZWJ/ZWNJ join controls so ZWJ emoji sequences match the same
   * emoji without joiners. @default true
   */
  stripJoinControls?: boolean;
  /** German sharp s folding (ß -> ss). @default true */
  sharpS?: boolean;
  /** BCP-47 locale for case folding ('tr' uses Turkish dotless i rules). */
  locale?: string;
}

export interface MatchRange {
  /** Start UTF-16 index in the original string. */
  start: number;
  /** Exclusive end UTF-16 index in the original string. */
  end: number;
  /** Index of the first covered grapheme cluster. */
  graphemeStart: number;
  /** Exclusive index after the last covered grapheme cluster. */
  graphemeEnd: number;
}

interface GraphemeGroup {
  /** UTF-16 start offset in the original string. */
  start: number;
  /** Exclusive UTF-16 end offset in the original string. */
  end: number;
  /** Length of this group's folded text in UTF-16 code units. */
  foldedLen: number;
}

interface ResolvedOptions {
  nfc: boolean;
  compatibility: boolean;
  caseFold: boolean;
  stripMarks: boolean;
  stripJoinControls: boolean;
  sharpS: boolean;
  locale: string | undefined;
}

export interface SearchIndex {
  text: string;
  folded: string;
  groups: GraphemeGroup[];
  /** Resolved normalization options this index was built with. */
  options: ResolvedOptions;
}

function resolveOptions(options: SearchOptions = {}): ResolvedOptions {
  return {
    nfc: options.nfc ?? true,
    compatibility: options.compatibility ?? true,
    caseFold: options.caseFold ?? true,
    stripMarks: options.stripMarks ?? true,
    stripJoinControls: options.stripJoinControls ?? true,
    sharpS: options.sharpS ?? (options.caseFold ?? true),
    locale: options.locale,
  };
}

const MARK_RE = /\p{M}/gu;
// U+200C ZERO WIDTH NON-JOINER, U+200D ZERO WIDTH JOINER.
const JOIN_CONTROL_RE = /[\u200C\u200D]/g;
const SHARP_S_RE = /ß/g;

function foldGrapheme(cluster: string, opts: ResolvedOptions): string {
  let s = cluster;
  // Case fold first; Turkish locale handles i/İ/ı correctly this way.
  if (opts.caseFold) {
    s = opts.locale ? s.toLocaleLowerCase(opts.locale) : s.toLowerCase();
    if (opts.sharpS) s = s.replace(SHARP_S_RE, 'ss');
  }
  // Decompose (compatibility folding handles fullwidth, ligatures, …).
  s = s.normalize(opts.compatibility ? 'NFKD' : 'NFD');
  if (opts.stripMarks) {
    // Variation selectors (U+FE00..U+FE0F etc.) have category Mn and go too.
    s = s.replace(MARK_RE, '');
    if (opts.stripJoinControls) s = s.replace(JOIN_CONTROL_RE, '');
  }
  // Recompose only within this grapheme cluster — clusters were split first,
  // so composition can never cross a source grapheme boundary.
  if (opts.nfc) s = s.normalize('NFC');
  return s;
}

/**
 * Build the folded search representation together with the many-to-many
 * boundary map. One linear pass: each grapheme cluster is normalized once
 * (no repeated per-prefix normalization) and its source/folded offsets are
 * recorded.
 */
export function buildSearchIndex(text: string, options?: SearchOptions): SearchIndex {
  const opts = resolveOptions(options);
  const groups: GraphemeGroup[] = [];
  const parts: string[] = [];

  let sourceIndex = 0;
  for (const cluster of segmentGraphemes(text)) {
    const folded = foldGrapheme(cluster, opts);
    parts.push(folded);
    groups.push({
      start: sourceIndex,
      end: sourceIndex + cluster.length,
      foldedLen: folded.length,
    });
    sourceIndex += cluster.length;
  }

  return { text, folded: parts.join(''), groups, options: opts };
}

interface PreparedIndex {
  groups: GraphemeGroup[];
  /** Indices of non-empty groups; their folded intervals are strictly ordered. */
  nonEmpty: number[];
  /** Folded start/end of each non-empty group (same length as nonEmpty). */
  neStarts: number[];
  neEnds: number[];
}

function prepare(index: SearchIndex): PreparedIndex {
  const { groups } = index;
  const nonEmpty: number[] = [];
  const neStarts: number[] = [];
  const neEnds: number[] = [];
  let pos = 0;
  for (let i = 0; i < groups.length; i++) {
    const start = pos;
    pos += groups[i].foldedLen;
    if (groups[i].foldedLen > 0) {
      nonEmpty.push(i);
      neStarts.push(start);
      neEnds.push(pos);
    }
  }
  return {
    groups,
    nonEmpty,
    neStarts,
    neEnds,
  };
}

/** First index i in `arr` (strictly increasing) with arr[i] > target. */
function upperBound(arr: number[], target: number): number {
  let l = 0;
  let h = arr.length;
  while (l < h) {
    const mid = (l + h) >>> 1;
    if (arr[mid] > target) h = mid;
    else l = mid + 1;
  }
  return l;
}

/** First index i in `arr` (strictly increasing) with arr[i] >= target. */
function lowerBound(arr: number[], target: number): number {
  let l = 0;
  let h = arr.length;
  while (l < h) {
    const mid = (l + h) >>> 1;
    if (arr[mid] >= target) h = mid;
    else l = mid + 1;
  }
  return l;
}

/**
 * Map a [foldedStart, foldedEnd) range in the folded representation back to
 * the original string.
 *
 * Contributing groups are exactly the non-empty grapheme groups whose folded
 * intervals intersect the match. Zero-width groups (marks, variation
 * selectors, join controls that folded away) attach by a deterministic rule:
 *   - a zero group anchors to the nearest non-empty group on its LEFT;
 *   - leading zero groups (nothing on the left) anchor to the FIRST
 *     non-empty group in the text, but only when that group itself starts
 *     the match (right anchoring).
 * This guarantees a zero group is never shared by two different hits.
 *
 * Returned UTF-16 ranges and grapheme indices always sit on grapheme cluster
 * boundaries, so surrogate pairs and grapheme clusters are never split.
 */
function mapFoldedRange(idx: PreparedIndex, foldedStart: number, foldedEnd: number): MatchRange {
  const { groups, nonEmpty, neStarts, neEnds } = idx;

  // Contributing non-empty groups are those whose folded intervals intersect
  // [foldedStart, foldedEnd):  neStarts[i] < foldedEnd AND
  // neEnds[i] > foldedStart. This keeps a multi-char folded group (ß -> ss,
  // ﬁ -> fi) atomic: a match touching any part covers the whole source
  // grapheme.

  // First group with neEnds[i] > foldedStart.
  const firstNE = upperBound(neEnds, foldedStart);
  // One past the last group with neStarts[i] < foldedEnd, i.e. first group
  // whose folded start is >= foldedEnd.
  const afterLastNE = lowerBound(neStarts, foldedEnd);
  const lastNE = afterLastNE - 1;

  // A valid match always intersects at least one non-empty group.
  let firstGroup = nonEmpty[firstNE];
  let lastGroup = nonEmpty[lastNE];

  // Leading zero groups: right-anchor onto the match only when the first
  // contributor is the first non-empty group in the whole text.
  if (firstNE === 0) {
    firstGroup = 0;
  }
  // Trailing/interior zero groups left-anchor to the last contributing
  // group, swallowing the whole run of consecutive zero groups after it —
  // but stop at the start of the next non-empty group.
  let next = lastGroup + 1;
  while (next < groups.length && groups[next].foldedLen === 0) {
    lastGroup = next;
    next++;
  }

  return {
    start: groups[firstGroup].start,
    end: groups[lastGroup].end,
    graphemeStart: firstGroup,
    graphemeEnd: lastGroup + 1,
  };
}

/** Fold a query with the same pipeline and per-grapheme mapping. */
function foldQuery(query: string, opts: ResolvedOptions): string {
  const parts: string[] = [];
  for (const cluster of segmentGraphemes(query)) {
    parts.push(foldGrapheme(cluster, opts));
  }
  return parts.join('');
}

function searchFolded(
  index: SearchIndex,
  needle: string,
): MatchRange[] {
  const prepared = prepare(index);
  const haystack = index.folded;
  const out: MatchRange[] = [];
  let at = 0;
  let hit: number;
  while ((hit = haystack.indexOf(needle, at)) >= 0) {
    out.push(mapFoldedRange(prepared, hit, hit + needle.length));
    at = hit + needle.length; // non-overlapping hits
  }
  return out;
}

/**
 * Find non-overlapping matches using a prebuilt index. The query is folded
 * with the index's own normalization options, so build the index with the
 * desired options first (see {@link buildSearchIndex}).
 */
export function findInIndex(index: SearchIndex, query: string): MatchRange[] {
  if (query.length === 0) return [];
  const needle = foldQuery(query, resolveOptions(index.options));
  if (needle.length === 0) return [];
  return searchFolded(index, needle);
}

/**
 * Find all non-overlapping occurrences of `query` in `text` after
 * normalization, returning UTF-16 ranges and grapheme indices in the
 * ORIGINAL string. Both always fall on grapheme cluster boundaries.
 */
export function findMatches(
  text: string,
  query: string,
  options?: SearchOptions,
): MatchRange[] {
  if (query.length === 0) return [];
  const opts = resolveOptions(options);
  const needle = foldQuery(query, opts);
  if (needle.length === 0) return [];
  return searchFolded(buildSearchIndex(text, opts), needle);
}

/**
 * @deprecated Legacy helper. Use {@link buildSearchIndex} /
 * {@link findMatches}, which also map ranges back to the original text.
 */
export function normalizeText(value: string): string {
  return foldQuery(value, resolveOptions({ nfc: false }));
}
