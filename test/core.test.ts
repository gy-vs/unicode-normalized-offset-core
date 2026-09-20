import { describe, expect, it } from 'vitest';
import { buildSearchRepresentation, findMatches, normalizeText } from '../src/index.js';

/** A match must cut the original text neither mid-surrogate nor mid-cluster. */
function matchedSlices(text: string, query: string, options?: Parameters<typeof findMatches>[2]) {
	return findMatches(text, query, options).map((m) => text.slice(m.start, m.end));
}

describe('NFC / NFD equivalence', () => {
	it('matches and maps ranges for both encodings', () => {
		const text = 'Café résumé';
		const nfc = text.normalize('NFC');
		const nfd = text.normalize('NFD');

		for (const variant of [nfc, nfd]) {
			const hits = findMatches(variant, 'cafe');
			expect(hits).toHaveLength(1);
			expect(variant.slice(hits[0].start, hits[0].end)).toBe('Café'.normalize(variant === nfc ? 'NFC' : 'NFD'));
		}

		// NFD "é" is two UTF-16 units (e + combining acute): the range must
		// include the combining mark, not stop after the base letter.
		const nfdCafe = 'Café'.normalize('NFD');
		const [hit] = findMatches(nfdCafe, 'cafe');
		expect(nfdCafe.slice(hit.start, hit.end)).toBe(nfdCafe);
		expect(hit.end - hit.start).toBe(nfdCafe.length);
	});

	it('folds NFC and NFD to identical representations', () => {
		expect(normalizeText('Café'.normalize('NFC'))).toBe(normalizeText('Café'.normalize('NFD')));
		expect(normalizeText('Café'.normalize('NFC'))).toBe('cafe');
	});

	it('grapheme indices never split a decomposed cluster', () => {
		const text = 'aéb'.normalize('NFD'); // a, é(base+acute), b
		const [hit] = findMatches(text, 'e', { includeGraphemeIndices: true });
		expect(hit.graphemeStart).toBe(1);
		expect(hit.graphemeEnd).toBe(2);
		expect(text.slice(hit.start, hit.end)).toBe('é'.normalize('NFD'));
	});
});

describe('compatibility folding (NFKC-equivalent search)', () => {
	it('folds full-width ASCII', () => {
		const text = 'Ｈｅｌｌｏ world';
		const hits = findMatches(text, 'hello');
		expect(hits).toHaveLength(1);
		expect(text.slice(hits[0].start, hits[0].end)).toBe('Ｈｅｌｌｏ');
	});

	it('folds ligatures and expands onto all contributing graphemes', () => {
		// ﬁ is a single grapheme; folded text contains "fi".
		expect(matchedSlices('ﬁle', 'fi')).toEqual(['ﬁ']);
		expect(matchedSlices('aﬀord', 'ff')).toEqual(['ﬀ']);
	});

	it('folds astral mathematical alphanumerics without splitting surrogates', () => {
		const text = '𝔽 is bold';
		const [hit] = findMatches(text, 'f');
		// Range must be exactly the 2 UTF-16 units of the surrogate pair.
		expect(hit.end - hit.start).toBe(2);
		expect(text.slice(hit.start, hit.end)).toBe('𝔽');
	});

	it('keeps folded text stable across internal chunk boundaries', () => {
		// The segmenter windows input at 1024 units; clusters straddling a
		// boundary (NFD mark, ZWJ, VS16, RI pairs, keycaps) must stay intact.
		const suffixes = ['é'.normalize('NFD'), '👨‍👩‍👧', '❤️', '🇺🇸', '#️⃣', '𝔽', 'ﬁ', 'ß'];
		for (let pad = 1020; pad <= 1026; pad++) {
			for (const suffix of suffixes) {
				const text = 'a'.repeat(pad) + suffix;
				const rep = buildSearchRepresentation(text);
				const suffixFolded = normalizeText(suffix);
				// Folding the suffix on its own must equal the folded tail.
				expect(rep.text.endsWith(suffixFolded)).toBe(true);
				// Any match contributed by the suffix maps onto the whole suffix.
				for (const m of rep.findAll(suffixFolded)) {
					expect(text.slice(m.start, m.end)).toBe(suffix);
				}
				// When the suffix survives folding, its full folded span maps to
				// the whole suffix cluster (even a multi-unit ZWJ sequence).
				if (suffixFolded.length > 0) {
					const span = rep.mapRange(rep.text.length - suffixFolded.length, rep.text.length);
					expect(text.slice(span.start, span.end)).toBe(suffix);
				}
			}
		}
	});
});

describe('German eszett', () => {
	it('expands ß to ss and covers the whole source cluster', () => {
		const text = 'saß da';
		const hits = findMatches(text, 'sass');
		expect(hits).toHaveLength(1);
		expect(text.slice(hits[0].start, hits[0].end)).toBe('saß');

		const rep = buildSearchRepresentation(text);
		expect(rep.text).toBe('sass da');
		// Every folded code unit of "ss" points back at the ß cluster (index 2).
		expect(rep.mapRange(2, 4)).toMatchObject({ graphemeStart: 2, graphemeEnd: 3 });
	});

	it('covers capital ẞ via lowercasing then ss expansion', () => {
		expect(matchedSlices('Großes', 'ss')).toEqual(['ß']);
		expect(matchedSlices('STRASSE'.replace('SS', 'ẞ'), 'ss')).toEqual(['ẞ']);
	});

	it('still matches literal ss in source as two graphemes', () => {
		const [hit] = findMatches('strasse', 'ss', { includeGraphemeIndices: true });
		// s t r a s s e -> clusters 0..6, the "ss" is clusters 4 and 5.
		expect(hit.graphemeStart).toBe(4);
		expect(hit.graphemeEnd).toBe(6);
	});
});

describe('Turkish dotted/dotless I', () => {
	it('uses locale folding only when requested', () => {
		// Default pipeline: İ -> i + combining dot -> dot stripped -> plain i.
		expect(normalizeText('İstanbul')).toBe('istanbul');
		expect(matchedSlices('İstanbul', 'istanbul')).toEqual(['İstanbul']);
		expect(matchedSlices('İstanbul', 'istanbul', { locale: 'tr' })).toEqual(['İstanbul']);
	});

	it('maps dotless ı for I in Turkish locale', () => {
		const text = 'IĞDIR';
		expect(findMatches(text, 'i', { locale: 'tr' })).toEqual([]);
		// Both I letters fold to dotless ı; Ğ strips its breve to g.
		const hits = findMatches(text, 'ı', { locale: 'tr' });
		expect(hits).toHaveLength(2);
		expect(hits.map((m) => text.slice(m.start, m.end))).toEqual(['I', 'I']);
	});

	it('default locale still folds I to plain i', () => {
		expect(matchedSlices('Istanbul', 'i')).toEqual(['I']);
	});

	it('handles i followed by a combining dot as one grapheme in tr locale', () => {
		const text = 'i̇stanbul'; // i + U+0307
		expect(matchedSlices(text, 'istanbul', { locale: 'tr' })).toEqual(['i̇stanbul']);
	});
});

describe('emoji and ZWJ sequences', () => {
	it('treats a ZWJ family sequence as one contributing grapheme', () => {
		const text = '👨‍👩‍👧!';
		const [hit] = findMatches(text, '👨‍👩‍👧', { includeGraphemeIndices: true });
		expect(text.slice(hit.start, hit.end)).toBe('👨‍👩‍👧');
		expect(hit.graphemeStart).toBe(0);
		expect(hit.graphemeEnd).toBe(1);
		// The "!" after it is a separate match with no overlap.
		expect(matchedSlices(text, '!')).toEqual(['!']);
	});

	it('does not split surrogate pairs or variation sequences', () => {
		const text = '❤️ ok';
		const [hit] = findMatches(text, '❤️');
		expect(hit.start).toBe(0);
		expect(text.slice(hit.start, hit.end)).toBe('❤️');
	});

	it('searching a sequence folded away from marks still covers the cluster', () => {
		const text = '#️⃣ tag'; // # + VS16 + combining enclosing keycap
		const hits = findMatches(text, '#');
		expect(hits).toHaveLength(1);
		expect(text.slice(hits[0].start, hits[0].end)).toBe('#️⃣');
	});
});

describe('combining-mark-only runs (zero-width clusters)', () => {
	it('leading marks attach right to the first matched grapheme', () => {
		const text = '́̂ab'; // [marks-cluster], a, b
		const [hitA] = findMatches(text, 'a');
		expect(text.slice(hitA.start, hitA.end)).toBe('́̂a');
		const [hitB] = findMatches(text, 'b', { includeGraphemeIndices: true });
		expect(text.slice(hitB.start, hitB.end)).toBe('b');
		expect(hitB.graphemeStart).toBe(2);
	});

	it('interior orphan marks attach left to the preceding match', () => {
		// Newline breaks grapheme attachment, so the combining mark is its own
		// cluster: "a" "\ń" "b"
		const text = 'a\ńb';
		const [hitA] = findMatches(text, 'a');
		expect(text.slice(hitA.start, hitA.end)).toBe('a'); // newline is non-empty, mark is not after a
		const [hitB] = findMatches(text, 'b');
		expect(text.slice(hitB.start, hitB.end)).toBe('b');
	});

	it('orphan mark directly after a letter merges into that letter’s cluster', () => {
		const text = 'áb';
		const [hitA] = findMatches(text, 'a');
		expect(text.slice(hitA.start, hitA.end)).toBe('á');
	});

	it('trailing mark clusters attach left to the preceding hit', () => {
		// ZWJ? No: use a control char so the trailing mark is its own cluster.
		const text = 'ab\0́'; // a, b, NUL, combining-acute
		const hits = findMatches(text, 'ab');
		expect(text.slice(hits[0].start, hits[0].end)).toBe('ab'); // NUL is non-empty
		const hitsB = findMatches(text, 'b');
		expect(text.slice(hitsB[0].start, hitsB[0].end)).toBe('b');
	});

	it('marks-only query matches nothing', () => {
		expect(findMatches('abc', '́')).toEqual([]);
		expect(findMatches('́abc', '́̂')).toEqual([]);
	});
});

describe('multiple and adjacent hits', () => {
	it('returns all non-overlapping hits with exact original ranges', () => {
		const text = 'Café café CAFÉ'.normalize('NFD');
		const hits = findMatches(text, 'cafe', { includeGraphemeIndices: true });
		expect(hits).toHaveLength(3);
		const slices = hits.map((m) => text.slice(m.start, m.end));
		expect(slices.every((s) => normalizeText(s) === 'cafe')).toBe(true);
		// Ranges are disjoint and in order.
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i].start).toBeGreaterThanOrEqual(hits[i - 1].end);
		}
		// Grapheme counts: spaces sit between clusters 4 and 9.
		expect(hits[0].graphemeEnd).toBe(4);
		expect(hits[1].graphemeStart).toBe(5);
	});

	it('maps adjacent hits sharing no gap when expansions touch', () => {
		const text = 'aáb'; // clusters: á(folds a), a ... search "aa"
		const hits = findMatches(text, 'aa');
		expect(hits).toHaveLength(1);
		expect(text.slice(hits[0].start, hits[0].end)).toBe('aá');
	});

	it('repeated single-letter hits inside an expanded ß each cover the whole ß', () => {
		const text = 'saß'; // folded: s a s s — ß fans out to two units
		const hits = findMatches(text, 's');
		expect(hits.map((m) => text.slice(m.start, m.end))).toEqual(['s', 'ß', 'ß']);
		// Hits are non-overlapping in folded space but converge on the one
		// contributing source grapheme, without splitting it.
	});
});

describe('linear mapping construction', () => {
	it('does not re-normalize prefixes: long pathological input stays fast', () => {
		// O(n²) prefix normalization would time out on this size.
		const text = 'é'.repeat(20_000).normalize('NFD') + 'needle';
		const started = Date.now();
		const hits = findMatches(text, 'needle');
		expect(hits).toHaveLength(1);
		expect(text.slice(hits[0].start, hits[0].end)).toBe('needle');
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('mapRange covers every contributing cluster for fan-out and fan-in', () => {
		const rep = buildSearchRepresentation('aß́x'); // a, ß, ́(attached? after ß -> one cluster), x
		// "ß" + combining acute is one grapheme cluster folding to "ss".
		const range = rep.mapRange(1, 3); // folded: a s s x
		expect(rep.text).toBe('assx');
		expect(range).toMatchObject({ graphemeStart: 1, graphemeEnd: 2 });
	});
});

describe('mapRange validation', () => {
	it('rejects empty or out-of-bounds folded ranges', () => {
		const rep = buildSearchRepresentation('abc');
		expect(() => rep.mapRange(1, 1)).toThrow(RangeError);
		expect(() => rep.mapRange(-1, 1)).toThrow(RangeError);
		expect(() => rep.mapRange(2, 4)).toThrow(RangeError);
	});
});
