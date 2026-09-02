/**
 * intentInference.ts
 *
 * Reads what the author is *trying to do* from the code they have already
 * written, so the completion prompt can carry an explicit hypothesis rather
 * than leaving the model to guess from raw text.
 *
 * Four sources of evidence, none of which need a language server:
 *
 *   • The name of the enclosing function. `fetchUserOrders` is a verb applied
 *     to a subject; the verb says what shape the body takes (a fetch awaits and
 *     returns, a validate checks and throws, a build accumulates and returns).
 *   • The signature. Parameters that have not been referenced yet are work the
 *     function has not done; a declared return type that nothing satisfies yet
 *     is a debt the next statements have to pay.
 *   • The bindings in scope. A local initialised to `[]` or `0` before a loop
 *     is an accumulator, and the statement being typed almost certainly writes
 *     to it.
 *   • The block the cursor sits directly inside — a loop over a named
 *     collection, a catch with a bound error, a guard chain — which constrains
 *     what can sensibly come next.
 *
 * Everything here is derived, cheap and pure. `signatureExtractor.ts` supplies
 * the scope and bindings; this module only interprets them.
 */

import { Binding, DocLike, stripLiterals } from './signatureExtractor';

// ─── Types ────────────────────────────────────────────────────────────────────

/** What the enclosing function's name says it is for. */
export type GoalKind =
  | 'fetch'      // load / get / read / query — retrieves something
  | 'create'     // build / make / new — constructs and returns
  | 'transform'  // map / convert / parse / format — in one shape, out another
  | 'compute'    // calculate / count / sum — derives a value
  | 'validate'   // check / ensure / assert — verifies, throws or returns bool
  | 'predicate'  // is / has / can / should — returns a boolean
  | 'mutate'     // set / add / update / save — changes state, often returns void
  | 'handle'     // on* / handle* — event or callback body
  | 'test'       // a test case
  | 'unknown';

export type ConstructKind =
  | 'loop' | 'branch' | 'try' | 'catch' | 'finally' | 'switch' | 'with' | 'callback';

export interface OpenConstruct {
  kind: ConstructKind;
  /** The header line, trimmed. */
  header: string;
  line: number;
  /** Loop variable, or the binding a catch introduced. */
  binding: string;
  /** The collection a for-of / for-in iterates, when there is one. */
  iterable: string;
  /** The condition of a branch / while, when there is one. */
  condition: string;
}

/**
 * How much code the cursor position calls for. Ghost text that finishes a
 * half-typed expression should be one line; ghost text on an empty line in a
 * body can be a couple of statements; ghost text after an opening brace can be
 * a whole block.
 */
export type SuggestionShape = 'expression' | 'statement' | 'block';

export interface IntentContext {
  /** Plain-English reading of the enclosing name, e.g. "fetch user orders". */
  goal: string;
  goalKind: GoalKind;
  /** The object of the goal — "user orders" for `fetchUserOrders`. */
  subject: string;
  /** Parameters the body has not referenced yet. */
  unusedParams: string[];
  /** Locals declared above the cursor and not read since. */
  unusedLocals: Binding[];
  /** A collection/counter initialised before a loop and written inside it. */
  accumulator: Binding | null;
  /** The innermost block the cursor sits directly inside. */
  openConstruct: OpenConstruct | null;
  /** `if (...) return` / `throw` statements already written at the top. */
  guardCount: number;
  /** The function owes a value that nothing in the body has produced yet. */
  returnPending: boolean;
  expectedShape: SuggestionShape;
  /** Ranked hypotheses for what the next statement does, most likely first. */
  nextSteps: string[];
}

// ─── Reading a name ───────────────────────────────────────────────────────────

/**
 * Split an identifier into its words: camelCase, PascalCase, snake_case,
 * kebab-case and SCREAMING_CASE all reduce to lowercase word lists.
 */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/^[_$]+|[_$]+$/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

const VERB_KINDS: Record<string, GoalKind> = {
  fetch: 'fetch', get: 'fetch', load: 'fetch', read: 'fetch', find: 'fetch',
  query: 'fetch', list: 'fetch', search: 'fetch', lookup: 'fetch', retrieve: 'fetch',
  resolve: 'fetch', request: 'fetch', download: 'fetch',

  create: 'create', build: 'create', make: 'create', new: 'create', init: 'create',
  construct: 'create', generate: 'create', render: 'create', compose: 'create',
  setup: 'create', spawn: 'create', clone: 'create', collect: 'create',
  gather: 'create', accumulate: 'create', aggregate: 'create', assemble: 'create',

  parse: 'transform', format: 'transform', convert: 'transform', map: 'transform',
  serialize: 'transform', serialise: 'transform', deserialize: 'transform',
  deserialise: 'transform', encode: 'transform', decode: 'transform',
  normalize: 'transform', normalise: 'transform', transform: 'transform',
  to: 'transform', from: 'transform', stringify: 'transform', extract: 'transform',
  filter: 'transform', sort: 'transform', merge: 'transform', split: 'transform',
  summarize: 'transform', summarise: 'transform', flatten: 'transform',
  group: 'transform', reduce: 'transform', join: 'transform', wrap: 'transform',

  calculate: 'compute', compute: 'compute', count: 'compute', sum: 'compute',
  total: 'compute', average: 'compute', measure: 'compute', score: 'compute',
  rank: 'compute', diff: 'compute', compare: 'compute',

  validate: 'validate', check: 'validate', verify: 'validate', ensure: 'validate',
  assert: 'validate', require: 'validate', guard: 'validate', sanitize: 'validate',
  sanitise: 'validate',

  is: 'predicate', has: 'predicate', can: 'predicate', should: 'predicate',
  contains: 'predicate', matches: 'predicate', equals: 'predicate', exists: 'predicate',
  supports: 'predicate', allows: 'predicate', needs: 'predicate',

  set: 'mutate', add: 'mutate', append: 'mutate', push: 'mutate', insert: 'mutate',
  update: 'mutate', save: 'mutate', store: 'mutate', write: 'mutate', persist: 'mutate',
  delete: 'mutate', remove: 'mutate', clear: 'mutate', reset: 'mutate', apply: 'mutate',
  register: 'mutate', dispose: 'mutate', close: 'mutate', send: 'mutate', emit: 'mutate',
  publish: 'mutate', sync: 'mutate', refresh: 'mutate', install: 'mutate',

  handle: 'handle', on: 'handle', process: 'handle', dispatch: 'handle',
  run: 'handle', execute: 'handle', start: 'handle', main: 'handle',
};

/**
 * Read a function name as a verb applied to a subject.
 *
 *   fetchUserOrders   → { kind: 'fetch',     goal: 'fetch user orders' }
 *   isEligible        → { kind: 'predicate', goal: 'decide whether something is eligible' }
 *   toSnakeCase       → { kind: 'transform', goal: 'convert to snake case' }
 */
export function classifyName(name: string): { kind: GoalKind; goal: string; subject: string } {
  const words = splitIdentifier(name);
  if (!words.length) { return { kind: 'unknown', goal: '', subject: '' }; }

  if (/^(test|it|should|spec)$/.test(words[0]) || /(test|spec)$/.test(words[words.length - 1])) {
    return { kind: 'test', goal: `test ${words.slice(1).join(' ')}`.trim(), subject: words.slice(1).join(' ') };
  }

  const verb = words[0];
  const kind = VERB_KINDS[verb] ?? 'unknown';
  const subject = words.slice(1).join(' ');

  if (kind === 'predicate') {
    return { kind, goal: `decide whether something ${verb} ${subject}`.trim(), subject };
  }
  if (kind === 'unknown') {
    return { kind, goal: words.join(' '), subject: words.slice(1).join(' ') || words.join(' ') };
  }
  return { kind, goal: `${verb} ${subject}`.trim(), subject };
}

// ─── Reading the body so far ──────────────────────────────────────────────────

function safeLine(doc: DocLike, line: number): string {
  if (line < 0 || line >= doc.lineCount) { return ''; }
  try { return doc.lineAt(line).text; } catch { return ''; }
}

function indentWidth(text: string): number {
  const m = text.match(/^[ \t]*/);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

/** The body text between the enclosing header and the cursor, literals blanked. */
function bodyText(doc: DocLike, fromLine: number, toLine: number, lang: string): string {
  const parts: string[] = [];
  for (let i = Math.max(0, fromLine); i <= Math.min(toLine, doc.lineCount - 1); i++) {
    parts.push(stripLiterals(safeLine(doc, i), lang));
  }
  return parts.join('\n');
}

function referenceCount(body: string, name: string): number {
  if (!name) { return 0; }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (body.match(new RegExp(`\\b${escaped}\\b`, 'g')) ?? []).length;
}

/** `if (…) return` / `throw` written before any real work — the guard chain. */
function countGuards(doc: DocLike, fromLine: number, toLine: number, lang: string): number {
  let guards = 0;
  for (let i = fromLine; i <= toLine && i < doc.lineCount; i++) {
    const text = stripLiterals(safeLine(doc, i), lang).trim();
    if (!text) { continue; }
    if (/^(if|unless)\b.*\b(return|throw|raise|panic!?|continue)\b/.test(text)) { guards++; continue; }
    if (/^(if|unless)\b/.test(text) && /^\s*(return|throw|raise)\b/.test(stripLiterals(safeLine(doc, i + 1), lang))) {
      guards++; continue;
    }
    // The first statement that is not a guard ends the chain.
    if (!/^[})\]]/.test(text)) { break; }
  }
  return guards;
}
