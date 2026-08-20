/**
 * signatureExtractor.ts
 *
 * Pure (no VS Code API beyond TextDocument shape) extraction of the *logical*
 * context surrounding the cursor:
 *
 *   • the enclosing function / method signature — name, parameters WITH types,
 *     return type, modifiers, generics, throws clause
 *   • the enclosing type (class / struct / interface / impl / trait)
 *   • every binding visible at the cursor (parameters, locals, fields, loop
 *     variables, catch bindings) together with its declared or inferred type
 *   • the `return` statements already present in the body, used to infer the
 *     return type when the language allows it to be omitted
 *
 * This is the fallback/always-on layer. `semanticContext.ts` layers the real
 * language server on top when one is installed; this module keeps working when
 * one is not.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParamInfo {
  name: string;
  type: string;          // '' when the language / call site gives no type
  optional: boolean;
  defaultValue?: string;
  rest: boolean;         // ...args / *args / params T[]
}

export type ScopeKind =
  | 'function' | 'method' | 'constructor' | 'getter' | 'setter' | 'lambda'
  | 'class' | 'interface' | 'struct' | 'enum' | 'impl' | 'trait' | 'namespace'
  | 'block' | 'unknown';

export interface ScopeFrame {
  kind: ScopeKind;
  name: string;
  /** Full header text, joined onto one line when it wrapped */
  header: string;
  line: number;
  indent: string;
}

export interface EnclosingSignature {
  kind: ScopeKind;
  name: string;
  params: ParamInfo[];
  returnType: string;
  generics: string;
  isAsync: boolean;
  isStatic: boolean;
  visibility: string;
  throws: string;
  header: string;
  line: number;
}

export interface Binding {
  name: string;
  /** The DECLARED type — an annotation, or the class of a `new` expression.
   *  Never a guess: an unannotated binding reports '' rather than something
   *  that merely looks type-shaped. */
  type: string;
  /** The initialising expression, when there is no declared type. Shown to the
   *  model as provenance ("order comes from this.repo.findById(...)") without
   *  ever being passed off as a type. */
  init?: string;
  source: 'param' | 'local' | 'field' | 'loop' | 'catch' | 'import' | 'self';
  line: number;
}

export interface SurroundingContext {
  language: string;
  /** Innermost function-like scope, or null at top level / inside a type body */
  enclosing: EnclosingSignature | null;
  /** Innermost type-like scope (class/struct/interface/impl/trait), or null */
  container: ScopeFrame | null;
  /** Full innermost-first scope chain */
  scopeChain: ScopeFrame[];
  /** Everything nameable at the cursor, innermost declarations last */
  bindings: Binding[];
  /** `return <expr>` expressions already written in the enclosing body */
  returnExpressions: string[];
  /** Members accessed through this/self inside the enclosing body */
  memberAccesses: string[];
  /** Identifiers referenced but never bound locally — likely imports/globals */
  freeIdentifiers: string[];
}

// ─── Minimal document shape ───────────────────────────────────────────────────

export interface DocLike {
  languageId: string;
  lineCount: number;
  lineAt(line: number): { text: string };
}

export interface PosLike { line: number; character: number; }

// ─── Language classification ──────────────────────────────────────────────────

const INDENT_LANGS = new Set(['python', 'yaml', 'coffeescript', 'nim']);
const END_LANGS    = new Set(['ruby', 'lua', 'elixir']);

/** Languages where the return type is written before the name (`int foo()`). */
const PREFIX_RETURN_LANGS = new Set([
  'java', 'csharp', 'c', 'cpp', 'objective-c', 'objective-cpp', 'groovy',
]);

function isIndentLang(lang: string): boolean { return INDENT_LANGS.has(lang); }
function isEndLang(lang: string): boolean { return END_LANGS.has(lang); }

// ─── Comment / string aware line stripping ────────────────────────────────────

/**
 * Remove string literals and comments from a line so brace counting and
 * pattern matching are not confused by `"{"` or `// }`.
 * Returns the line with those regions replaced by spaces (length preserved).
 */
export function stripLiterals(line: string, lang = 'typescript'): string {
  const out = line.split('');
  let i = 0;
  const hashComment = lang === 'python' || lang === 'ruby' || lang === 'shellscript'
    || lang === 'perl' || lang === 'r' || lang === 'yaml' || lang === 'toml';

  while (i < line.length) {
    const ch = line[i];
    // Line comments
    if (ch === '/' && line[i + 1] === '/') { for (let j = i; j < line.length; j++) { out[j] = ' '; } break; }
    if (ch === '#' && hashComment)          { for (let j = i; j < line.length; j++) { out[j] = ' '; } break; }
    if (ch === '-' && line[i + 1] === '-' && (lang === 'sql' || lang === 'lua' || lang === 'haskell')) {
      for (let j = i; j < line.length; j++) { out[j] = ' '; } break;
    }
    // Block comment (single-line portion only — multi-line handled by caller)
    if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      const end = close === -1 ? line.length : close + 2;
      for (let j = i; j < end; j++) { out[j] = ' '; }
      i = end;
      continue;
    }
    // Strings
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out[i] = ' ';
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (line[i] === quote) { out[i] = ' '; i++; break; }
        out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

// ─── Balanced-group helpers ───────────────────────────────────────────────────

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/**
 * Split a parameter list on top-level separators, ignoring separators nested
 * inside brackets, generics or string literals.
 */
export function splitTopLevel(text: string, sep = ','): string[] {
  const parts: string[] = [];
  let depthRound = 0, depthSquare = 0, depthCurly = 0, depthAngle = 0;
  let quote: string | null = null;
  let buf = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') { buf += text[i + 1] ?? ''; i++; }
      else if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; buf += ch; continue; }

    if (ch === '(') { depthRound++; }
    else if (ch === ')') { depthRound--; }
    else if (ch === '[') { depthSquare++; }
    else if (ch === ']') { depthSquare--; }
    else if (ch === '{') { depthCurly++; }
    else if (ch === '}') { depthCurly--; }
    // Only treat < > as generics when they look like generics (not comparisons)
    else if (ch === '<' && /[\w>\]]\s*$/.test(buf)) { depthAngle++; }
    else if (ch === '>' && depthAngle > 0 && text[i - 1] !== '=' && text[i + 1] !== '=') { depthAngle--; }

    const atTop = depthRound === 0 && depthSquare === 0 && depthCurly === 0 && depthAngle === 0;
    if (ch === sep && atTop) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim().length > 0) { parts.push(buf); }
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Given text and the index of an opening bracket, return the index of its
 * matching close, or -1. Quote-aware.
 */
export function matchBracket(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = OPEN[open];
  if (!close) { return -1; }
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; }
      else if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === open) { depth++; }
    else if (ch === close) { depth--; if (depth === 0) { return i; } }
  }
  return -1;
}

// ─── Header patterns per language ─────────────────────────────────────────────

/** Does this (literal-stripped, trimmed) line start a function-like scope? */
function functionHeaderKind(trimmed: string, lang: string): ScopeKind | null {
  if (!trimmed) { return null; }

  switch (lang) {
    case 'python':
      if (/^(async\s+)?def\s+\w+\s*\(/.test(trimmed)) {
        return /^\s*def\s+__init__\b/.test(trimmed) ? 'constructor' : 'function';
      }
      return null;

    case 'ruby':
      if (/^def\s+\w+[?!]?/.test(trimmed)) { return /^def\s+initialize\b/.test(trimmed) ? 'constructor' : 'function'; }
      return null;

    case 'rust':
      if (/^(pub(\([^)]*\))?\s+)?(const\s+|unsafe\s+|extern\s+"[^"]*"\s+)*(async\s+)?fn\s+\w+/.test(trimmed)) { return 'function'; }
      return null;

    case 'go':
      if (/^func\s*(\([^)]*\)\s*)?\w*\s*\(/.test(trimmed)) { return 'function'; }
      return null;

    case 'java':
    case 'csharp':
    case 'kotlin':
    case 'scala':
    case 'swift':
    case 'dart':
    case 'php':
    case 'groovy':
    case 'c':
    case 'cpp':
    case 'objective-c':
      break;

    default:
      break;
  }

  // Accessors first — `get x()` / `set x(v)` (TS/JS/C#/Swift/Kotlin)
  if (/^(public\s+|private\s+|protected\s+|internal\s+|static\s+|override\s+)*get\s+\w+\s*\(/.test(trimmed)) { return 'getter'; }
  if (/^(public\s+|private\s+|protected\s+|internal\s+|static\s+|override\s+)*set\s+\w+\s*\(/.test(trimmed)) { return 'setter'; }

  // Explicit constructors
  if (/^(public\s+|private\s+|protected\s+)?constructor\s*\(/.test(trimmed)) { return 'constructor'; }
  if (lang === 'kotlin' && /^(init\b|constructor\s*\()/.test(trimmed)) { return 'constructor'; }
  if (lang === 'swift' && /^(public\s+|private\s+|internal\s+|required\s+|convenience\s+|override\s+)*init\s*\(/.test(trimmed)) { return 'constructor'; }
  if (lang === 'php' && /function\s+__construct\s*\(/.test(trimmed)) { return 'constructor'; }
  if (lang === 'dart' && /^[A-Z]\w*\s*\(/.test(trimmed)) { return 'constructor'; }

  // `function name(` / `fun name(` / `func name(` / `def name(` / `sub name(`
  if (/^(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|open\s+|override\s+|suspend\s+|inline\s+|operator\s+|external\s+)*(async\s+)?(function|fun|func|def|sub)\s+\w+/.test(trimmed)) {
    return 'function';
  }

  // Arrow / lambda assigned to a name: `const f = (a: T): R => {`
  if (/^(export\s+)?(const|let|var|val)\s+\w+\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)|\w+)\s*(:\s*[^=]+)?=>/.test(trimmed)) {
    return 'lambda';
  }

  // Java / C# / C / C++ / Swift / Kotlin / Dart style member methods:
  //   [modifiers] [returnType] name(params) [throws X] {
  if (PREFIX_RETURN_LANGS.has(lang) || lang === 'swift' || lang === 'kotlin' || lang === 'dart' || lang === 'scala' || lang === 'php') {
    if (/^(@\w+(\([^)]*\))?\s+)*(public|private|protected|internal|static|final|abstract|virtual|override|sealed|async|synchronized|native|extern|inline|const|constexpr|explicit|unsafe|partial|open|suspend|operator|lazy|mutating|nonisolated|late)?[\w\s<>\[\],.?*&:]*\s+\**\w+\s*\(/.test(trimmed)
        && !/^(if|for|while|switch|catch|return|else|do|foreach|using|lock|match|when|with|assert|throw|new|case)\b/.test(trimmed)) {
      return 'method';
    }
  }

  // TS/JS class member shorthand: `name(a: T): R {`
  if (/^(public\s+|private\s+|protected\s+|readonly\s+|static\s+|abstract\s+|override\s+|async\s+)*\**\w+\s*(<[^>]*>)?\s*\(/.test(trimmed)
      && !/^(if|for|while|switch|catch|return|else|do|typeof|new|await|throw|case|super)\b/.test(trimmed)) {
    return 'method';
  }

  return null;
}

/** Does this line start a type-like scope? */
function typeHeaderKind(trimmed: string, lang: string): ScopeKind | null {
  if (!trimmed) { return null; }
  if (/^(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|internal\s+|abstract\s+|final\s+|sealed\s+|static\s+|partial\s+|open\s+|data\s+|case\s+)*class\s+\w+/.test(trimmed)) { return 'class'; }
  if (/^(export\s+)?(public\s+|internal\s+)?interface\s+\w+/.test(trimmed)) { return 'interface'; }
  if (/^(export\s+)?(pub(\([^)]*\))?\s+)?(public\s+|internal\s+)?struct\s+\w+/.test(trimmed)) { return 'struct'; }
  if (/^(export\s+)?(pub(\([^)]*\))?\s+)?(public\s+|internal\s+)?enum(\s+class)?\s+\w+/.test(trimmed)) { return 'enum'; }
  if (/^(pub(\([^)]*\))?\s+)?impl(\s*<[^>]*>)?\s+/.test(trimmed) && lang === 'rust') { return 'impl'; }
  if (/^(pub(\([^)]*\))?\s+)?trait\s+\w+/.test(trimmed)) { return 'trait'; }
  if (/^(export\s+)?(namespace|module)\s+[\w.]+/.test(trimmed)) { return 'namespace'; }
  if (lang === 'swift' && /^(public\s+|private\s+|internal\s+|open\s+)?(protocol|extension)\s+\w+/.test(trimmed)) { return 'interface'; }
  if (lang === 'go' && /^type\s+\w+\s+(struct|interface)\b/.test(trimmed)) {
    return /interface/.test(trimmed) ? 'interface' : 'struct';
  }
  if (lang === 'kotlin' && /^(public\s+|private\s+|internal\s+|open\s+|sealed\s+|data\s+|abstract\s+)*object\s+\w+/.test(trimmed)) { return 'class'; }
  if (lang === 'scala' && /^(case\s+)?(class|object|trait)\s+\w+/.test(trimmed)) { return 'class'; }
  if (lang === 'ruby' && /^(class|module)\s+\w+/.test(trimmed)) { return 'class'; }
  return null;
}

/** Extract a declaration name from a header line. */
function headerName(trimmed: string, kind: ScopeKind, lang: string): string {
  if (kind === 'constructor') {
    if (lang === 'python') { return '__init__'; }
    if (lang === 'ruby') { return 'initialize'; }
    if (lang === 'php') { return '__construct'; }
    const dm = trimmed.match(/^([A-Z]\w*)\s*\(/);
    if (dm) { return dm[1]; }
    return trimmed.match(/\b(constructor|init)\b/)?.[1] ?? 'constructor';
  }
  if (kind === 'getter' || kind === 'setter') {
    return trimmed.match(/\b(?:get|set)\s+(\w+)/)?.[1] ?? '';
  }
  if (kind === 'lambda') {
    return trimmed.match(/\b(?:const|let|var|val)\s+(\w+)/)?.[1] ?? '';
  }
  if (kind === 'class' || kind === 'interface' || kind === 'struct'
      || kind === 'enum' || kind === 'trait' || kind === 'namespace') {
    return trimmed.match(/\b(?:class|interface|struct|enum|trait|namespace|module|object|protocol|extension|type)\s+(\w+)/)?.[1] ?? '';
  }
  if (kind === 'impl') {
    const m = trimmed.match(/impl(?:\s*<[^>]*>)?\s+(?:([\w:]+)\s+for\s+)?([\w:]+)/);
    return m ? (m[2] ?? m[1] ?? 'Self') : 'Self';
  }
  // function / method
  const kw = trimmed.match(/\b(?:function|fun|func|def|fn|sub)\s+(\w+)/);
  if (kw) { return kw[1]; }
  // last identifier before the parameter list
  const paren = trimmed.indexOf('(');
  if (paren > 0) {
    const before = trimmed.slice(0, paren).replace(/<[^>]*>\s*$/, '').trimEnd();
    const id = before.match(/([A-Za-z_$][\w$]*)\s*$/);
    if (id) { return id[1]; }
  }
  return '';
}

// ─── Header joining ───────────────────────────────────────────────────────────

/**
 * A signature may wrap across lines. Starting at `line`, join forward until the
 * parameter list is balanced and we have hit the body opener (`{`, `:`, `=>`).
 */
function joinHeader(doc: DocLike, line: number, lang: string, maxLines = 8): string {
  let joined = '';
  for (let i = line; i < Math.min(doc.lineCount, line + maxLines); i++) {
    let text = '';
    try { text = doc.lineAt(i).text; } catch { break; }
    joined += (joined ? ' ' : '') + text.trim();
    const stripped = stripLiterals(joined, lang);
    const open = (stripped.match(/\(/g) ?? []).length;
    const close = (stripped.match(/\)/g) ?? []).length;
    if (open === 0) {
      // Headers without a param list (e.g. `class Foo extends Bar {`)
      if (/[{:]\s*$/.test(stripped) || i > line) { break; }
      break;
    }
    if (open <= close) {
      // Params balanced — grab a trailing return-type / body opener if present
      if (/[{:]\s*$/.test(stripped) || /=>\s*\{?\s*$/.test(stripped)
          || /\b(throws|where)\b/.test(stripped) || i === line) { break; }
      break;
    }
  }
  return joined.replace(/\s+/g, ' ').trim();
}

// ─── Parameter parsing ────────────────────────────────────────────────────────

/** Pull the balanced parameter-list source out of a joined header. */
export function extractParamSource(header: string): string {
  // Skip a generics group that precedes the params: `foo<T>(a: T)`
  let idx = -1;
  let depthAngle = 0;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === '<' && /[\w>\]]\s*$/.test(header.slice(0, i))) { depthAngle++; }
    else if (ch === '>' && depthAngle > 0) { depthAngle--; }
    else if (ch === '(' && depthAngle === 0) { idx = i; break; }
  }
  if (idx === -1) { return ''; }
  const close = matchBracket(header, idx);
  if (close === -1) { return header.slice(idx + 1); }
  return header.slice(idx + 1, close);
}

function parseTypedColonParam(raw: string): ParamInfo {
  // `public readonly name?: Type = default`  /  `...rest: T[]`  /  `mut x: i32`
  let s = raw.trim();
  const rest = /^(\.\.\.|\*\*?)/.test(s);
  s = s.replace(/^(\.\.\.|\*\*?)/, '').trim();
  s = s.replace(/^(public|private|protected|readonly|mut|ref|inout|out|in|val|var|let|final|const|@\w+)\s+/g, '').trim();

  let defaultValue: string | undefined;
  const eq = findTopLevelAssign(s);
  if (eq !== -1) {
    defaultValue = s.slice(eq + 1).trim();
    s = s.slice(0, eq).trim();
  }

  const optional = /\?\s*:/.test(s) || /\?$/.test(s) || defaultValue !== undefined;
  const colon = findTopLevelColon(s);
  if (colon === -1) {
    return { name: s.replace(/[?!]$/, '').trim(), type: '', optional, defaultValue, rest };
  }
  return {
    name: s.slice(0, colon).replace(/[?!]\s*$/, '').trim(),
    type: s.slice(colon + 1).trim(),
    optional,
    defaultValue,
    rest,
  };
}

function parsePrefixTypeParam(raw: string): ParamInfo {
  // `final Map<String,Int> name` / `int... nums` / `out string s` / `const char *p`
  let s = raw.trim().replace(/^(@\w+(\([^)]*\))?\s+)+/, '');
  s = s.replace(/^(final|const|volatile|static|out|ref|in|params|this|readonly|unsafe)\s+/g, '').trim();

  let defaultValue: string | undefined;
  const eq = findTopLevelAssign(s);
  if (eq !== -1) { defaultValue = s.slice(eq + 1).trim(); s = s.slice(0, eq).trim(); }

  const rest = /\.\.\./.test(s);
  s = s.replace(/\.\.\./g, ' ').trim();

  const m = s.match(/^(.*?[\w>\]\*&])\s+\**(\w+)(\s*\[\s*\])?$/);
  if (!m) {
    // Bare `Type` (C-style unnamed) or bare `name`
    return { name: s, type: '', optional: defaultValue !== undefined, defaultValue, rest };
  }
  let type = m[1].trim();
  if (m[3]) { type += '[]'; }
  return { name: m[2], type, optional: defaultValue !== undefined, defaultValue, rest };
}

function parseGoParams(src: string): ParamInfo[] {
  // Go groups names: `a, b int, c string`. Walk right-to-left assigning types.
  const parts = splitTopLevel(src);
  const out: ParamInfo[] = [];
  const pending: string[] = [];
  for (const part of parts) {
    const m = part.trim().match(/^(\.\.\.)?\s*(\w+)\s+(\.\.\.)?(.+)$/);
    if (m) {
      const type = (m[3] ? '...' : '') + m[4].trim();
      for (const p of pending) { out.push({ name: p, type, optional: false, rest: false }); }
      pending.length = 0;
      out.push({ name: m[2], type, optional: false, rest: !!(m[1] || m[3]) });
    } else {
      pending.push(part.trim());
    }
  }
  // Leftovers are unnamed types
  for (const p of pending) { out.push({ name: '', type: p, optional: false, rest: false }); }
  return out;
}

function findTopLevelColon(s: string): number {
  let dr = 0, ds = 0, dc = 0, da = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') { i++; } else if (ch === quote) { quote = null; } continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') { dr++; } else if (ch === ')') { dr--; }
    else if (ch === '[') { ds++; } else if (ch === ']') { ds--; }
    else if (ch === '{') { dc++; } else if (ch === '}') { dc--; }
    else if (ch === '<' && /[\w>\]]$/.test(s.slice(0, i))) { da++; }
    else if (ch === '>' && da > 0) { da--; }
    else if (ch === ':' && dr === 0 && ds === 0 && dc === 0 && da === 0 && s[i + 1] !== ':' && s[i - 1] !== ':') { return i; }
  }
  return -1;
}

function findTopLevelAssign(s: string): number {
  let dr = 0, ds = 0, dc = 0, da = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') { i++; } else if (ch === quote) { quote = null; } continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') { dr++; } else if (ch === ')') { dr--; }
    else if (ch === '[') { ds++; } else if (ch === ']') { ds--; }
    else if (ch === '{') { dc++; } else if (ch === '}') { dc--; }
    else if (ch === '<' && /[\w>\]]$/.test(s.slice(0, i))) { da++; }
    else if (ch === '>' && da > 0) { da--; }
    else if (ch === '=' && dr === 0 && ds === 0 && dc === 0 && da === 0
             && s[i + 1] !== '=' && s[i + 1] !== '>' && !/[=!<>+\-*/%&|^]/.test(s[i - 1] ?? '')) { return i; }
  }
  return -1;
}

/** Parse a parameter list source string into typed parameters. */
export function parseParams(src: string, lang: string): ParamInfo[] {
  const trimmed = src.trim();
  if (!trimmed) { return []; }
  if (lang === 'go') { return parseGoParams(trimmed); }

  const parts = splitTopLevel(trimmed);
  const colonStyle = !PREFIX_RETURN_LANGS.has(lang);

  return parts.map(part => {
    // Rust receivers, Python/Ruby self
    if (/^&?\s*(mut\s+)?self$/.test(part) || part === 'cls' || part === 'this') {
      return { name: part.replace(/^&\s*/, '').replace(/^mut\s+/, ''), type: 'Self', optional: false, rest: false };
    }
    if (colonStyle && findTopLevelColon(part) !== -1) { return parseTypedColonParam(part); }
    if (colonStyle && !PREFIX_RETURN_LANGS.has(lang)) {
      // TS/JS/Python untyped param, or destructured `{ a, b }`
      return parseTypedColonParam(part);
    }
    return parsePrefixTypeParam(part);
  });
}

// ─── Return type extraction ───────────────────────────────────────────────────

export function extractReturnType(header: string, lang: string): string {
  const paramOpen = header.indexOf('(');
  const paramClose = paramOpen >= 0 ? matchBracket(header, paramOpen) : -1;
  const after = paramClose >= 0 ? header.slice(paramClose + 1) : '';

  // Arrow style: `-> T` (Rust, Python, PHP, C++ trailing, Kotlin lambda)
  const arrow = after.match(/->\s*([^{;=]+?)\s*(\{|$|where\b)/);
  if (arrow) {
    // Indentation languages end the header with `:` — that is the block
    // opener, not part of the type.
    return arrow[1].replace(/:\s*$/, '').trim();
  }

  // Colon style: `: T` (TS, Swift, Kotlin, Scala, Dart named)
  if (!isIndentLang(lang)) {
    const colonIdx = findTopLevelColon(after);
    if (colonIdx !== -1) {
      const rest = after.slice(colonIdx + 1);
      const stop = rest.search(/[{=]|\bwhere\b|\bthrows\b/);
      return (stop === -1 ? rest : rest.slice(0, stop)).trim();
    }
  }

  // Go: `func f(a int) (string, error) {`  or  `func f() error {`
  if (lang === 'go') {
    const m = after.match(/^\s*(\([^)]*\)|[\w\[\]\*\.]+)\s*\{?\s*$/);
    if (m) { return m[1].trim(); }
    return '';
  }

  // Prefix style: the type sits between the modifiers and the name
  if (PREFIX_RETURN_LANGS.has(lang) && paramOpen > 0) {
    let before = header.slice(0, paramOpen).replace(/<[^>]*>\s*$/, '').trim();
    before = before.replace(/^(@\w+(\([^)]*\))?\s+)+/, '');
    const tokens = before.split(/\s+/);
    tokens.pop(); // the method name
    const modifiers = new Set([
      'public', 'private', 'protected', 'internal', 'static', 'final', 'abstract',
      'virtual', 'override', 'sealed', 'async', 'synchronized', 'native', 'default',
      'extern', 'inline', 'constexpr', 'explicit', 'unsafe', 'partial', 'new', 'const',
      'transient', 'volatile', 'strictfp', 'friend', 'mutable',
    ]);
    const type = tokens.filter(t => t && !modifiers.has(t)).join(' ');
    return type.trim();
  }

  // Dart: `Future<void> foo() async {`
  if (lang === 'dart' && paramOpen > 0) {
    const before = header.slice(0, paramOpen).trim().split(/\s+/);
    before.pop();
    return before.filter(t => !/^(static|final|const|external|abstract|covariant|@\w+)$/.test(t)).join(' ');
  }

  return '';
}

// ─── Scope chain ──────────────────────────────────────────────────────────────

/** Walk backwards from the cursor collecting the innermost-first scope chain. */
export function buildScopeChain(doc: DocLike, position: PosLike, maxLookback = 400): ScopeFrame[] {
  const lang = doc.languageId;
  const line = Math.max(0, Math.min(position.line, doc.lineCount - 1));
  const frames: ScopeFrame[] = [];

  if (isIndentLang(lang)) {
    // Indentation-based: any header at a strictly smaller indent encloses us.
    const cursorLine = safeLine(doc, line);
    let refIndent = indentWidth(cursorLine.length > 0 && cursorLine.trim().length > 0
      ? cursorLine
      : findPrevNonBlank(doc, line));
    // A blank cursor line inside a body: the cursor column is the real indent
    if (cursorLine.trim().length === 0) { refIndent = Math.max(refIndent, position.character); }

    for (let i = line - 1; i >= Math.max(0, line - maxLookback); i--) {
      const raw = safeLine(doc, i);
      if (!raw.trim()) { continue; }
      const ind = indentWidth(raw);
      if (ind >= refIndent) { continue; }
      const stripped = stripLiterals(raw, lang).trim();
      const fk = functionHeaderKind(stripped, lang);
      const tk = fk ? null : typeHeaderKind(stripped, lang);
      if (fk || tk) {
        frames.push({
          kind: (fk ?? tk)!,
          name: headerName(stripped, (fk ?? tk)!, lang),
          header: joinHeader(doc, i, lang),
          line: i,
          indent: raw.match(/^\s*/)?.[0] ?? '',
        });
      }
      refIndent = ind;
      if (ind === 0) { break; }
    }
    return frames;
  }

  if (isEndLang(lang)) {
    // `def`/`end` languages — count keyword depth.
    let depth = 0;
    for (let i = line - 1; i >= Math.max(0, line - maxLookback); i--) {
      const stripped = stripLiterals(safeLine(doc, i), lang).trim();
      if (!stripped) { continue; }
      if (/^end\b/.test(stripped)) { depth++; continue; }
      const fk = functionHeaderKind(stripped, lang);
      const tk = fk ? null : typeHeaderKind(stripped, lang);
      const opensBlock = fk || tk || /^(if|unless|while|until|for|begin|case|do)\b/.test(stripped);
      if (!opensBlock) { continue; }
      if (depth > 0) { depth--; continue; }
      if (fk || tk) {
        frames.push({
          kind: (fk ?? tk)!,
          name: headerName(stripped, (fk ?? tk)!, lang),
          header: joinHeader(doc, i, lang),
          line: i,
          indent: safeLine(doc, i).match(/^\s*/)?.[0] ?? '',
        });
      }
    }
    return frames;
  }

  // Brace languages: find each unmatched `{` walking backwards.
  let depth = 0;
  for (let i = line - 1; i >= Math.max(0, line - maxLookback); i--) {
    const raw = safeLine(doc, i);
    const stripped = stripLiterals(raw, lang);
    let opensHere = false;
    for (let c = stripped.length - 1; c >= 0; c--) {
      const ch = stripped[c];
      if (ch === '}') { depth++; }
      else if (ch === '{') {
        if (depth === 0) { opensHere = true; }
        else { depth--; }
      }
    }
    if (!opensHere) { continue; }

    // The `{` may belong to a header that started on an earlier line.
    const headerLine = findHeaderStart(doc, i, lang);
    const headerText = joinHeader(doc, headerLine, lang);
    const headerStripped = stripLiterals(headerText, lang).trim();
    const fk = functionHeaderKind(headerStripped, lang);
    const tk = fk ? null : typeHeaderKind(headerStripped, lang);
    const kind: ScopeKind = fk ?? tk ?? 'block';
    frames.push({
      kind,
      name: kind === 'block' ? '' : headerName(headerStripped, kind, lang),
      header: headerText,
      line: headerLine,
      indent: safeLine(doc, headerLine).match(/^\s*/)?.[0] ?? '',
    });
    // Keep looking outward for the enclosing scopes.
  }
  return frames;
}

/** Walk back from a line ending in `{` to the first line of its header. */
function findHeaderStart(doc: DocLike, braceLine: number, lang: string): number {
  let start = braceLine;
  for (let i = braceLine; i > Math.max(0, braceLine - 8); i--) {
    const stripped = stripLiterals(safeLine(doc, i), lang).trim();
    if (!stripped) { break; }
    // If this line's parens are balanced and it looks like a full header, stop.
    const open = (stripped.match(/\(/g) ?? []).length;
    const close = (stripped.match(/\)/g) ?? []).length;
    start = i;
    if (open === close && (functionHeaderKind(stripped, lang) || typeHeaderKind(stripped, lang))) { return i; }
    if (open === close && i < braceLine) { return i; }
    if (/[;{}]\s*$/.test(stripped) && i < braceLine) { return i + 1; }
  }
  return start;
}

function safeLine(doc: DocLike, i: number): string {
  if (i < 0 || i >= doc.lineCount) { return ''; }
  try { return doc.lineAt(i).text; } catch { return ''; }
}

function findPrevNonBlank(doc: DocLike, from: number): string {
  for (let i = from - 1; i >= 0; i--) {
    const t = safeLine(doc, i);
    if (t.trim()) { return t; }
  }
  return '';
}

function indentWidth(line: string, tabSize = 4): number {
  let n = 0;
  for (const ch of line) {
    if (ch === '\t') { n += tabSize; }
    else if (ch === ' ') { n++; }
    else { break; }
  }
  return n;
}

// ─── Signature assembly ───────────────────────────────────────────────────────

export function toSignature(frame: ScopeFrame, lang: string): EnclosingSignature {
  const header = frame.header;
  const stripped = stripLiterals(header, lang);
  const generics = header.match(/<([^<>]*(?:<[^>]*>)?[^<>]*)>\s*\(/)?.[1] ?? '';
  return {
    kind: frame.kind,
    name: frame.name,
    params: parseParams(extractParamSource(header), lang),
    returnType: extractReturnType(header, lang),
    generics: generics.trim(),
    isAsync: /\b(async|suspend)\b/.test(stripped),
    isStatic: /\bstatic\b/.test(stripped),
    visibility: stripped.match(/\b(public|private|protected|internal|fileprivate|open|pub)\b/)?.[1] ?? '',
    throws: stripped.match(/\bthrows\s+([\w.,\s]+?)(\{|$)/)?.[1]?.trim() ?? '',
    header,
    line: frame.line,
  };
}

// ─── Binding collection ───────────────────────────────────────────────────────

interface DeclPattern {
  re: RegExp;
  nameIdx: number;
  /** Capture group holding a genuine declared type, if any */
  typeIdx?: number;
  /** Capture group holding the initialising expression, if any */
  initIdx?: number;
}

const LOCAL_DECL_PATTERNS: DeclPattern[] = [
  // Annotated: `const x: T = …` / `let x: T;`
  { re: /\b(?:const|let|var|val)\s+(\w+)\s*:\s*([\w<>\[\]|,.?& ]+?)\s*[=;]/g, nameIdx: 1, typeIdx: 2 },
  // `const x = new T(…)` — the constructor names a real type
  { re: /\b(?:const|let|var|val)\s+(\w+)\s*=\s*new\s+([\w.]+(?:<[^>]*>)?)\s*\(/g, nameIdx: 1, typeIdx: 2 },
  // `const x = await foo(…)` / `const x = foo(…)` — an initialiser, NOT a type
  { re: /\b(?:const|let|var|val)\s+(\w+)\s*=\s*((?:await\s+)?[\w.$]+\s*\()/g, nameIdx: 1, initIdx: 2 },
  // Any other initialised binding
  { re: /\b(?:const|let|var|val)\s+(\w+)\s*=/g, nameIdx: 1 },
  // Rust: `let mut x: T = …`
  { re: /\blet\s+(?:mut\s+)?(\w+)\s*:\s*([\w<>\[\]&':, ]+?)\s*[=;]/g, nameIdx: 1, typeIdx: 2 },
  // Go: `x := T{…}` / `x := new(T)` name a real type
  { re: /^\s*(\w+)\s*:=\s*(?:new\((([\w.]+))\)|&?([\w.]+)\{)/gm, nameIdx: 1, typeIdx: 2 },
  { re: /^\s*(\w+)\s*:=\s*(.{0,40}?)\s*$/gm, nameIdx: 1, initIdx: 2 },
  // Java/C#/C/C++: `Type name = …` (capitalised or primitive type only)
  { re: /^\s*(?:final\s+)?((?:[A-Z][\w.]*|int|long|short|byte|char|float|double|bool|boolean|string|size_t|unsigned)(?:<[^>;=]*>)?(?:\[\s*\])?)\s+(\w+)\s*[=;]/gm, nameIdx: 2, typeIdx: 1 },
];

/** Collect every binding visible at the cursor. */
export function collectBindings(
  doc: DocLike,
  position: PosLike,
  chain: ScopeFrame[],
  enclosing: EnclosingSignature | null
): Binding[] {
  const lang = doc.languageId;
  const seen = new Set<string>();
  const out: Binding[] = [];
  const push = (b: Binding) => {
    if (!b.name || seen.has(b.name) || /^(if|for|while|return|new|this|self)$/.test(b.name)) { return; }
    seen.add(b.name);
    out.push(b);
  };

  // 1. Fields of the enclosing type
  const typeFrame = chain.find(f =>
    f.kind === 'class' || f.kind === 'struct' || f.kind === 'interface' || f.kind === 'impl' || f.kind === 'trait');
  if (typeFrame) {
    for (const f of scanTypeFields(doc, typeFrame, lang)) { push(f); }
  }

  // 2. Parameters of the enclosing function
  if (enclosing) {
    for (const p of enclosing.params) {
      push({
        name: p.name,
        type: p.type || (p.name === 'self' || p.name === 'this' ? (typeFrame?.name ?? 'Self') : ''),
        source: p.name === 'self' || p.name === 'this' || p.name === 'cls' ? 'self' : 'param',
        line: enclosing.line,
      });
    }
  }

  // 3. Locals declared between the enclosing header and the cursor
  const bodyStart = enclosing ? enclosing.line + 1 : Math.max(0, position.line - 60);
  const bodyText = readRange(doc, bodyStart, position.line, lang);

  for (const { re, nameIdx, typeIdx, initIdx } of LOCAL_DECL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bodyText)) !== null) {
      const name = m[nameIdx];
      const type = typeIdx !== undefined ? (m[typeIdx] ?? '').trim() : '';
      const init = initIdx !== undefined ? (m[initIdx] ?? '').trim() : '';
      push({
        name,
        type,
        init: type ? undefined : (init || undefined),
        source: 'local',
        line: bodyStart,
      });
    }
  }

  // Python locals: `x = ...` / `x: T = ...` / `with open() as f:`
  if (lang === 'python') {
    for (const m of bodyText.matchAll(/^\s*(\w+)\s*(?::\s*([\w\[\]|., ]+))?\s*=[^=]/gm)) {
      push({ name: m[1], type: (m[2] ?? '').trim(), source: 'local', line: bodyStart });
    }
    for (const m of bodyText.matchAll(/\bwith\s+.*?\s+as\s+(\w+)/g)) {
      push({ name: m[1], type: '', source: 'local', line: bodyStart });
    }
  }

  // 4. Loop variables and catch bindings
  for (const m of bodyText.matchAll(/\bfor\s*\(?\s*(?:const|let|var|val|final)?\s*([\w.]+)\s*(?::\s*([\w<>\[\]]+))?\s*(?:of|in|:)\s/g)) {
    push({ name: m[1], type: (m[2] ?? '').trim(), source: 'loop', line: bodyStart });
  }
  for (const m of bodyText.matchAll(/\bfor\s+(\w+)(?:\s*,\s*(\w+))?\s*(?::=|\bin\b)/g)) {
    push({ name: m[1], type: '', source: 'loop', line: bodyStart });
    if (m[2]) { push({ name: m[2], type: '', source: 'loop', line: bodyStart }); }
  }
  for (const m of bodyText.matchAll(/\bcatch\s*\(?\s*(?:([\w.]+)\s+)?(\w+)\s*\)?/g)) {
    push({ name: m[2], type: (m[1] ?? '').trim(), source: 'catch', line: bodyStart });
  }
  for (const m of bodyText.matchAll(/\bexcept\s+([\w.]+)\s+as\s+(\w+)/g)) {
    push({ name: m[2], type: m[1], source: 'catch', line: bodyStart });
  }

  return out;
}

/** Fields declared directly in a type body (depth 1 only). */
function scanTypeFields(doc: DocLike, frame: ScopeFrame, lang: string): Binding[] {
  const out: Binding[] = [];
  const end = Math.min(doc.lineCount, frame.line + 300);
  const baseIndent = indentWidth(frame.indent + ' ');
  let depth = 0;
  let started = false;

  for (let i = frame.line; i < end; i++) {
    const raw = safeLine(doc, i);
    const stripped = stripLiterals(raw, lang);

    if (!isIndentLang(lang) && !isEndLang(lang)) {
      for (const ch of stripped) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; }
      }
      if (started && depth <= 0) { break; }
      if (depth !== 1) { continue; }
    } else {
      if (i > frame.line && raw.trim() && indentWidth(raw) <= baseIndent - 1) { break; }
    }

    const t = stripped.trim();
    if (!t || t === '{' || t === '}') { continue; }

    // TS/Swift/Kotlin/Scala: `private readonly name: Type`
    let m = t.match(/^(?:@\w+(?:\([^)]*\))?\s+)*(?:public|private|protected|internal|readonly|static|final|open|override|lateinit|@\w+|\s)*\b(?:val|var|let)?\s*(\w+)\s*[!?]?\s*:\s*([\w<>\[\]|,.?& ]+?)\s*(?:=|;|$)/);
    if (m && !/\(/.test(m[2])) { out.push({ name: m[1], type: m[2].trim(), source: 'field', line: i }); continue; }

    // Java/C#/C++: `private final Map<String,Int> name;`
    m = t.match(/^(?:@\w+(?:\([^)]*\))?\s+)*(?:public|private|protected|internal|static|final|readonly|const|volatile|transient|\s)*\b([A-Z][\w.]*(?:<[^>]*>)?(?:\[\s*\])?|int|long|short|byte|char|float|double|bool|boolean|string)\s+(\w+)\s*[=;]/);
    if (m) { out.push({ name: m[2], type: m[1].trim(), source: 'field', line: i }); continue; }

    // Rust struct field / Go struct field
    m = t.match(/^(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*([\w<>\[\]&':, ]+),?$/);
    if (m) { out.push({ name: m[1], type: m[2].trim(), source: 'field', line: i }); continue; }
    m = t.match(/^([A-Z]\w*)\s+([\w\[\]\*\.]+)\s*(?:`[^`]*`)?$/);
    if (m) { out.push({ name: m[1], type: m[2].trim(), source: 'field', line: i }); continue; }

    // Python `self.x = ...` inside __init__
    m = t.match(/^self\.(\w+)\s*(?::\s*([\w\[\]|., ]+))?\s*=/);
    if (m) { out.push({ name: m[1], type: (m[2] ?? '').trim(), source: 'field', line: i }); continue; }
  }
  return out;
}

function readRange(doc: DocLike, startLine: number, endLine: number, lang: string): string {
  const parts: string[] = [];
  for (let i = Math.max(0, startLine); i <= Math.min(endLine, doc.lineCount - 1); i++) {
    parts.push(stripLiterals(safeLine(doc, i), lang));
  }
  return parts.join('\n');
}

/** Same window, but with literals intact — needed when the literal IS the signal. */
function readRawRange(doc: DocLike, startLine: number, endLine: number): string {
  const parts: string[] = [];
  for (let i = Math.max(0, startLine); i <= Math.min(endLine, doc.lineCount - 1); i++) {
    parts.push(safeLine(doc, i));
  }
  return parts.join('\n');
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function extractSurroundingContext(doc: DocLike, position: PosLike): SurroundingContext {
  const lang = doc.languageId;
  if (doc.lineCount === 0) {
    return {
      language: lang, enclosing: null, container: null, scopeChain: [],
      bindings: [], returnExpressions: [], memberAccesses: [], freeIdentifiers: [],
    };
  }

  const chain = buildScopeChain(doc, position);
  const fnFrame = chain.find(f =>
    f.kind === 'function' || f.kind === 'method' || f.kind === 'constructor'
    || f.kind === 'getter' || f.kind === 'setter' || f.kind === 'lambda') ?? null;
  const typeFrame = chain.find(f =>
    f.kind === 'class' || f.kind === 'struct' || f.kind === 'interface'
    || f.kind === 'impl' || f.kind === 'trait' || f.kind === 'enum') ?? null;

  const enclosing = fnFrame ? toSignature(fnFrame, lang) : null;
  const bindings = collectBindings(doc, position, chain, enclosing);

  // Return expressions inside the enclosing body (feeds return-type inference)
  const returnExpressions: string[] = [];
  const memberAccesses = new Set<string>();
  if (enclosing) {
    const body = readRawRange(doc, enclosing.line + 1, position.line);
    for (const m of body.matchAll(/\breturn\s+([^;\n]+)/g)) {
      const expr = m[1].trim();
      if (expr && returnExpressions.length < 6) { returnExpressions.push(expr); }
    }
    for (const m of body.matchAll(/\b(?:this|self)\.(\w+)/g)) { memberAccesses.add(m[1]); }
  }

  // Free identifiers — referenced but not bound locally (imports, globals, types)
  const bound = new Set(bindings.map(b => b.name));
  const freeIdentifiers = new Set<string>();
  const scanFrom = Math.max(0, position.line - 40);
  const nearby = readRange(doc, scanFrom, position.line, lang);
  for (const m of nearby.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const id = m[1];
    if (bound.has(id) || RESERVED.has(id) || id.length < 2) { continue; }
    freeIdentifiers.add(id);
  }

  return {
    language: lang,
    enclosing,
    container: typeFrame,
    scopeChain: chain,
    bindings,
    returnExpressions,
    memberAccesses: [...memberAccesses],
    freeIdentifiers: [...freeIdentifiers].slice(0, 40),
  };
}

const RESERVED = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'function', 'class', 'const', 'let', 'var', 'new', 'this', 'self', 'super',
  'try', 'catch', 'finally', 'throw', 'throws', 'import', 'export', 'from', 'as', 'in',
  'of', 'typeof', 'instanceof', 'void', 'null', 'undefined', 'true', 'false', 'async',
  'await', 'yield', 'static', 'public', 'private', 'protected', 'interface', 'enum',
  'extends', 'implements', 'type', 'def', 'fn', 'func', 'fun', 'pub', 'impl', 'trait',
  'struct', 'match', 'use', 'mod', 'package', 'namespace', 'using', 'with', 'pass',
  'and', 'or', 'not', 'is', 'None', 'True', 'False', 'lambda', 'elif', 'except', 'raise',
]);

/**
 * Render the surrounding context as a compact block for the completion prompt.
 * Kept here (rather than in the prompt builder) so it is unit-testable.
 */
export function renderContextForPrompt(ctx: SurroundingContext): string {
  const lines: string[] = [];

  if (ctx.container) {
    lines.push(`Enclosing ${ctx.container.kind}: ${ctx.container.name}`);
    const fields = ctx.bindings.filter(b => b.source === 'field');
    if (fields.length) {
      lines.push(`  fields: ${fields.map(f => f.type ? `${f.name}: ${f.type}` : f.name).join(', ')}`);
    }
  }

  if (ctx.enclosing) {
    const e = ctx.enclosing;
    const sig = e.params.map(p => {
      let s = p.name;
      if (p.type) { s += `: ${p.type}`; }
      if (p.optional && p.defaultValue) { s += ` = ${p.defaultValue}`; }
      else if (p.optional) { s += '?'; }
      return (p.rest ? '...' : '') + s;
    }).join(', ');
    lines.push(`Enclosing ${e.kind}: ${e.isAsync ? 'async ' : ''}${e.name}${e.generics ? `<${e.generics}>` : ''}(${sig})${e.returnType ? ` -> ${e.returnType}` : ''}`);
    if (e.throws) { lines.push(`  throws: ${e.throws}`); }
    if (!e.returnType && ctx.returnExpressions.length) {
      lines.push(`  existing returns: ${ctx.returnExpressions.slice(0, 3).join(' | ')}`);
    }
  }

  const inScope = ctx.bindings.filter(b => b.source !== 'field');
  if (inScope.length) {
    const render = (b: typeof inScope[number]) => {
      if (b.type) { return `${b.name}: ${b.type}`; }
      if (b.init) { return `${b.name} (from ${b.init.replace(/\($/, '(…)')})`; }
      return b.name;
    };
    lines.push(`In scope: ${inScope.slice(0, 25).map(render).join(', ')}`);
  }
  if (ctx.memberAccesses.length) {
    lines.push(`Members used here: ${ctx.memberAccesses.slice(0, 15).join(', ')}`);
  }

  return lines.join('\n');
}
