/**
 * languageProfiles.ts
 *
 * One place where every language-specific shape the completion pipeline needs to
 * recognise is written down: how a loop names the thing it iterates, how a local
 * is declared, what an "empty" initialiser looks like, which types mean "returns
 * nothing", and which words open a block without declaring anything.
 *
 * The pattern lists are ordered and global rather than partitioned per language.
 * The syntaxes are distinct enough that `for _, x := range xs` cannot be mistaken
 * for `foreach ($xs as $x)`, and a single ordered list is far easier to keep
 * correct than sixteen near-duplicate tables. Only the handful of facts that
 * genuinely vary by language — comment markers, block style, void spellings —
 * are keyed by language id.
 */

// ─── Language identity ────────────────────────────────────────────────────────

/** How a language delimits a block, which decides what "opens" one. */
export type BlockStyle = 'brace' | 'indent' | 'end';

const INDENT_LANGS = new Set(['python', 'yaml', 'coffeescript', 'nim']);
const END_LANGS    = new Set(['ruby', 'lua', 'elixir', 'crystal']);

export function blockStyleFor(language: string): BlockStyle {
  if (INDENT_LANGS.has(language)) { return 'indent'; }
  if (END_LANGS.has(language))    { return 'end'; }
  return 'brace';
}

/** Line-comment markers, longest first so `///` is stripped before `//`. */
const LINE_COMMENTS: Record<string, string[]> = {
  python: ['#'], ruby: ['#'], perl: ['#'], r: ['#'], shellscript: ['#'],
  yaml: ['#'], elixir: ['#'], crystal: ['#'], nim: ['#'],
  lua: ['--'], sql: ['--'], haskell: ['--'],
  rust: ['///', '//!', '//'],
  php: ['//', '#'],
};

export function lineCommentsFor(language: string): string[] {
  return LINE_COMMENTS[language] ?? ['//'];
}

/**
 * Words that open a block but declare nothing. Without this a scope scan reads
 * `foreach ($users as $user) {` as a function named `foreach`, and every
 * signature downstream is wrong.
 */
const CONTROL_KEYWORDS = new Set([
  'if', 'elif', 'elsif', 'else', 'unless', 'for', 'foreach', 'while', 'do', 'loop',
  'switch', 'match', 'when', 'case', 'select', 'try', 'begin', 'catch', 'except',
  'rescue', 'finally', 'ensure', 'with', 'using', 'guard', 'defer', 'go', 'return',
  'yield', 'throw', 'raise', 'await', 'in', 'of', 'repeat', 'until',
]);

export function isControlKeyword(word: string): boolean {
  return CONTROL_KEYWORDS.has(word);
}

/**
 * True when a line is a control-flow header rather than a declaration, allowing
 * for a closing brace sharing the line (`} else if (x) {`).
 */
export function isControlLine(trimmed: string): boolean {
  const head = trimmed.replace(/^\}\s*/, '').match(/^([A-Za-z_][\w]*)/);
  return head ? isControlKeyword(head[1]) : false;
}

// ─── Loops ────────────────────────────────────────────────────────────────────

export interface LoopMatch {
  /** The per-item variable, or '' for a counter loop with none. */
  binding: string;
  /** The collection being walked, or '' when the loop is not over one. */
  iterable: string;
}

interface LoopForm { re: RegExp; binding: number; iterable: number; }

/**
 * Ordered by specificity. Go's two-value range has to be tried before its
 * one-value form, and both before the generic `for x in xs`.
 */
const LOOP_FORMS: LoopForm[] = [
  // Go:  for i, user := range users        for user := range users
  { re: /^for\s+[\w_]+\s*,\s*([A-Za-z_]\w*)\s*:=\s*range\s+([\w.$]+)/,     binding: 1, iterable: 2 },
  { re: /^for\s+([A-Za-z_]\w*)\s*:=\s*range\s+([\w.$]+)/,                  binding: 1, iterable: 2 },
  // C#:  foreach (var user in users)
  { re: /^foreach\s*\(\s*(?:[\w<>\[\],.?]+\s+)?([A-Za-z_$]\w*)\s+in\s+([\w.$]+(?:\([^)]*\))?)/, binding: 1, iterable: 2 },
  // PHP: foreach ($users as $key => $user)    foreach ($users as $user)
  { re: /^foreach\s*\(\s*([\w$.>\-]+)\s+as\s+\$\w+\s*=>\s*(\$\w+)/,        binding: 2, iterable: 1 },
  { re: /^foreach\s*\(\s*([\w$.>\-]+)\s+as\s+(\$\w+)/,                     binding: 2, iterable: 1 },
  // JS/TS: for (const user of users)          for (const k in obj)
  { re: /^for\s*(?:await\s*)?\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\s+([\w.$]+(?:\([^)]*\))?)/, binding: 1, iterable: 2 },
  // Java / C++: for (User user : users)       for (const auto& user : users)
  { re: /^for\s*\(\s*(?:const\s+)?(?:[\w:<>\[\],.*&\s]+?)[\s&*]+([A-Za-z_$]\w*)\s*:\s*([\w.$]+(?:\([^)]*\))?)/, binding: 1, iterable: 2 },
  // Scala: for (user <- users)
  { re: /^for\s*[({]\s*([A-Za-z_$]\w*)\s*<-\s*([\w.$]+(?:\([^)]*\))?)/,                binding: 1, iterable: 2 },
  // Python / Rust / Swift / Kotlin: for user in users
  { re: /^for\s+\(?\s*([A-Za-z_$][\w$]*)\s+in\s+([\w.$&]+(?:\([^)]*\))?)/,             binding: 1, iterable: 2 },
  // Ruby / JS block form: users.each do |user|    users.forEach(user => …)
  { re: /^([\w.$@]+)\s*\.\s*(?:each|each_with_index|map|forEach)\s*(?:do|\{)\s*\|\s*([A-Za-z_$]\w*)/, binding: 2, iterable: 1 },
  { re: /^([\w.$]+)\s*\.\s*(?:forEach|map|filter)\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)/, binding: 2, iterable: 1 },
  // C-style counter: for (let i = 0; i < n; i++)
  { re: /^for\s*\(\s*(?:const|let|var|int|size_t|usize|auto)?\s*([A-Za-z_$][\w$]*)\s*=/, binding: 1, iterable: 0 },
];

/** Reads the per-item variable and the collection out of a loop header. */
export function matchLoop(trimmed: string): LoopMatch | null {
  for (const form of LOOP_FORMS) {
    const m = form.re.exec(trimmed);
    if (!m) { continue; }
    return {
      binding:  form.binding  > 0 ? (m[form.binding]  ?? '') : '',
      iterable: form.iterable > 0 ? (m[form.iterable] ?? '') : '',
    };
  }
  return null;
}

// ─── Local declarations ───────────────────────────────────────────────────────

export interface LocalMatch {
  name: string;
  /** The declared type, or '' when the language does not state one here. */
  type: string;
  /** The initialising expression, or '' for a declaration without one. */
  init: string;
}

interface LocalForm { re: RegExp; name: number; type: number; init: number; }

/**
 * Ordered most specific first. The bare `x = expr` form is last and deliberately
 * narrow: it only fires for a plain identifier, so it catches Python and Ruby
 * locals without swallowing comparisons or member assignments.
 */
const LOCAL_FORMS: LocalForm[] = [
  // Rust: let mut names: Vec<String> = Vec::new();
  { re: /^let\s+mut\s+([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(.+?);?$/,          name: 1, type: 2, init: 3 },
  // JS/TS/Swift/Kotlin/Scala: const names: string[] = []
  { re: /^(?:const|let|var|final|val|auto)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=]+?))?\s*=\s*(.+?);?$/, name: 1, type: 2, init: 3 },
  // Go: names := []string{}
  { re: /^([A-Za-z_]\w*)\s*:=\s*(.+?)$/,                                            name: 1, type: 0, init: 2 },
  // Go: var names []string
  { re: /^var\s+([A-Za-z_]\w*)\s+([\w\[\]{}*.]+)\s*$/,                              name: 1, type: 2, init: 0 },
  // PHP: $names = [];
  { re: /^(\$\w+)\s*=\s*(.+?);?$/,                                                  name: 1, type: 0, init: 2 },
  // Type-first with initialiser: List<String> names = new ArrayList<>();
  { re: /^(?:final\s+)?([A-Z][\w:<>\[\],.]*(?:\s*[*&])?)\s+([A-Za-z_$]\w*)\s*=\s*(.+?);?$/, name: 2, type: 1, init: 3 },
  // Type-first, no initialiser: std::vector<std::string> names;
  { re: /^(?:const\s+)?([a-z_]\w*(?:::[\w<>:,\s]+)+|[A-Z][\w<>\[\],.]*)\s+([A-Za-z_$]\w*)\s*;$/, name: 2, type: 1, init: 0 },
  // Python / Ruby: names = []
  { re: /^([a-z_][\w]*)\s*(?::\s*([^=]+?))?\s*=\s*(?!=)(.+?)$/,                     name: 1, type: 2, init: 3 },
];

/** Reads a local declaration off one trimmed, literal-stripped line. */
export function matchLocal(trimmed: string): LocalMatch | null {
  if (isControlLine(trimmed)) { return null; }
  for (const form of LOCAL_FORMS) {
    const m = form.re.exec(trimmed);
    if (!m) { continue; }
    const name = m[form.name] ?? '';
    if (!name || isControlKeyword(name)) { continue; }
    return {
      name,
      type: (form.type > 0 ? m[form.type] ?? '' : '').trim(),
      init: (form.init > 0 ? m[form.init] ?? '' : '').trim(),
    };
  }
  return null;
}

// ─── Empty initialisers ───────────────────────────────────────────────────────

/**
 * The shapes that mean "nothing in it yet". A local holding one of these just
 * before a loop is an accumulator the loop exists to fill.
 */
const EMPTY_INIT = new RegExp('^(?:' + [
  '\\[\\s*\\]',                                    // []
  '\\{\\s*\\}',                                    // {}
  '0(?:\\.0+)?[uUlLfF]?',                          // 0, 0.0, 0L
  "''|\"\"|``|'''|\"\"\"",                         // empty strings
  'new\\s+\\w+(?:<[^>]*>)?\\s*\\(\\s*\\)',         // new ArrayList<>(), new Map()
  '\\w+(?:<[^>]*>)?::new\\(\\)',                   // Vec::new(), String::new()
  'vec!\\[\\s*\\]',                                // vec![]
  'make\\([^)]*\\)',                               // make(map[string]int)
  '\\[\\][\\w.]+\\{\\s*\\}',                       // []string{}
  'map\\[[^\\]]*\\][\\w.]+\\{\\s*\\}',             // map[string]int{}
  '(?:mutableListOf|mutableSetOf|mutableMapOf|listOf|arrayListOf|emptyList|emptyMap)\\s*(?:<[^>]*>)?\\s*\\(\\s*\\)',
  '(?:ListBuffer|ArrayBuffer|Buffer|Set|Map|List|Seq)\\s*\\[[^\\]]*\\]\\s*\\(\\s*\\)',
  '(?:list|dict|set|tuple|str|int|float|bytearray)\\(\\s*\\)',
  'array\\(\\s*\\)',                               // PHP array()
  'StringBuilder\\s*\\(\\s*\\)|StringBuffer\\s*\\(\\s*\\)',
  '\\$?\\{\\s*\\}',
  'nil|None|null|undefined',
].join('|') + ')\\s*$');

/**
 * A type-first declaration with no initialiser (`std::vector<std::string> names;`)
 * is empty by construction — C++ and Java default-construct it.
 */
export function isEmptyInitialiser(init: string, declaredType = ''): boolean {
  const text = init.trim().replace(/[;,]+$/, '').trim();
  if (!text) { return declaredType.trim().length > 0; }
  // A fully-qualified constructor names the same empty collection as its bare
  // form: `scala.collection.mutable.ListBuffer[String]()`. Only lowercase
  // package segments are dropped, so a method call on a value is left alone.
  const unqualified = text.replace(/^(?:[a-z]\w*\.)+/, '');
  return EMPTY_INIT.test(text) || EMPTY_INIT.test(unqualified);
}

// ─── Types that mean "returns nothing" ────────────────────────────────────────

const VOID_TYPES = new Set([
  'void', 'none', 'unit', '()', 'undefined', 'never', 'nothing', 'nil', '',
]);

/** Unwraps one async wrapper before deciding, so `Promise<void>` is still void. */
export function isVoidType(type: string): boolean {
  const bare = type.trim()
    .replace(/^(?:Promise|Future|Task|Awaitable|Deferred)\s*<\s*([\s\S]*)>$/, '$1')
    .trim()
    .toLowerCase();
  return VOID_TYPES.has(bare);
}
