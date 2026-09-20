/**
 * Normalized text search core.
 *
 * The search representation is produced per grapheme cluster of the original
 * text: each cluster is folded independently, and every UTF-16 code unit of
 * the folded output records which original cluster it came from. This keeps a
 * many-to-many mapping (one cluster may fan out, e.g. ß -> "ss", several
 * clusters may collapse, e.g. NFD base + combining marks) in a single linear
 * pass — the text is segmented once and normalized once per cluster, never
 * re-normalized for every prefix.
 */

export interface SearchOptions {
	/** BCP-47 tag for locale-sensitive case folding (e.g. "tr" / "az"). */
	locale?: string;
}

export interface FindOptions extends SearchOptions {
	/** Populate graphemeStart/graphemeEnd on every returned match. */
	includeGraphemeIndices?: boolean;
}

/** A match mapped back onto the original text. Offsets are UTF-16 code units. */
export interface Match {
	/** Inclusive start offset in the original text. */
	start: number;
	/** Exclusive end offset in the original text. */
	end: number;
	/** Inclusive grapheme cluster index in the original text (optional). */
	graphemeStart?: number;
	/** Exclusive grapheme cluster index in the original text (optional). */
	graphemeEnd?: number;
}

/** Result of mapping a folded-text range back to the original text. */
export interface SourceRange {
	start: number;
	end: number;
	graphemeStart: number;
	graphemeEnd: number;
}

export interface SearchRepresentation {
	/** The folded text that matching runs against. */
	readonly text: string;
	/** Find all non-overlapping occurrences of query, mapped to the original. */
	findAll(query: string, options?: FindOptions): Match[];
	/** Map a non-empty UTF-16 range of the folded text onto the original. */
	mapRange(normalizedStart: number, normalizedEnd: number): SourceRange;
}

const MARK_RE = /\p{M}/gu;

/**
 * UTF-16 window size for grapheme segmentation. V8's segment iterator exhibits
 * superlinear behavior on long strings, so input is segmented in short windows.
 * Windows are stitched together at cluster-safe boundaries below.
 */
const SEGMENT_CHUNK = 1024;

let cachedSegmenter: Intl.Segmenter | undefined;

function getSegmenter(): Intl.Segmenter {
	return (cachedSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' }));
}

/**
 * Iterate the grapheme clusters of `text` in order, with absolute UTF-16
 * indices. Runs in linear time: the string is segmented in short windows, and
 * consecutive windows overlap by exactly one cluster. That overlap is
 * mandatory — the final cluster of a window might gain continuation in the
 * next one (an NFD combining mark, ZWJ, variation selector, …), so it is held
 * back and re-segmented with what follows. Advancing only at cluster
 * boundaries guarantees a surrogate pair or grapheme cluster is never split.
 */
function forEachGrapheme(text: string, callback: (cluster: string, index: number) => void): void {
	const segmenter = getSegmenter();
	const length = text.length;
	let windowStart = 0;

	while (windowStart < length) {
		// Grow the window until it contains at least one cluster that is
		// definitely complete (all but the final cluster of a window are).
		let windowEnd = Math.min(length, windowStart + SEGMENT_CHUNK);
		let clusters: Array<{ segment: string; index: number }>;
		for (;;) {
			clusters = [...segmenter.segment(text.slice(windowStart, windowEnd))];
			if (windowEnd === length || clusters.length >= 2) break;
			const widened = Math.min(length, windowEnd + SEGMENT_CHUNK);
			if (widened === windowEnd) break;
			windowEnd = widened;
		}

		const atEnd = windowEnd === length;
		const emitCount = atEnd ? clusters.length : clusters.length - 1;
		for (let i = 0; i < emitCount; i++) {
			callback(clusters[i].segment, windowStart + clusters[i].index);
		}

		const nextBoundary = atEnd
			? clusters[clusters.length - 1].index + clusters[clusters.length - 1].segment.length
			: clusters[clusters.length - 1].index;
		windowStart += nextBoundary;
	}
}

/**
 * Fold a single original grapheme cluster into its search representation.
 * NFC and NFD inputs converge here; NFKD additionally performs compatibility
 * folding (full-width, ligatures, mathematical alphanumerics, …).
 */
function foldCluster(cluster: string, locale: string | undefined): string {
	// Case-fold before decomposing so Turkish İ/I semantics resolve while the
	// letters are still intact (NFKD would turn İ into "i" + combining dot).
	let folded = locale ? cluster.toLocaleLowerCase(locale) : cluster.toLowerCase();
	// Default case folding of German eszett; after lowercasing, capital ẞ is ß.
	folded = folded.replaceAll('ß', 'ss');
	folded = folded.normalize('NFKD');
	// Compatibility decomposition can surface new letters (e.g. 𝔽 -> "F",
	// Ⅰ -> "I"); strip marks, then apply locale folding once more so those
	// letters are handled too (idempotent for already-lowercase text).
	folded = folded.replace(MARK_RE, '');
	return locale ? folded.toLocaleLowerCase(locale) : folded.toLowerCase();
}

/** Fold a full string cluster by cluster, keeping the pipeline symmetric. */
function foldText(value: string, locale: string | undefined): string {
	const parts: string[] = [];
	forEachGrapheme(value, (cluster) => {
		parts.push(foldCluster(cluster, locale));
	});
	return parts.join('');
}

/**
 * Build the search representation together with the mapping back to the
 * original grapheme clusters.
 */
export function buildSearchRepresentation(text: string, options?: SearchOptions): SearchRepresentation {
	const locale = options?.locale;

	// Per-cluster source location (UTF-16) and folded contribution.
	const clusterStart: number[] = [];
	const clusterEnd: number[] = [];
	const outputLength: number[] = [];
	const parts: string[] = [];

	forEachGrapheme(text, (segment, index) => {
		clusterStart.push(index);
		clusterEnd.push(index + segment.length);
		const folded = foldCluster(segment, locale);
		outputLength.push(folded.length);
		parts.push(folded);
	});

	const normalized = parts.join('');
	const clusterCount = outputLength.length;

	// owner[u] is the original cluster that produced folded code unit u.
	// Filling the spans is linear in the folded length overall.
	const owner = new Int32Array(normalized.length);
	let outputPos = 0;
	for (let i = 0; i < clusterCount; i++) {
		const len = outputLength[i];
		if (len > 0) owner.fill(i, outputPos, outputPos + len);
		outputPos += len;
	}

	// For every zero-width cluster (one that folded to nothing, e.g. an orphan
	// combining mark) decide a deterministic anchor: the nearest non-empty
	// cluster on its left; when there is none (start of text) the first
	// non-empty cluster on its right. -1 only occurs for all-empty text,
	// which can never contain a match.
	const anchor = new Int32Array(clusterCount).fill(-1);
	let lastNonEmpty = -1;
	for (let i = 0; i < clusterCount; i++) {
		if (outputLength[i] > 0) {
			lastNonEmpty = i;
		} else {
			anchor[i] = lastNonEmpty;
		}
	}
	let pendingStart = -1;
	for (let i = 0; i < clusterCount; i++) {
		if (outputLength[i] === 0 && anchor[i] === -1) {
			if (pendingStart === -1) pendingStart = i;
		} else if (outputLength[i] > 0 && pendingStart !== -1) {
			anchor.fill(i, pendingStart, i);
			pendingStart = -1;
		}
	}

	function mapRange(normalizedStart: number, normalizedEnd: number): SourceRange {
		if (
			!Number.isInteger(normalizedStart) ||
			!Number.isInteger(normalizedEnd) ||
			normalizedStart < 0 ||
			normalizedEnd > normalized.length ||
			normalizedEnd <= normalizedStart
		) {
			throw new RangeError(`Invalid normalized range: [${normalizedStart}, ${normalizedEnd})`);
		}

		const first = owner[normalizedStart];
		const last = owner[normalizedEnd - 1];
		let lo = first;
		let hi = last;

		// Absorb adjacent zero-width clusters whose anchor lies inside the hit:
		// leading start-of-text runs attach right, trailing/interior runs left.
		while (lo > 0 && outputLength[lo - 1] === 0) {
			const a = anchor[lo - 1];
			if (a < first || a > last) break;
			lo--;
		}
		while (hi + 1 < clusterCount && outputLength[hi + 1] === 0) {
			const a = anchor[hi + 1];
			if (a < first || a > last) break;
			hi++;
		}

		return {
			start: clusterStart[lo],
			end: clusterEnd[hi],
			graphemeStart: lo,
			graphemeEnd: hi + 1,
		};
	}

	function findAll(query: string, options?: FindOptions): Match[] {
		const needle = foldText(query, locale);
		if (needle.length === 0) return [];

		const out: Match[] = [];
		let at = 0;
		let hit: number;
		while ((hit = normalized.indexOf(needle, at)) >= 0) {
			const range = mapRange(hit, hit + needle.length);
			const match: Match = { start: range.start, end: range.end };
			if (options?.includeGraphemeIndices) {
				match.graphemeStart = range.graphemeStart;
				match.graphemeEnd = range.graphemeEnd;
			}
			out.push(match);
			at = hit + needle.length;
		}
		return out;
	}

	return { text: normalized, findAll, mapRange };
}

/** Convenience wrapper: build a representation and run one query. */
export function findMatches(text: string, query: string, options?: FindOptions): Match[] {
	return buildSearchRepresentation(text, options).findAll(query, options);
}

/** Produce only the folded search text. */
export function normalizeText(value: string, options?: SearchOptions): string {
	return foldText(value, options?.locale);
}
