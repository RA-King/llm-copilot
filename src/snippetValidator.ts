import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * snippetValidator.ts
 *
 * Checks a candidate completion before it is ever shown as ghost text.
 *
 * Two tiers:
 *
 *   1. STRUCTURAL (always on, synchronous, sub-millisecond)
 *      A delimiter/string/comment-aware scan of the snippet in the context of
 *      the code it will be spliced into. Catches the failure modes LLMs
 *      actually produce: an extra `}` that closes the enclosing class, an
 *      unterminated string, a dangling `(`, prose leaking in as code.
 *      It also REPAIRS the common cases rather than discarding the suggestion.
 *
 *   2. INTERPRETER (opt-in, asynchronous, cached)
 *      Hands the *merged document* to the language's own parser — `node
 *      --check`, `python -m py_compile`, `ruby -c`, `php -l`, `gofmt -e`,
 *      `tsc --noEmit`… — and only accepts the snippet if that parser accepts
 *      it. This is the ground truth: the same front-end that will compile the
 *      file decides whether the suggestion is syntactically valid.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StructuralResult {
  ok: boolean;
  /** The snippet after repair; equals the input when nothing was changed */
  snippet: string;
  /** Why it was rejected, or what was repaired */
  reason: string;
  repaired: boolean;
}

export interface InterpreterResult {
  /** 'valid' | 'invalid' | 'skipped' (no toolchain, disabled, or timed out) */
  status: 'valid' | 'invalid' | 'skipped';
  /** Parser message when invalid */
  message: string;
}

// ─── Delimiter scanning ───────────────────────────────────────────────────────

interface ScanState {
  round: number;
  square: number;
  curly: number;
  inString: string | null;   // the open quote char
  inBlockComment: boolean;
  /** Positions of closers that had no matching opener within the scanned text */
  unmatchedClosers: number[];
}

const HASH_COMMENT_LANGS = new Set([
  'python', 'ruby', 'shellscript', 'perl', 'r', 'yaml', 'toml', 'makefile', 'elixir',
]);
const NO_BLOCK_COMMENT_LANGS = new Set(['python', 'ruby', 'shellscript', 'perl', 'yaml']);

function freshState(): ScanState {
  return { round: 0, square: 0, curly: 0, inString: null, inBlockComment: false, unmatchedClosers: [] };
}

/**
 * Scan `text`, updating the delimiter/string/comment state. Handles line
 * comments, block comments, single/double/backtick strings, escapes, and
 * (approximately) triple-quoted Python strings.
 */
export function scan(text: string, lang: string, state: ScanState = freshState()): ScanState {
  const hashComments = HASH_COMMENT_LANGS.has(lang);
  const blockComments = !NO_BLOCK_COMMENT_LANGS.has(lang);
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (state.inBlockComment) {
      if (ch === '*' && next === '/') { state.inBlockComment = false; i += 2; continue; }
      i++;
      continue;
    }

    if (state.inString) {
      // Triple quotes (Python / Scala / Kotlin raw strings)
      if (state.inString.length === 3) {
        if (text.startsWith(state.inString, i)) { state.inString = null; i += 3; continue; }
        i++;
        continue;
      }
      if (ch === '\\') { i += 2; continue; }
      if (ch === state.inString) { state.inString = null; i++; continue; }
      // An unescaped newline terminates a normal string in every language here
      if (ch === '\n' && state.inString !== '`') { state.inString = null; i++; continue; }
      i++;
      continue;
    }

    // Comments
    if (ch === '/' && next === '/' && !hashComments) {
      const nl = text.indexOf('\n', i);
      if (nl === -1) { break; }
      i = nl + 1;
      continue;
    }
    if (ch === '#' && hashComments) {
      const nl = text.indexOf('\n', i);
      if (nl === -1) { break; }
      i = nl + 1;
      continue;
    }
    if (ch === '/' && next === '*' && blockComments) { state.inBlockComment = true; i += 2; continue; }

    // Strings
    if (ch === '"' || ch === "'" || ch === '`') {
      if (text.startsWith(ch.repeat(3), i)) { state.inString = ch.repeat(3); i += 3; continue; }
      state.inString = ch;
      i++;
      continue;
    }

    // Delimiters
    if (ch === '(') { state.round++; }
    else if (ch === '[') { state.square++; }
    else if (ch === '{') { state.curly++; }
    else if (ch === ')') { state.round--; if (state.round < 0) { state.unmatchedClosers.push(i); state.round = 0; } }
    else if (ch === ']') { state.square--; if (state.square < 0) { state.unmatchedClosers.push(i); state.square = 0; } }
    else if (ch === '}') { state.curly--; if (state.curly < 0) { state.unmatchedClosers.push(i); state.curly = 0; } }

    i++;
  }
  return state;
}

// ─── Prose detection ──────────────────────────────────────────────────────────

/**
 * LLMs sometimes emit an explanatory sentence instead of code. A line is prose
 * when it has no code punctuation and reads like English.
 */
export function looksLikeProse(line: string, lang: string): boolean {
  const t = line.trim();
  if (!t) { return false; }
  // Comments are fine
  if (/^(\/\/|\/\*|\*|#|--|;;)/.test(t)) { return false; }
  // Any code punctuation clears it
  if (/[{}()\[\];=<>+\-*/%&|!~^:,."'`@$\\]/.test(t)) { return false; }
  // Python/Ruby/Go statements with no punctuation are legal — `pass`, `end`, `return`
  if (/^(pass|end|break|continue|return|else|do|begin|rescue|ensure|fi|done|esac|loop|unsafe)$/.test(t)) { return false; }
  // A bare identifier is plausible code; three-plus lowercase words is not
  const words = t.split(/\s+/);
  if (words.length < 3) { return false; }
  const englishy = words.filter(w => /^[A-Za-z]+$/.test(w)).length;
  return englishy >= 3 && englishy / words.length > 0.75;
}

// ─── Structural validation + repair ───────────────────────────────────────────

/**
 * Validate a snippet that will be spliced in at the cursor.
 *
 * @param snippet   the candidate completion (already formatted)
 * @param prefix    document text before the cursor
 * @param suffix    document text after the cursor
 * @param lang      language id
 */
export function validateStructure(
  snippet: string,
  prefix: string,
  suffix: string,
  lang: string
): StructuralResult {
  if (!snippet.trim()) {
    return { ok: false, snippet, reason: 'empty snippet', repaired: false };
  }

  // ── Prose leakage ────────────────────────────────────────────────────────
  const lines = snippet.split('\n');
  const proseIdx = lines.findIndex(l => looksLikeProse(l, lang));
  let working = snippet;
  let repaired = false;
  let reason = '';

  if (proseIdx === 0) {
    return { ok: false, snippet, reason: 'snippet is prose, not code', repaired: false };
  }
  if (proseIdx > 0) {
    // Trailing commentary — cut it off and keep the code above it
    working = lines.slice(0, proseIdx).join('\n').trimEnd();
    repaired = true;
    reason = 'trimmed trailing prose';
    if (!working.trim()) {
      return { ok: false, snippet, reason: 'snippet is prose, not code', repaired: false };
    }
  }

  // ── Is the cursor even in code? ──────────────────────────────────────────
  // This is the only question that needs the whole prefix: whether the
  // insertion point sits inside an open string or block comment.
  const prefixState = scan(prefix, lang);
  if (prefixState.inString || prefixState.inBlockComment) {
    return { ok: false, snippet: working, reason: 'cursor is inside a string or comment', repaired };
  }

  // ── Delimiter balance ────────────────────────────────────────────────────
  // Scanned from a FRESH state, so the counters mean exactly what we need:
  // `unmatchedClosers` are delimiters that close a block opened before the
  // cursor, and the remaining depths are blocks the snippet leaves open.
  let state = scan(working, lang);

  if (state.inString) {
    return { ok: false, snippet: working, reason: 'snippet leaves a string unterminated', repaired };
  }
  if (state.inBlockComment) {
    return { ok: false, snippet: working, reason: 'snippet leaves a block comment unterminated', repaired };
  }

  // ── Over-closing repair ──────────────────────────────────────────────────
  // The classic LLM error: closing the *enclosing* block. Drop the trailing
  // closers that did it rather than discarding an otherwise good suggestion.
  const overClosed = state.unmatchedClosers.length;
  if (overClosed > 0) {
    const trimmedResult = trimTrailingClosers(working, overClosed, lang);
    if (!trimmedResult) {
      return { ok: false, snippet: working, reason: 'snippet closes blocks it did not open', repaired };
    }
    working = trimmedResult;
    repaired = true;
    reason = reason
      ? `${reason}; removed ${overClosed} over-closing delimiter(s)`
      : `removed ${overClosed} over-closing delimiter(s)`;
    state = scan(working, lang);   // only re-scan when the snippet actually changed
  }

  // ── Under-closing check ──────────────────────────────────────────────────
  // Leaving a block open is acceptable only when the suffix closes it.
  if (state.round > 0 || state.square > 0 || state.curly > 0) {
    const suffixCloses = countClosersBeforeOpeners(suffix, lang);
    if (state.round > suffixCloses.round || state.square > suffixCloses.square) {
      return { ok: false, snippet: working, reason: 'snippet leaves brackets unclosed', repaired };
    }
    if (state.curly > suffixCloses.curly) {
      return { ok: false, snippet: working, reason: 'snippet leaves braces unclosed', repaired };
    }
  }

  // ── Language-specific sanity ─────────────────────────────────────────────
  const langIssue = languageSanity(working, lang);
  if (langIssue) {
    return { ok: false, snippet: working, reason: langIssue, repaired };
  }

  return { ok: true, snippet: working, reason: reason || 'ok', repaired };
}

/**
 * Remove up to `count` trailing closing delimiters (and the whitespace-only
 * lines they sit on). Returns null when the trailing text is not just closers.
 */
function trimTrailingClosers(snippet: string, count: number, lang: string): string | null {
  const lines = snippet.split('\n');
  let removed = 0;

  while (removed < count && lines.length > 0) {
    const idx = lines.length - 1;
    const t = lines[idx].trim();
    if (t === '') { lines.pop(); continue; }
    if (/^[)\]};,]+$/.test(t)) {
      const closers = (t.match(/[)\]}]/g) ?? []).length;
      if (closers === 0) { return null; }
      if (removed + closers > count) {
        // Partially over-closing line — strip just the excess from the right
        let keep = t;
        let toDrop = count - removed;
        while (toDrop > 0 && /[)\]}]/.test(keep)) {
          keep = keep.replace(/[)\]}](?=[^)\]}]*$)/, '');
          toDrop--;
        }
        lines[idx] = (lines[idx].match(/^\s*/)?.[0] ?? '') + keep.trim();
        removed = count;
        break;
      }
      lines.pop();
      removed += closers;
      continue;
    }
    // Trailing closers appended to a code line: `return x; }`
    const m = lines[idx].match(/^(.*?)(\s*[)\]};,]+)\s*$/);
    if (m) {
      const closers = (m[2].match(/[)\]}]/g) ?? []).length;
      if (closers > 0 && closers <= count - removed && m[1].trim()) {
        lines[idx] = m[1].trimEnd();
        removed += closers;
        continue;
      }
    }
    return null;
  }

  void lang;
  const out = lines.join('\n').trimEnd();
  return out.trim() ? out : null;
}

/**
 * Count closers in `text` that appear before any matching opener — i.e. the
 * delimiters the code after the cursor will close on the snippet's behalf.
 *
 * Only the head of the suffix can be relevant (a block the snippet opens is
 * closed within a few lines, or not at all), so the window is capped rather
 * than scanning to the end of the file on every suggestion.
 */
const SUFFIX_SCAN_LIMIT = 8_000;

function countClosersBeforeOpeners(full: string, lang: string): { round: number; square: number; curly: number } {
  const text = full.length > SUFFIX_SCAN_LIMIT ? full.slice(0, SUFFIX_SCAN_LIMIT) : full;
  let round = 0, square = 0, curly = 0;
  const st = freshState();
  let i = 0;
  const hashComments = HASH_COMMENT_LANGS.has(lang);
  while (i < text.length) {
    const ch = text[i];
    const nx = text[i + 1];
    if (st.inBlockComment) { if (ch === '*' && nx === '/') { st.inBlockComment = false; i += 2; continue; } i++; continue; }
    if (st.inString) {
      if (st.inString.length === 3) { if (text.startsWith(st.inString, i)) { st.inString = null; i += 3; continue; } i++; continue; }
      if (ch === '\\') { i += 2; continue; }
      if (ch === st.inString || (ch === '\n' && st.inString !== '`')) { st.inString = null; }
      i++;
      continue;
    }
    if (ch === '/' && nx === '/' && !hashComments) { const nl = text.indexOf('\n', i); if (nl === -1) { break; } i = nl + 1; continue; }
    if (ch === '#' && hashComments) { const nl = text.indexOf('\n', i); if (nl === -1) { break; } i = nl + 1; continue; }
    if (ch === '/' && nx === '*' && !NO_BLOCK_COMMENT_LANGS.has(lang)) { st.inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (text.startsWith(ch.repeat(3), i)) { st.inString = ch.repeat(3); i += 3; continue; }
      st.inString = ch; i++; continue;
    }
    if (ch === '(') { st.round++; } else if (ch === ')') { if (st.round > 0) { st.round--; } else { round++; } }
    else if (ch === '[') { st.square++; } else if (ch === ']') { if (st.square > 0) { st.square--; } else { square++; } }
    else if (ch === '{') { st.curly++; } else if (ch === '}') { if (st.curly > 0) { st.curly--; } else { curly++; } }
    i++;
  }
  return { round, square, curly };
}

/** Cheap language-specific red flags the delimiter scan cannot see. */
function languageSanity(snippet: string, lang: string): string {
  const lines = snippet.split('\n').filter(l => l.trim());
  if (!lines.length) { return 'empty snippet'; }

  if (lang === 'python') {
    // A block opener must be followed by a more-indented line
    for (let i = 0; i < lines.length - 1; i++) {
      if (/:\s*$/.test(lines[i])) {
        const cur = lines[i].match(/^\s*/)![0].length;
        const nxt = lines[i + 1].match(/^\s*/)![0].length;
        if (nxt <= cur) { return 'python block opened but not indented'; }
      }
    }
    if (/:\s*$/.test(lines[lines.length - 1])) { return 'python block opened with no body'; }
  }

  if (lang === 'go') {
    if (/\bfunc\b/.test(snippet) && !/{/.test(snippet) && !/\binterface\b/.test(snippet)) {
      return 'go function declared without a body';
    }
  }

  // Markdown / fence artefacts that slipped past the stripper
  if (/^\s*```/m.test(snippet)) { return 'snippet still contains a code fence'; }
  // A stray "Here is" style preamble
  if (/^(here\s|this\s+(code|function|method)\s|the\s+following\s)/i.test(lines[0].trim())) {
    return 'snippet starts with an explanation';
  }

  return '';
}

// ─── Tier 2: the language's real parser ───────────────────────────────────────

interface Toolchain {
  /** Binary to run */
  cmd: string;
  /** Arguments; `{file}` is replaced with the temp file path */
  args: string[];
  /** Temp-file extension */
  ext: string;
  /** Exit code 0 means "parsed successfully" */
  successExit?: number;
  /** Some tools report syntax errors on stdout while exiting 0 */
  failOnOutput?: boolean;
}

/**
 * Syntax-only checkers.
 *
 * Every entry here must satisfy three properties, or it does not belong:
 *   1. It PARSES without EXECUTING the program (no `perl -c`, which runs BEGIN
 *      blocks; no `rustc --emit=metadata`, which type-checks).
 *   2. It needs no resolved dependencies, because the candidate is written to a
 *      temp directory where relative imports cannot resolve. A checker that
 *      reports unresolved-import errors would reject every valid suggestion.
 *   3. It ships as a stable, non-nightly command.
 *
 * TypeScript is deliberately absent: `tsc` violates (2). It is handled
 * in-process by the TypeScript parser instead — see `parseWithTypeScript`.
 */
const TOOLCHAINS: Record<string, Toolchain[]> = {
  javascript:      [{ cmd: 'node', args: ['--check', '{file}'], ext: '.js' }],
  javascriptreact: [{ cmd: 'node', args: ['--check', '{file}'], ext: '.js' }],
  python: [
    { cmd: 'python3', args: ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', '{file}'], ext: '.py' },
    { cmd: 'python',  args: ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', '{file}'], ext: '.py' },
  ],
  ruby:  [{ cmd: 'ruby', args: ['-c', '{file}'], ext: '.rb' }],
  php:   [{ cmd: 'php',  args: ['-l', '{file}'], ext: '.php' }],
  go:    [{ cmd: 'gofmt', args: ['-e', '{file}'], ext: '.go' }],
  lua:   [{ cmd: 'luac', args: ['-p', '{file}'], ext: '.lua' }],
  shellscript: [{ cmd: 'bash', args: ['-n', '{file}'], ext: '.sh' }],
};

/** Languages parsed in-process by the TypeScript compiler's own scanner. */
const TS_LANGS: Record<string, boolean> = {
  typescript: false, typescriptreact: true,
};

/** Cache of "is this binary on PATH" so we probe each one only once. */
const availability = new Map<string, boolean>();
/** Cache of validation verdicts keyed by a hash of the merged source. */
const verdictCache = new Map<string, InterpreterResult>();
const VERDICT_CACHE_MAX = 200;

async function isAvailable(cmd: string): Promise<boolean> {
  const cached = availability.get(cmd);
  if (cached !== undefined) { return cached; }
  const found = await new Promise<boolean>(resolve => {
    const probe = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    const timer = setTimeout(() => { probe.kill(); resolve(false); }, 1500);
    probe.on('error', () => { clearTimeout(timer); resolve(false); });
    probe.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
  availability.set(cmd, found);
  return found;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number):
  Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    let out = '';
    let done = false;
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code: number | null) => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      resolve({ code, out: out.slice(0, 4000) });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout?.on('data', d => { out += d.toString(); });
    child.stderr?.on('data', d => { out += d.toString(); });
    child.on('error', () => finish(null));
    child.on('close', code => finish(code));
  });
}

/**
 * Parse TypeScript/TSX with the compiler's own scanner, in-process.
 *
 * `createSourceFile` runs the real TypeScript parser but performs no type
 * checking and touches no other file, so it is both instant and immune to the
 * unresolved-import problem that makes `tsc` unusable here.
 *
 * The `typescript` package is resolved from the workspace; when the project
 * does not have one, the check is skipped.
 */
function parseWithTypeScript(source: string, jsx: boolean, cwd: string): InterpreterResult {
  let ts: any;
  try {
    // Prefer the workspace's own TypeScript, then anything already loaded.
    const req = eval('require') as NodeRequire;
    let resolved: string | undefined;
    try {
      resolved = req.resolve('typescript', { paths: [cwd, path.join(cwd, 'node_modules')] });
    } catch { resolved = undefined; }
    ts = resolved ? req(resolved) : req('typescript');
  } catch {
    return { status: 'skipped', message: 'typescript package not available' };
  }
  if (!ts?.createSourceFile) { return { status: 'skipped', message: 'typescript package unusable' }; }

  try {
    const sf = ts.createSourceFile(
      jsx ? 'candidate.tsx' : 'candidate.ts',
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const diags = sf.parseDiagnostics ?? [];
    if (!diags.length) { return { status: 'valid', message: '' }; }
    const d = diags[0];
    const message = typeof d.messageText === 'string'
      ? d.messageText
      : (d.messageText?.messageText ?? 'syntax error');
    const at = typeof d.start === 'number'
      ? sf.getLineAndCharacterOfPosition(d.start)
      : null;
    return {
      status: 'invalid',
      message: at ? `line ${at.line + 1}: ${message}` : String(message),
    };
  } catch (err: unknown) {
    return { status: 'skipped', message: err instanceof Error ? err.message : 'parse failed' };
  }
}

export interface InterpreterOptions {
  timeoutMs?: number;
  /** Directory to run the checker in (the workspace root, when there is one) */
  cwd?: string;
}

/**
 * Parse `mergedSource` — the whole file with the completion spliced in — using
 * the language's own front-end.
 *
 * Returns 'skipped' whenever no suitable toolchain is installed or the checker
 * could not be launched, so a missing compiler never costs the user a
 * suggestion. Only a real parse failure yields 'invalid'.
 */
export async function validateWithInterpreter(
  mergedSource: string,
  language: string,
  opts: InterpreterOptions = {}
): Promise<InterpreterResult> {
  const cwd = opts.cwd ?? process.cwd();
  const key = `${language}:${crypto.createHash('sha1').update(mergedSource).digest('hex')}`;
  const cached = verdictCache.get(key);
  if (cached) { return cached; }

  // In-process TypeScript path
  if (language in TS_LANGS) {
    const result = parseWithTypeScript(mergedSource, TS_LANGS[language], cwd);
    remember(key, result);
    return result;
  }

  const chains = TOOLCHAINS[language];
  if (!chains?.length) { return { status: 'skipped', message: 'no syntax checker for this language' }; }

  const timeoutMs = opts.timeoutMs ?? 2500;

  let chosen: Toolchain | null = null;
  for (const chain of chains) {
    if (await isAvailable(chain.cmd)) { chosen = chain; break; }
  }
  if (!chosen) {
    const result: InterpreterResult = { status: 'skipped', message: 'syntax checker not installed' };
    remember(key, result);
    return result;
  }

  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'llm-copilot-'));
  const file = path.join(dir, `candidate${chosen.ext}`);
  let result: InterpreterResult;
  try {
    fs.writeFileSync(file, mergedSource, 'utf8');
    const args = chosen.args.map(a => a.replace('{file}', file));
    const { code, out } = await run(chosen.cmd, args, cwd, timeoutMs);

    if (code === null) {
      result = { status: 'skipped', message: 'syntax check timed out' };
    } else if (code === (chosen.successExit ?? 0) && !(chosen.failOnOutput && out.trim())) {
      result = { status: 'valid', message: '' };
    } else if (looksLikeLaunchFailure(out)) {
      // The tool itself could not run — that is not the snippet's fault.
      result = { status: 'skipped', message: firstError(out, dir) };
    } else {
      result = { status: 'invalid', message: firstError(out, dir) };
    }
  } catch (err: unknown) {
    result = { status: 'skipped', message: err instanceof Error ? err.message : 'syntax check failed to run' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  remember(key, result);
  return result;
}

/** Distinguish "the checker broke" from "the code is wrong". */
function looksLikeLaunchFailure(output: string): boolean {
  return /\b(command not found|No such file or directory: '?(node|python3?|ruby|php|gofmt|luac|bash)|npm error|ENOENT|cannot execute binary|Permission denied|missing packages)\b/i
    .test(output);
}

function remember(key: string, result: InterpreterResult) {
  if (verdictCache.size >= VERDICT_CACHE_MAX) {
    const oldest = verdictCache.keys().next().value;
    if (oldest) { verdictCache.delete(oldest); }
  }
  verdictCache.set(key, result);
}

/**
 * Pick the line of the checker's output that actually names the problem.
 * Parsers vary: Python leads with a traceback header, node prints the offending
 * source line first, gofmt goes straight to `file:line:col: message`.
 */
function firstError(output: string, tempDir: string): string {
  const cleaned = output
    .split('\n')
    .map(l => l.replace(new RegExp(escapeRe(tempDir) + '/?', 'g'), '')
                .replace(/^\/private/, '')
                .trim())
    .filter(l => l.length > 0);

  const informative = cleaned.find(l =>
    /(SyntaxError|IndentationError|TabError|ParseError|Parse error|error:|Error:|expected|unexpected|Unexpected|missing|Missing)/.test(l)
    && !/^Traceback/.test(l));

  return (informative ?? cleaned[0] ?? 'syntax error').slice(0, 240);
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Test seam — clears the memoised binary probes and cached verdicts. */
export function __resetValidatorCaches(): void {
  availability.clear();
  verdictCache.clear();
}

/** Which languages this build can hand to a real parser. */
export function interpreterLanguages(): string[] {
  return [...Object.keys(TOOLCHAINS), ...Object.keys(TS_LANGS)];
}
