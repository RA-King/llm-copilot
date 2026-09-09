/**
 * errorParser.ts
 *
 * Reads a block of terminal or debugger output and works out what actually went
 * wrong: which runtime or tool printed it, the exception class and message, and
 * the frames that name a real file and line.
 *
 * The point is not to pretty-print the trace — the user can already read it in
 * the panel it came from. It is to find the one or two files the failure is
 * really about, so the source around those lines can be sent with the question.
 * A stack trace without its code is guesswork; with it, the model is answering
 * about the program the user is actually running.
 *
 * Traces are matched by shape rather than by asking the editor what language is
 * open: output arrives from a terminal that may be running anything, and a Java
 * frame `at com.acme.Order.total(Order.java:42)` cannot be confused with
 * `File "orders.py", line 42, in total`. Everything here is pure text work.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Which panel the output was captured from. */
export type ErrorSource = 'terminal' | 'debug';

/** The runtime or tool whose trace format the output matches. */
export type ErrorOrigin =
  | 'node' | 'python' | 'java' | 'dotnet' | 'go' | 'rust' | 'ruby' | 'php'
  | 'compiler' | 'package-manager' | 'unknown';

export interface StackFrame {
  /** Path as the trace wrote it — absolute, relative, or a bare file name. */
  file: string;
  line?: number;
  column?: number;
  /** Function, method or class the frame names, where the format carries one. */
  symbol?: string;
}

export interface ParsedError {
  source: ErrorSource;
  origin: ErrorOrigin;
  /** Exception class or diagnostic code, when the output names one. */
  type?: string;
  /** The message on its own, without the class name. */
  message: string;
  /** `type: message`, trimmed to something that fits in a list. */
  headline: string;
  /** Ordered as printed; use {@link rankFrames} to get the interesting ones. */
  frames: StackFrame[];
  /** The cleaned-up text the rest of this was read from. */
  text: string;
}

// ─── Cleaning ─────────────────────────────────────────────────────────────────

// Colour codes, cursor moves, and the OSC sequences a shell uses to set the
// window title or emit a hyperlink. Captured terminal output is full of all
// three and none of them survive into a prompt.
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function normalise(raw: string): string[] {
  return stripAnsi(raw).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
}

// ─── Recognising a failure ────────────────────────────────────────────────────

const ERROR_WORDS =
  /\b(error|errors|exception|fatal|panic|traceback|failed|failure|refused|denied|not found|cannot find|no such file|segmentation fault|assertion|unhandled|unresolved)\b/i;

/** `0 errors`, `error-handling.ts`, `--error-format` — words that only look bad. */
const FALSE_POSITIVE = /\b(0 errors?|no errors?|error[-_]|errors?:\s*0)\b/i;

/** A thrown class name carries no word boundary of its own: `TypeError`. */
const EXCEPTION_NAME = /\b[A-Z]\w*(?:Error|Exception|Fault|Panic)\b/;

/** A line that could plausibly be the start of a failure worth analysing. */
export function isSignalLine(line: string): boolean {
  const text = line.trim();
  if (!text) { return false; }
  if (FALSE_POSITIVE.test(text) && !/exception|traceback|panic/i.test(text)) { return false; }
  if (ERROR_WORDS.test(text) || EXCEPTION_NAME.test(text)) { return true; }
  return DIAGNOSTIC_PATTERNS.some(p => p.re.test(text));
}

/** True when the output looks like something failed rather than merely ran. */
export function looksLikeError(text: string): boolean {
  return normalise(text).some(isSignalLine);
}

/**
 * Cuts a capture down to the part worth sending. Build output can run to
 * thousands of lines, and the failure is almost always at the end — so keep the
 * tail, then trim the front back to just before the first line that reads like
 * an error, leaving a little of the output that led into it.
 */
export function extractErrorBlock(raw: string, maxLines = 80): string {
  const lines = normalise(raw);
  while (lines.length && !lines[lines.length - 1].trim()) { lines.pop(); }
  if (!lines.length) { return ''; }

  const tail = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  const first = tail.findIndex(isSignalLine);
  const start = first > 0 ? Math.max(0, first - 3) : 0;
  return tail.slice(start).join('\n').trim();
}

// ─── Frame formats ────────────────────────────────────────────────────────────

interface FramePattern {
  origin: ErrorOrigin;
  re: RegExp;
  file: number;
  line?: number;
  column?: number;
  symbol?: number;
}

/**
 * Ordered within each origin from most specific to least. A line is only tried
 * against its own runtime's patterns and the compiler diagnostics, which turn
 * up interleaved in build output whatever is being built.
 */
const FRAME_PATTERNS: FramePattern[] = [
  // Node:  at total (/app/src/order.ts:42:15)      at /app/src/order.ts:42:15
  { origin: 'node', re: /^\s*at\s+(?:async\s+)?([\w$.<>[\]\s]+?)\s+\((.+?):(\d+):(\d+)\)\s*$/, symbol: 1, file: 2, line: 3, column: 4 },
  { origin: 'node', re: /^\s*at\s+(.+?):(\d+):(\d+)\s*$/, file: 1, line: 2, column: 3 },

  // Python:  File "/app/orders.py", line 42, in total
  { origin: 'python', re: /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?\s*$/, file: 1, line: 2, symbol: 3 },

  // Java / Kotlin / Scala:  at com.acme.Order.total(Order.java:42)
  { origin: 'java', re: /^\s*at\s+([\w$.<>]+)\(([\w$.-]+\.(?:java|kt|kts|scala|groovy)):(\d+)\)/, symbol: 1, file: 2, line: 3 },

  // .NET:  at Acme.Order.Total() in /app/Order.cs:line 42
  { origin: 'dotnet', re: /^\s*at\s+(.+?)\s+in\s+(.+?):line\s+(\d+)\s*$/, symbol: 1, file: 2, line: 3 },

  // Go:  the file line printed under the function line, with the PC offset
  { origin: 'go', re: /^\s*((?:[A-Za-z]:)?[^\s:]+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/, file: 1, line: 2 },

  // Rust:  thread 'main' panicked at src/main.rs:42:9   /   at src/main.rs:42
  { origin: 'rust', re: /panicked at\s+(.+?\.rs):(\d+):(\d+)/, file: 1, line: 2, column: 3 },
  { origin: 'rust', re: /^\s*(?:\d+:\s+)?\s*at\s+(.+?\.rs):(\d+)(?::(\d+))?\s*$/, file: 1, line: 2, column: 3 },

  // Ruby:  from /app/order.rb:42:in `total'
  { origin: 'ruby', re: /^\s*(?:from\s+)?(.+?\.rb):(\d+):in\s+[`'](.+?)'/, file: 1, line: 2, symbol: 3 },

  // PHP:  #0 /app/Order.php(42): total()      ... in /app/Order.php on line 42
  { origin: 'php', re: /^#\d+\s+(.+?\.php)\((\d+)\)(?::\s*(.+))?/, file: 1, line: 2, symbol: 3 },
  { origin: 'php', re: /\sin\s+(.+?\.php)\s+on\s+line\s+(\d+)/, file: 1, line: 2 },
  { origin: 'php', re: /\s(\S+?\.php):(\d+)/, file: 1, line: 2 },
];

/**
 * Compiler and linter diagnostics. These carry the location *and* the message,
 * so they are read both as frames and — by {@link findHeadline} — as the
 * failure itself.
 */
const DIAGNOSTIC_PATTERNS: FramePattern[] = [
  // TypeScript / MSBuild:  src/order.ts(42,15): error TS2345: message
  { origin: 'compiler', re: /^(.+?)\((\d+),(\d+)\):\s*(?:fatal\s+)?error\b/, file: 1, line: 2, column: 3 },
  // gcc / clang / tsc --pretty / eslint:  src/order.c:42:15: error: message
  { origin: 'compiler', re: /^(.+?):(\d+):(\d+):\s*(?:fatal\s+)?(?:error|Error)\b/, file: 1, line: 2, column: 3 },
  // javac:  /app/Order.java:42: error: message
  { origin: 'compiler', re: /^(.+?):(\d+):\s*(?:fatal\s+)?error\b/, file: 1, line: 2 },
  // rustc's location arrow:  --> src/main.rs:42:9
  { origin: 'compiler', re: /^\s*-->\s*(.+?):(\d+)(?::(\d+))?\s*$/, file: 1, line: 2, column: 3 },
];

/** Last resort: any `path.ext:line` or `path.ext(line)` sitting in the text. */
const LOOSE_FRAME = /(?:^|[\s(['"])((?:[A-Za-z]:)?[\w./\\@+-]+\.[A-Za-z]\w{0,4})[:(](\d+)(?:[:,](\d+))?\)?/;

// ─── Origin ───────────────────────────────────────────────────────────────────

interface OriginSignature { origin: ErrorOrigin; re: RegExp; }

/** Checked in order; the first runtime whose fingerprint appears wins. */
const ORIGIN_SIGNATURES: OriginSignature[] = [
  { origin: 'python', re: /^Traceback \(most recent call last\)|^\s*File\s+".+?",\s+line\s+\d+/m },
  { origin: 'java',   re: /^(?:Exception in thread|Caused by:)|^\s*at\s+[\w$.]+\([\w$.-]+\.(?:java|kt|kts|scala|groovy):\d+\)/m },
  { origin: 'dotnet', re: /^Unhandled exception\.|^\s*at\s+.+\s+in\s+.+:line\s+\d+/m },
  { origin: 'go',     re: /^goroutine \d+ \[|^panic:\s/m },
  { origin: 'rust',   re: /panicked at|^error\[E\d+\]/m },
  { origin: 'ruby',   re: /\.rb:\d+:in\s+[`']/m },
  { origin: 'php',    re: /^PHP (?:Fatal error|Warning|Parse error|Notice)|^#\d+\s+.+\.php\(\d+\)/m },
  { origin: 'node',   re: /^\s*at\s+.+:\d+:\d+\)?\s*$|node:internal|^\s*at\s+[\w$.]+\s+\(/m },
];

const PACKAGE_MANAGER =
  /^(?:npm ERR!|yarn error|pnpm ERR!|FAILURE: Build failed|\[ERROR\]\s|BUILD FAILED|error Command failed)/m;

function detectOrigin(text: string): ErrorOrigin {
  for (const sig of ORIGIN_SIGNATURES) {
    if (sig.re.test(text)) { return sig.origin; }
  }
  if (DIAGNOSTIC_PATTERNS.some(p => new RegExp(p.re.source, 'm').test(text))) { return 'compiler'; }
  if (PACKAGE_MANAGER.test(text)) { return 'package-manager'; }
  return 'unknown';
}

// ─── Headline ─────────────────────────────────────────────────────────────────

interface HeadlinePattern {
  /** Restrict to one runtime, or leave it out to try the pattern on anything. */
  origin?: ErrorOrigin;
  re: RegExp;
  type?: number;
  /** Capture group holding the message; 0 means "the whole line". */
  message: number;
  /** Python prints the exception last; everything else prints it first. */
  from?: 'bottom';
}

const HEADLINE_PATTERNS: HeadlinePattern[] = [
  // Python's exception line closes the traceback.
  { origin: 'python', re: /^([\w.]*(?:Error|Exception|Interrupt|Exit|Warning))(?::\s*(.*))?$/, type: 1, message: 2, from: 'bottom' },

  { origin: 'java',   re: /^(?:Exception in thread\s+".*?"\s+)?(?:Caused by:\s+)?([\w$.]+(?:Exception|Error|Throwable))(?::\s*(.*))?$/, type: 1, message: 2 },
  { origin: 'dotnet', re: /^(?:Unhandled exception\.\s*)?([\w.]+Exception):\s*(.*)$/, type: 1, message: 2 },
  { origin: 'go',     re: /^panic:\s*(.*)$/, message: 1 },
  { origin: 'rust',   re: /^thread\s+'.*?'\s+panicked at\s+(.*)$/, message: 1 },
  { origin: 'rust',   re: /^(error\[E\d+\]|error):\s*(.*)$/, type: 1, message: 2 },
  { origin: 'ruby',   re: /^.+?:\d+:in\s+[`'].+?':\s*(.*?)\s*\((\w+(?:Error|Exception))\)\s*$/, message: 1, type: 2 },
  { origin: 'php',    re: /^PHP\s+(?:Fatal error|Parse error|Warning):\s+(?:Uncaught\s+)?(?:([\w\\]+):\s*)?(.*)$/, type: 1, message: 2 },

  // Compiler diagnostics carry a code worth keeping — TS2345, E0308, CS1002.
  { origin: 'compiler', re: /^.+?\(\d+,\d+\):\s*(?:fatal\s+)?error\s+(\w+)?:?\s*(.*)$/, type: 1, message: 2 },
  { origin: 'compiler', re: /^.+?:\d+(?::\d+)?:\s*(?:fatal\s+)?error(?:\[(\w+)\])?:\s*(.*)$/, type: 1, message: 2 },
  { origin: 'compiler', re: /^error\[(E\d+)\]:\s*(.*)$/, type: 1, message: 2 },

  { origin: 'package-manager', re: /^npm ERR!\s+(?!code\b|errno\b|syscall\b|path\b|A complete log)(.*)$/, message: 1 },
  { origin: 'package-manager', re: /^\[ERROR\]\s+(.*)$/, message: 1 },
  { origin: 'package-manager', re: /^(?:FAILURE: Build failed.*|BUILD FAILED.*|error Command failed.*)$/, message: 0 },

  // Anything at all: a thrown class name, then any line that reads like a failure.
  { re: /^(?:Uncaught\s+)?([A-Z][\w$.]*(?:Error|Exception|Fault)):\s*(.*)$/, type: 1, message: 2 },
  { re: /^.*?\b(?:error|fatal|failed|failure|panic)\b.*$/i, message: 0 },
];

function findHeadline(lines: string[], origin: ErrorOrigin): { type?: string; message: string } {
  for (const pattern of HEADLINE_PATTERNS) {
    if (pattern.origin && pattern.origin !== origin) { continue; }
    const order = pattern.from === 'bottom' ? [...lines].reverse() : lines;
    for (const raw of order) {
      const line = raw.trim();
      if (!line) { continue; }
      const m = pattern.re.exec(line);
      if (!m) { continue; }
      const type = pattern.type !== undefined ? m[pattern.type] : undefined;
      const message = (pattern.message === 0 ? m[0] : m[pattern.message]) ?? '';
      if (!type && !message.trim()) { continue; }
      return { type: type?.trim() || undefined, message: message.trim() };
    }
  }
  const firstReal = lines.find(l => l.trim());
  return { message: firstReal ? firstReal.trim() : '' };
}

// ─── Frames ───────────────────────────────────────────────────────────────────

function toFrame(m: RegExpExecArray, p: FramePattern): StackFrame | null {
  const file = m[p.file]?.trim();
  if (!file || file.startsWith('<')) { return null; }
  const frame: StackFrame = { file };
  const line = p.line !== undefined ? Number(m[p.line]) : NaN;
  const column = p.column !== undefined ? Number(m[p.column]) : NaN;
  if (Number.isFinite(line)) { frame.line = line; }
  if (Number.isFinite(column)) { frame.column = column; }
  const symbol = p.symbol !== undefined ? m[p.symbol]?.trim() : undefined;
  if (symbol) { frame.symbol = symbol; }
  return frame;
}

function collectFrames(lines: string[], origin: ErrorOrigin): StackFrame[] {
  const patterns = [...FRAME_PATTERNS.filter(p => p.origin === origin), ...DIAGNOSTIC_PATTERNS];
  const frames: StackFrame[] = [];
  const seen = new Set<string>();

  const add = (frame: StackFrame | null) => {
    if (!frame) { return; }
    const key = `${frame.file}:${frame.line ?? ''}`;
    if (seen.has(key)) { return; }
    seen.add(key);
    frames.push(frame);
  };

  for (const line of lines) {
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (m) { add(toFrame(m, p)); break; }
    }
  }

  if (frames.length === 0) {
    for (const line of lines) {
      const m = LOOSE_FRAME.exec(line);
      if (m) { add({ file: m[1], line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) }); }
    }
  }

  return frames.slice(0, 12);
}

/** Paths that belong to a dependency, a runtime, or the language itself. */
const NOT_MINE = [
  /node_modules/, /(?:^|\/)internal\//, /^node:/, /site-packages/, /dist-packages/,
  /\/lib\/python[\d.]+\//, /(?:^|\/)vendor\//, /\.cargo[/\\]registry/, /\/usr\/(?:lib|local)\//,
  /(?:^|\/)runtime[/\\][\w.]+\.go$/, /^java\.|^javax\.|^jdk\.|^sun\./, /\/gems?\//, /\.gradle[/\\]caches/,
];

/**
 * Reorders frames so the ones in the user's own code come first. A trace often
 * starts several layers deep inside a framework; the frame worth reading source
 * for is the first one that is not.
 */
export function rankFrames(frames: StackFrame[]): StackFrame[] {
  const mine: StackFrame[] = [];
  const theirs: StackFrame[] = [];
  for (const frame of frames) {
    (NOT_MINE.some(re => re.test(frame.file)) ? theirs : mine).push(frame);
  }
  return [...mine, ...theirs];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function buildHeadline(type: string | undefined, message: string): string {
  const joined = type && message ? `${type}: ${message}` : (type ?? message);
  const oneLine = joined.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? oneLine.slice(0, 117) + '…' : oneLine;
}

/**
 * Reads captured output into a {@link ParsedError}, or returns null when the
 * text carries no sign of a failure at all — a clean build, a passing test run.
 */
export function parseError(raw: string, source: ErrorSource): ParsedError | null {
  const text = extractErrorBlock(raw, 200);
  if (!text) { return null; }

  const lines = text.split('\n');
  const origin = detectOrigin(text);
  const frames = collectFrames(lines, origin);
  const { type, message } = findHeadline(lines, origin);

  if (!type && frames.length === 0 && !lines.some(isSignalLine)) { return null; }

  return { source, origin, type, message, headline: buildHeadline(type, message), frames, text };
}

/** How a parsed failure is labelled in a picker or a chat bubble. */
export function describeError(error: ParsedError): string {
  const where = rankFrames(error.frames)[0];
  if (!where) { return error.headline; }
  const name = where.file.split(/[\\/]/).pop() ?? where.file;
  return `${error.headline} — ${name}${where.line ? ':' + where.line : ''}`;
}
