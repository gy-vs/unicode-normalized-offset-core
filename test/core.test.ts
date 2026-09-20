import { describe, expect, it } from 'vitest';
import {
  buildSearchIndex,
  findInIndex,
  findMatches,
  normalizeText,
  type MatchRange,
} from '../src/index.js';

const ZWJ = '‍';
const FAMILY = ['👨', ZWJ, '👩', ZWJ, '👧'].join(''); // 👨‍👩‍👧 one grapheme cluster
const HEART_VS = '❤️'; // ❤ + U+FE0F
const ACUTE = '́'; // U+0301 combining acute

/** Assert every endpoint lies on a grapheme boundary and splits no surrogate pair. */
function expectOnGraphemeBoundaries(text: string, matches: MatchRange[]) {
  const boundaries = new Set<number>([0]);
  for (const seg of new Intl.Segmenter().segment(text)) {
    boundaries.add(seg.index + seg.segment.length);
  }
  const splitPair = (offset: number) =>
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff;
  for (const m of matches) {
    expect(boundaries.has(m.start), `start ${m.start} not a cluster boundary`).toBe(true);
    expect(boundaries.has(m.end), `end ${m.end} not a cluster boundary`).toBe(true);
    expect(splitPair(m.start)).toBe(false);
    expect(splitPair(m.end)).toBe(false);
    expect(m.graphemeEnd).toBeGreaterThanOrEqual(m.graphemeStart);
  }
}

describe('NFC / NFD input', () => {
  const nfc = 'Café'.normalize('NFC'); // é = U+00E9, length 4
  const nfd = 'Café'.normalize('NFD'); // e + U+0301, length 5

  it('matches against precomposed NFC text and covers the base letter', () => {
    const m = findMatches(nfc, 'cafe');
    expect(m).toEqual([{ start: 0, end: 4, graphemeStart: 0, graphemeEnd: 4 }]);
    expect(nfc.slice(m[0].start, m[0].end)).toBe(nfc);
  });

  it('matches against decomposed NFD text and covers the trailing combining mark', () => {
    const m = findMatches(nfd, 'cafe');
    expect(m).toEqual([{ start: 0, end: 5, graphemeStart: 0, graphemeEnd: 4 }]);
    expect(nfd.slice(m[0].start, m[0].end)).toBe(nfd); // includes U+0301
  });

  it('keeps folded output composed (NFC) by default, decomposed when nfc:false', () => {
    const composed = buildSearchIndex(nfc, { stripMarks: false });
    expect(composed.folded).toBe('café'.normalize('NFC'));
    expect(composed.groups).toHaveLength(4);

    const decomposed = buildSearchIndex(nfc, { stripMarks: false, nfc: false });
    expect(decomposed.folded).toBe('café'.normalize('NFD'));
  });

  it('maps a hit ending on a decomposed letter to cover its marks', () => {
    const text = `x ${nfd}`;
    const m = findMatches(text, 'cafe');
    expect(m[0].start).toBe(2);
    expect(m[0].end).toBe(7); // e + combining acute fully covered
    expect(text.slice(m[0].start, m[0].end)).toBe(nfd);
  });

  it('matches an NFD query against NFC text', () => {
    expect(findMatches(nfc, 'café'.normalize('NFD'))).toHaveLength(1);
  });
});

describe('fullwidth compatibility folding (NFKD)', () => {
  it('folds fullwidth letters and maps back onto the fullwidth source', () => {
    const text = 'ＨＥＬＬＯ'; // BMP chars, one UTF-16 unit each
    const m = findMatches(text, 'hello');
    expect(m).toEqual([{ start: 0, end: 5, graphemeStart: 0, graphemeEnd: 5 }]);
    expect(text.slice(m[0].start, m[0].end)).toBe(text);
  });

  it('maps a compatibility ligature (ﬁ -> fi) as many-to-one', () => {
    const text = 'ﬁle';
    expect(findMatches(text, 'file')).toEqual([
      { start: 0, end: 3, graphemeStart: 0, graphemeEnd: 3 },
    ]);
    // A prefix of the folded ligature still covers the whole source cluster.
    expect(findMatches(text, 'f')).toEqual([
      { start: 0, end: 1, graphemeStart: 0, graphemeEnd: 1 },
    ]);
  });

  it('can disable compatibility folding', () => {
    expect(findMatches('ＨＥＬＬＯ', 'hello', { compatibility: false })).toEqual([]);
  });
});

describe('German ß (sharp s)', () => {
  it('matches ß against ss and covers the whole cluster', () => {
    expect(findMatches('Straße', 'STRASSE')).toEqual([
      { start: 0, end: 6, graphemeStart: 0, graphemeEnd: 6 },
    ]);
  });

  it('maps an "ss" hit onto the single ß grapheme', () => {
    expect(findMatches('Straße', 'ss')).toEqual([
      { start: 4, end: 5, graphemeStart: 4, graphemeEnd: 5 },
    ]);
    expect('Straße'.slice(4, 5)).toBe('ß');
  });

  it('maps an "as" hit across a and ß without splitting the cluster', () => {
    expect(findMatches('Straße', 'as')).toEqual([
      { start: 3, end: 5, graphemeStart: 3, graphemeEnd: 5 },
    ]);
  });

  it('maps adjacent ß clusters independently for repeated ss hits', () => {
    expect(findMatches('ßß', 'ss')).toEqual([
      { start: 0, end: 1, graphemeStart: 0, graphemeEnd: 1 },
      { start: 1, end: 2, graphemeStart: 1, graphemeEnd: 2 },
    ]);
  });

  it('can disable sharp-s folding', () => {
    expect(findMatches('Straße', 'strasse', { sharpS: false })).toEqual([]);
  });
});

describe('Turkish dotless/dotted I', () => {
  it('folds capital I to dotless ı under the tr locale', () => {
    expect(findMatches('I', 'i', { locale: 'tr' })).toEqual([]);
    expect(findMatches('I', 'ı', { locale: 'tr' })).toEqual([
      { start: 0, end: 1, graphemeStart: 0, graphemeEnd: 1 },
    ]);
  });

  it('folds İ to i under the tr locale', () => {
    const m = findMatches('İZMİR', 'izmir', { locale: 'tr' });
    expect(m).toHaveLength(1);
    expect(m[0].graphemeEnd - m[0].graphemeStart).toBe(5);
  });

  it('uses ordinary i folding without a Turkish locale', () => {
    expect(findMatches('I', 'i')).toEqual([
      { start: 0, end: 1, graphemeStart: 0, graphemeEnd: 1 },
    ]);
  });
});

describe('emoji ZWJ sequences and variation selectors', () => {
  it('treats a ZWJ family as one grapheme; any member hit covers the whole cluster', () => {
    expect(findMatches(`a ${FAMILY} b`, '👨')).toEqual([
      { start: 2, end: 2 + FAMILY.length, graphemeStart: 2, graphemeEnd: 3 },
    ]);
    expect(findMatches(FAMILY, '👩')).toEqual([
      { start: 0, end: FAMILY.length, graphemeStart: 0, graphemeEnd: 1 },
    ]);
    expect(findMatches(FAMILY, '👧')[0]).toMatchObject({ start: 0, end: FAMILY.length });
  });

  it('matches a ZWJ sequence against the plain sequence (join controls stripped)', () => {
    const plain = '👨👩👧';
    expect(findMatches(FAMILY, plain)).toEqual([
      { start: 0, end: FAMILY.length, graphemeStart: 0, graphemeEnd: 1 },
    ]);
  });

  it('covers a trailing variation selector (❤️ vs ❤)', () => {
    expect(findMatches(HEART_VS, '❤')).toEqual([
      { start: 0, end: HEART_VS.length, graphemeStart: 0, graphemeEnd: 1 },
    ]);
  });

  it('keeps ZWJ when join-control stripping is disabled', () => {
    expect(findMatches('a' + ZWJ + 'b', 'ab', { stripJoinControls: false })).toEqual([]);
  });
});

describe('combining-mark-only and zero-width anchoring', () => {
  it('returns no hits for a mark-only query (folds to empty)', () => {
    expect(findMatches('abc', ACUTE)).toEqual([]);
  });

  it('right-anchors a leading zero-width mark onto the first contributing cluster', () => {
    const text = ACUTE + 'abc';
    expect(findMatches(text, 'a')).toEqual([
      { start: 0, end: 2, graphemeStart: 0, graphemeEnd: 2 },
    ]);
  });

  it('does not pull the leading mark into a later hit (left wins)', () => {
    const text = ACUTE + 'abc';
    expect(findMatches(text, 'b')).toEqual([
      { start: 2, end: 3, graphemeStart: 2, graphemeEnd: 3 },
    ]);
  });

  it('left-anchors a trailing zero-width joiner onto the hit', () => {
    const text = 'ab' + ZWJ;
    // ICU groups the joiner with "b": clusters [a, b+ZWJ]. The UTF-16 range
    // still covers the joiner so the hit claims its source bytes.
    expect(findMatches(text, 'b')).toEqual([
      { start: 1, end: text.length, graphemeStart: 1, graphemeEnd: 2 },
    ]);
  });

  it('covers a zero-width joiner sitting between two contributing clusters', () => {
    // Clusters [a+ZWJ, b]; the whole span contributes one folded "ab".
    const text = 'a' + ZWJ + 'b';
    expect(findMatches(text, 'ab')).toEqual([
      { start: 0, end: 3, graphemeStart: 0, graphemeEnd: 2 },
    ]);
  });

  it('does not drag a following zero-width joiner into the next hit', () => {
    const text = 'a' + ZWJ + 'bc';
    // Clusters are [a+ZWJ, b, c]. The ZWJ left-anchors to the "a" hit, so a
    // search for "b" starts after it: source offset 2, grapheme index 1.
    expect(findMatches(text, 'b')).toEqual([
      { start: 2, end: 3, graphemeStart: 1, graphemeEnd: 2 },
    ]);
    // And searching "a" claims the ZWJ (source offsets 0..2, cluster 0).
    expect(findMatches(text, 'a')).toEqual([
      { start: 0, end: 2, graphemeStart: 0, graphemeEnd: 1 },
    ]);
  });
});

describe('multiple / adjacent hits', () => {
  it('finds repeated non-overlapping words with correct independent ranges', () => {
    const text = 'Café'.normalize('NFC').repeat(2);
    const m = findMatches(text, 'cafe');
    expect(m).toEqual([
      { start: 0, end: 4, graphemeStart: 0, graphemeEnd: 4 },
      { start: 4, end: 8, graphemeStart: 4, graphemeEnd: 8 },
    ]);
    expect(text.slice(m[0].start, m[0].end)).toBe('Café');
    expect(text.slice(m[1].start, m[1].end)).toBe('Café');
  });

  it('finds every adjacent single-letter hit without overlap', () => {
    expect(findMatches('aaa', 'a')).toEqual([
      { start: 0, end: 1, graphemeStart: 0, graphemeEnd: 1 },
      { start: 1, end: 2, graphemeStart: 1, graphemeEnd: 2 },
      { start: 2, end: 3, graphemeStart: 2, graphemeEnd: 3 },
    ]);
  });

  it('takes non-overlapping longer matches', () => {
    expect(findMatches('aaaa', 'aa')).toEqual([
      { start: 0, end: 2, graphemeStart: 0, graphemeEnd: 2 },
      { start: 2, end: 4, graphemeStart: 2, graphemeEnd: 4 },
    ]);
  });

  it('handles mixed-width adjacent hits', () => {
    const text = 'éß';
    expect(findMatches(text, 'ess')).toEqual([
      { start: 0, end: 2, graphemeStart: 0, graphemeEnd: 2 },
    ]);
    expect(text.slice(0, 2)).toBe(text);
  });

  it('finds multiple words separated by folded-away marks', () => {
    const text = 'naïve naïve';
    const m = findMatches(text, 'naive');
    expect(m).toHaveLength(2);
    expect(text.slice(m[0].start, m[0].end)).toBe('naïve');
    expect(text.slice(m[1].start, m[1].end)).toBe('naïve');
  });
});

describe('surrogate and cluster-boundary safety', () => {
  it('never splits an astral-plane character', () => {
    const text = 'x😀y';
    expect(findMatches(text, '😀')).toEqual([
      { start: 1, end: 3, graphemeStart: 1, graphemeEnd: 2 },
    ]);
  });

  it('all reported endpoints are grapheme boundaries across mixed content', () => {
    const text = [
      'a',
      FAMILY,
      HEART_VS,
      'Café'.normalize('NFD'),
      'Straße',
      'ＨＥＬＬＯ',
      'x' + ACUTE + 'y',
    ].join(' ');
    for (const query of ['cafe', 'strasse', 'hello', '❤', '👩', 'y']) {
      const ms = findMatches(text, query);
      expect(ms.length).toBeGreaterThan(0);
      expectOnGraphemeBoundaries(text, ms);
    }
  });

  it('never returns overlapping ranges', () => {
    const text = 'ﬁßＨＥＬＬＯ' + FAMILY + 'é'.repeat(20);
    const ms = findMatches(text, 'e');
    for (let i = 1; i < ms.length; i++) expect(ms[i].start).toBeGreaterThanOrEqual(ms[i - 1].end);
    expectOnGraphemeBoundaries(text, ms);
  });
});

describe('many-to-many atomicity and zero-width adjacent hits', () => {
  it('keeps an expanded cluster atomic for a prefix-only folded match', () => {
    // ﬁ -> "fi"; matching just "f" or "i" still covers the whole ligature.
    const text = 'ﬁ';
    expect(findMatches(text, 'f')).toEqual([
      { start: 0, end: 1, graphemeStart: 0, graphemeEnd: 1 },
    ]);
    expect(findMatches(text, 'i')).toEqual([
      { start: 0, end: 1, graphemeStart: 0, graphemeEnd: 1 },
    ]);
  });

  it('expanded cluster participates in surrounding hits without splitting', () => {
    expect(findMatches('xﬁy', 'fi')).toEqual([
      { start: 1, end: 2, graphemeStart: 1, graphemeEnd: 2 },
    ]);
    expect(findMatches('xﬁy', 'xfi')).toEqual([
      { start: 0, end: 2, graphemeStart: 0, graphemeEnd: 2 },
    ]);
  });

  it('surrogate-pair-only folded group stays whole for each adjacent hit', () => {
    // Two astral emoji next to each other map to independent whole clusters.
    const text = '😀😀';
    expect(findMatches(text, '😀')).toEqual([
      { start: 0, end: 2, graphemeStart: 0, graphemeEnd: 1 },
      { start: 2, end: 4, graphemeStart: 1, graphemeEnd: 2 },
    ]);
  });

  it('zero-width marks between adjacent hits are claimed by one hit only', () => {
    // "e" occurs twice; the combining mark after the first é folds away but
    // belongs deterministically to the first hit (left anchoring).
    const text = 'é' + ACUTE + 'e'; // é-accute(its own cluster) e
    const ms = findMatches(text, 'e');
    expect(ms).toHaveLength(2);
    expect(ms[1].start).toBeGreaterThanOrEqual(ms[0].end);
    expectOnGraphemeBoundaries(text, ms);
    // The second hit never reaches back into the first cluster's span.
    expect(text.slice(ms[1].start, ms[1].end)).toBe('e');
  });

  it('maps every hit of a query over expanded ß clusters without overlap', () => {
    const text = 'aßbßc';
    const ms = findMatches(text, 'ss');
    expect(ms).toHaveLength(2);
    expect(ms[0]).toEqual({ start: 1, end: 2, graphemeStart: 1, graphemeEnd: 2 });
    expect(ms[1]).toEqual({ start: 3, end: 4, graphemeStart: 3, graphemeEnd: 4 });
    expect(ms[1].start).toBeGreaterThanOrEqual(ms[0].end);
  });
});

describe('index reuse, options and legacy API', () => {
  it('reuses a built index for several queries', () => {
    const idx = buildSearchIndex('Die Straße ist schön.');
    expect(findInIndex(idx, 'strasse')).toHaveLength(1);
    expect(findInIndex(idx, 'schon')).toHaveLength(1);
    expect(findInIndex(idx, 'gasse')).toEqual([]);
  });

  it('honours options when building the index', () => {
    expect(buildSearchIndex('CAFÉ').folded).toBe('cafe');
    // No case fold, but the decomposed mark of É is still stripped.
    expect(buildSearchIndex('CAFÉ', { caseFold: false }).folded).toBe('CAFE');
    expect(buildSearchIndex('Café', { stripMarks: false }).folded).toBe('café');
  });

  it('returns no matches for empty query or empty folded query', () => {
    expect(findMatches('abc', '')).toEqual([]);
    expect(findMatches('abc', ACUTE)).toEqual([]);
  });

  it('still exports the legacy normalizer', () => {
    expect(normalizeText('Café')).toBe('cafe');
    expect(normalizeText('STRAßE')).toBe('strasse');
  });

  it('stays linear for long heavily-accented text (no quadratic prefix normalization)', () => {
    const text = ('é'.repeat(50_000) + 'NEEDLE' + 'é'.repeat(50_000)).normalize('NFD');
    const started = Date.now();
    const m = findMatches(text, 'needle');
    expect(m).toHaveLength(1);
    expect(text.slice(m[0].start, m[0].end)).toBe('NEEDLE');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
