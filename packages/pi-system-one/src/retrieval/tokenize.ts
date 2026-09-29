/**
 * Tokenizer for BM25 retrieval over capability descriptions.
 *
 * Capability names are written in every convention at once, so the tokenizer has to
 * normalise them before scoring: `ngs-bulk-rnaseq` has to become three terms, and
 * `transformers.js` has to become `transformers` rather than `js`. A tokenizer bug here is
 * silent — retrieval simply gets worse — so its behaviour is pinned by tests.
 */

/**
 * Minimal English stopword list.
 *
 * Deliberately small. Words like `use`, `create`, `fix`, `write` and `add` carry most of
 * the signal in a capability description and are kept even though a general-purpose list
 * would drop them.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
  'you',
  'your',
]);

/** A trailing file extension is naming noise, not content: `SKILL.md` is `skill`. */
const TRAILING_EXTENSION = /\.(md|markdown|toml|json|ya?ml|txt)$/i;

/** Endings that never take a plural `s`, so the trailing `s` is part of the word. */
const NOT_PLURAL = /(ss|us|is)$/;

/** Plural `-es` after a sibilant: `indexes` -> `index`, `watches` -> `watch`. */
const SIBILANT_ES = /(s|x|z|ch|sh)es$/;

/** Plural `-ies` -> `-y`: `policies` -> `policy`. */
const IES_PLURAL = /ies$/;

/**
 * Reduce a regular English plural to its singular form.
 *
 * Deliberately not a stemmer. Only the endings that actually occur in capability names and
 * descriptions are handled, because the failure mode of an over-eager stemmer is merging two
 * distinct terms, which no amount of tuning detects.
 *
 * Both sides of a search go through this function, so even an imperfect reduction still
 * matches: `postgres` and `postgres` both become `postgre`, which is ugly but symmetric.
 * What it fixes is asymmetric morphology — a query saying `plan` against a name saying
 * `plans`, or `index` against `indexes` — which exact token matching otherwise misses
 * entirely. That was the dominant cause of the regressions measured when BM25 replaced
 * substring matching, which had been handling those variants by accident.
 */
export function singularize(token: string): string {
  if (token.length <= 4) return token;
  if (NOT_PLURAL.test(token)) return token;
  if (SIBILANT_ES.test(token)) return token.slice(0, -2);
  if (IES_PLURAL.test(token)) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

/** Boundary between a lower/digit run and an upper run: `claudeFable` -> `claude Fable`. */
const LOWER_TO_UPPER = /(\p{Ll}|\p{N})(\p{Lu})/gu;

/** Boundary inside an acronym run: `HTTPServer` -> `HTTP Server`. */
const ACRONYM_TO_WORD = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;

/**
 * Split text into lowercase search terms.
 *
 * The separator is "not a letter and not a number" rather than ASCII punctuation, so
 * accented text is safe and non-Latin scripts tokenise on their own terms. That also
 * means a query term only matches a whole word: `we` inside `powered` and `are` inside
 * `software` are not matches, which the previous substring scorer treated them as.
 */
export function tokenize(input: string): string[] {
  if (input.length === 0) return [];

  const withoutExtension = input.replace(TRAILING_EXTENSION, '');
  const spaced = withoutExtension
    .replace(LOWER_TO_UPPER, '$1 $2')
    .replace(ACRONYM_TO_WORD, '$1 $2')
    .toLowerCase();

  const tokens: string[] = [];
  for (const raw of spaced.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.push(singularize(raw));
  }
  return tokens;
}
