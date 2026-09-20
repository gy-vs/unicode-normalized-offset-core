# Unicode search core

TypeScript library for normalized text matching with **correct source ranges**.

The search representation is NFC/NFD-insensitive, compatibility-folded
(full-width, ligatures, mathematical alphanumerics), case-folded, and
diacritic-stripped. A many-to-many map from folded UTF-16 offsets back to the
original **grapheme clusters** is maintained in a single linear pass, so the
ranges returned for a match never split a surrogate pair or a grapheme cluster
(combining marks, `ß` fan-out, emoji ZWJ sequences, …).

## Usage

```ts
import { buildSearchRepresentation, findMatches } from './dist/index.js';

// One-off
findMatches('Café'.normalize('NFD'), 'cafe');
// => [{ start: 0, end: 4 }]  // end covers the combining acute too

// Reuse the folded representation + offset map for many queries
const rep = buildSearchRepresentation('saß da');
rep.text;            // "sass da"
rep.findAll('sass'); // [{ start: 0, end: 3 }]  // "saß" as one source span
rep.findAll('ss', { includeGraphemeIndices: true });
// => [{ start: 2, end: 3, graphemeStart: 2, graphemeEnd: 3 }]

rep.mapRange(2, 4); // folded offsets -> { start, end, graphemeStart, graphemeEnd }

// Locale-sensitive folding (Turkish/Azerbaijani dotted/dotless I)
findMatches('İstanbul', 'istanbul', { locale: 'tr' });
```

### Mapping rules

- Every folded code unit records the original grapheme cluster that produced it
  (fan-in: NFD base + marks; fan-out: `ß → ss`, ligature `ﬁ → fi`).
- A folded range maps to the smallest cluster span covering every contributor.
- Zero-width clusters (marks that fold away) attach **left** to the nearest
  non-empty cluster; leading start-of-text runs attach **right**.

Run `npm install`, then `npm test` and `npm run build`.
