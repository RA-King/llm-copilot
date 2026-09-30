import { SuggestionShape } from './intentInference';

/**
 * suggestionGate.ts
 *
 * The one place that answers "may ghost text appear here, and how much of it".
 *
 * Ghost text is intrusive by construction: it is unasked-for text on the
 * screen, in the middle of writing, and it replaces a range of the document if
 * accepted. Everything that makes it tolerable is a refusal — it does not show
 * over code the author has already written, it does not show mid-word, it does
 * not show again the moment after it was dismissed, and it does not run on
 * past the thought it was completing.
 *
 * Those refusals used to live scattered across the provider and the debouncer,
 * which meant the two disagreed: the debouncer would fire a trigger the
 * provider then declined, and the provider would occasionally serve a
 * suggestion from a cursor the debouncer had already written off. Both now ask
 * the same function, so a suggestion appears only where both would allow it.
 *
 * The rules, in the order they are applied:
 *
 *   1. Nothing while text is selected, or with more than one cursor.
 *   2. Nothing when the last edit was not the author typing forward at the
 *      cursor — deletions, undo and paste all suppress.
 *   3. Nothing when real code follows the cursor on the line. Closing
 *      delimiters and whitespace do not count as real code, because finishing
 *      an argument list inside its own brackets is the normal case.
 *   4. Nothing inside a string literal or a comment.
 *   5. Nothing until an identifier being typed is long enough to be worth
 *      guessing at, and nothing immediately after a member-access dot, where
 *      the editor's own completion list is the better answer.
 *   6. Nothing on a line the author has already dismissed a suggestion on,
 *      until they have typed enough to make it a different question.
 *   7. Block-sized suggestions only where a block genuinely belongs.
 *
 * Everything here is pure: the caller passes facts, the gate returns a verdict.
 */

// ─── Verdict ──────────────────────────────────────────────────────────────────

export interface GateInput {
  language: string;
  /** Text on the cursor's line before the cursor. */
  linePrefix: string;
  /** Text on the cursor's line after the cursor. */
  lineSuffix: string;
  /** The line directly above, trimmed; '' at the top of the file. */
  previousLine: string;
  /** What the cursor position calls for, from `intentInference`. */
  shape: SuggestionShape;
  /** False when the editor has a selection or more than one cursor. */
  singleEmptyCursor: boolean;
  /** True when the last document change inserted text at the cursor. */
  typingForward: boolean;
  /** True when the author has dismissed a suggestion at this line recently. */
  recentlyDismissed: boolean;
  /** Ceilings from settings. */
  limits: GateLimits;
}

export interface GateLimits {
  statementLines: number;
  blockLines: number;
  /** Fewest characters of a fresh identifier before a suggestion is worth it. */
  minIdentifierChars: number;
}

export const DEFAULT_LIMITS: GateLimits = {
  statementLines: 3,
  blockLines: 12,
  minIdentifierChars: 2,
};

export type GateVerdict =
  | { show: false; reason: string }
  | { show: true; shape: SuggestionShape; maxLines: number };

// ─── The gate ─────────────────────────────────────────────────────────────────

/** Characters that may follow the cursor without the suggestion being intrusive. */
const HARMLESS_SUFFIX = /^[\s)\]}>,;:'"`]*$/;

export function evaluateGate(input: GateInput): GateVerdict {
  const { linePrefix, lineSuffix, shape, limits } = input;

  if (!input.singleEmptyCursor) {
    return { show: false, reason: 'a selection or a second cursor is active' };
  }

  if (!input.typingForward) {
    return { show: false, reason: 'the last edit was not forward typing' };
  }

  // Rule 3 — the author's own text after the cursor is never written over.
  if (!HARMLESS_SUFFIX.test(lineSuffix)) {
    return { show: false, reason: 'code follows the cursor on this line' };
  }

  // Rule 4 — a half-open quote or an unterminated comment means the cursor is
  // inside prose, where a code completion is noise.
  if (inStringOrComment(linePrefix, input.language)) {
    return { show: false, reason: 'the cursor is inside a string or a comment' };
  }

  if (input.recentlyDismissed) {
    return { show: false, reason: 'a suggestion was dismissed here' };
  }

  // Rule 5 — leave the short prefixes to the editor's own completion list,
  // which is instant, exact, and already on screen.
  const tail = trailingIdentifier(linePrefix);
  if (tail.afterMemberAccess && tail.identifier.length < limits.minIdentifierChars) {
    return { show: false, reason: 'the editor’s own completion list covers this' };
  }
  if (!tail.afterMemberAccess
      && tail.identifier.length > 0
      && tail.identifier.length < limits.minIdentifierChars
      && linePrefix.trim() === tail.identifier) {
    return { show: false, reason: 'too little typed to guess from' };
  }

  // Rule 7 — a block belongs only where one was just opened. Anywhere else, a
  // block-sized answer is the model writing the rest of the function.
  const effectiveShape: SuggestionShape =
    shape === 'block' && !opensBlock(input.previousLine, input.language) ? 'statement' : shape;

  return { show: true, shape: effectiveShape, maxLines: lineBudget(effectiveShape, limits) };
}

export function lineBudget(shape: SuggestionShape, limits: GateLimits): number {
  switch (shape) {
    case 'expression': return 1;
    case 'statement': return Math.max(1, limits.statementLines);
    case 'block': return Math.max(1, limits.blockLines);
  }
}

// ─── Reading the line ─────────────────────────────────────────────────────────

/**
 * Whether the cursor sits inside a string or a comment, judged from the line
 * prefix alone. A multi-line string will read as closed and a multi-line
 * comment as absent, both of which fail open — the suggestion still has to get
 * past the duplication guard and the structural validator downstream.
 */
export function inStringOrComment(prefix: string, language: string): boolean {
  const lineComment = LINE_COMMENT[language] ?? '//';
  let quote: string | null = null;
  let blockComment = false;

  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    const rest = prefix.slice(i);

    if (blockComment) {
      if (rest.startsWith('*/')) { blockComment = false; i++; }
      continue;
    }

    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) { quote = null; }
      continue;
    }

    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; continue; }
    if (rest.startsWith('/*')) { blockComment = true; i++; continue; }
    if (rest.startsWith(lineComment)) { return true; }
    if (language === 'python' && ch === '#') { return true; }
  }

  return quote !== null || blockComment;
}

const LINE_COMMENT: Record<string, string> = {
  python: '#', ruby: '#', shellscript: '#', yaml: '#', perl: '#', r: '#',
  lua: '--', sql: '--', haskell: '--',
};

/** The identifier the cursor is in the middle of, and how it was reached. */
export function trailingIdentifier(prefix: string): {
  identifier: string;
  afterMemberAccess: boolean;
} {
  const m = /([A-Za-z_$][\w$]*)?$/.exec(prefix);
  const identifier = m?.[1] ?? '';
  const before = prefix.slice(0, prefix.length - identifier.length);
  return { identifier, afterMemberAccess: /(?:\.|->|::|\?\.)\s*$/.test(before) };
}

/** Does the line above open a body the cursor is now inside the top of? */
export function opensBlock(previousLine: string, language: string): boolean {
  const line = previousLine.trim();
  if (!line) { return false; }
  if (/[{([]$/.test(line)) { return true; }
  if (language === 'python' || language === 'yaml') { return /:$/.test(line); }
  if (language === 'ruby') { return /\b(do|then)$/.test(line) || /\b(def|class|module)\b/.test(line); }
  if (language === 'go' || language === 'rust') { return /\{$/.test(line); }
  return false;
}

// ─── Trimming to the budget ───────────────────────────────────────────────────

/**
 * Cut a suggestion down to `maxLines` without leaving it unbalanced. Truncating
 * mid-block would produce text that cannot be accepted, so the cut is taken at
 * the last line where every delimiter opened inside the snippet is closed
 * again; if no such line exists inside the budget the whole thing is refused.
 */
export function trimToBudget(text: string, maxLines: number): string | null {
  const lines = text.split('\n');
  if (lines.length <= maxLines) { return text; }

  let depth = 0;
  let lastBalanced = -1;

  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    depth += delimiterDelta(lines[i]);
    if (depth <= 0) { lastBalanced = i; }
  }

  if (lastBalanced < 0) { return null; }
  return lines.slice(0, lastBalanced + 1).join('\n').trimEnd();
}

function delimiterDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') { i++; }
      else if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') { delta++; }
    else if (ch === '}' || ch === ')' || ch === ']') { delta--; }
  }
  return delta;
}

// ─── Dismissal memory ─────────────────────────────────────────────────────────

/**
 * What the author has already said no to.
 *
 * Re-offering a suggestion the moment after it was dismissed is the single
 * most irritating thing an inline completion can do, and it happens easily:
 * pressing Escape does not change the document, so every heuristic that keys
 * on the document still thinks a suggestion belongs. The memory holds the
 * line, and releases it once the line has changed enough to be a different
 * question — or after a timeout, so a dismissal never becomes permanent.
 */
export class DismissalMemory {
  private entries = new Map<string, { prefix: string; at: number }>();

  constructor(
    private readonly ttlMs = 30_000,
    /** Characters of new typing that make it a fresh question. */
    private readonly releaseAfterChars = 6
  ) {}

  record(uri: string, line: number, linePrefix: string): void {
    this.entries.set(key(uri, line), { prefix: linePrefix, at: Date.now() });
    this.evict();
  }

  /** Has this cursor been dismissed, and not yet typed past? */
  isDismissed(uri: string, line: number, linePrefix: string): boolean {
    const entry = this.entries.get(key(uri, line));
    if (!entry) { return false; }

    if (Date.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key(uri, line));
      return false;
    }

    // Typing on past what was refused makes it a new question; deleting back
    // behind it does too, since the author is visibly rewriting the line.
    if (!linePrefix.startsWith(entry.prefix)) {
      this.entries.delete(key(uri, line));
      return false;
    }
    if (linePrefix.length - entry.prefix.length >= this.releaseAfterChars) {
      this.entries.delete(key(uri, line));
      return false;
    }

    return true;
  }

  clear(uri?: string): void {
    if (!uri) { this.entries.clear(); return; }
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(uri + '|')) { this.entries.delete(k); }
    }
  }

  private evict(): void {
    if (this.entries.size < 64) { return; }
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.entries) {
      if (v.at < cutoff) { this.entries.delete(k); }
    }
  }
}

function key(uri: string, line: number): string { return `${uri}|${line}`; }

// ─── Typing state ─────────────────────────────────────────────────────────────

/**
 * Whether the author is typing forward, as opposed to deleting, undoing or
 * pasting. Ghost text after a deletion is the worst case for intrusiveness:
 * the author is removing something, and the editor answers by proposing more.
 */
export class TypingTracker {
  private lastInsertAt = 0;
  private lastWasInsert = false;

  /** Called for every document change. */
  note(change: { insertedLength: number; removedLength: number }): void {
    this.lastWasInsert = change.insertedLength > 0 && change.removedLength === 0;
    if (this.lastWasInsert) { this.lastInsertAt = Date.now(); }
  }

  /** True while the most recent change was an insertion, and it was recent. */
  isTypingForward(windowMs = 5_000): boolean {
    return this.lastWasInsert && Date.now() - this.lastInsertAt < windowMs;
  }

  /** An explicit invoke (Alt+\) counts as intent regardless of the last edit. */
  noteExplicitInvoke(): void {
    this.lastWasInsert = true;
    this.lastInsertAt = Date.now();
  }

  reset(): void {
    this.lastWasInsert = false;
    this.lastInsertAt = 0;
  }
}

// ─── Latency-led debounce ─────────────────────────────────────────────────────

/**
 * How long to wait before asking, given how fast the answers have been coming.
 *
 * A fixed debounce is a guess at a number that depends entirely on the model
 * behind it. A local 1B model answers in 120ms, where waiting 600ms first is
 * most of the latency the author feels; a hosted frontier model takes two
 * seconds, where firing early just burns requests on cursors the author has
 * already moved off. Measuring removes the guess.
 *
 * The median is used rather than the mean because one cold start should not
 * move the setting for the rest of the session.
 */
export class AdaptiveDebounce {
  private samples: number[] = [];
  private readonly window = 12;

  constructor(
    private floorMs = 150,
    private ceilingMs = 600
  ) {}

  configure(floorMs: number, ceilingMs: number): void {
    this.floorMs = Math.max(0, floorMs);
    this.ceilingMs = Math.max(this.floorMs, ceilingMs);
  }

  /** Record one completed round trip, in milliseconds. */
  observe(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) { return; }
    this.samples.push(latencyMs);
    if (this.samples.length > this.window) { this.samples.shift(); }
  }

  /**
   * The wait to use now. With no measurements yet the configured ceiling
   * stands; once the model has shown itself to be fast, the wait drops towards
   * the floor in proportion, so the author sees suggestions sooner without the
   * request rate rising on a slow backend.
   */
  currentMs(): number {
    if (this.samples.length < 3) { return this.ceilingMs; }
    const median = [...this.samples].sort((a, b) => a - b)[Math.floor(this.samples.length / 2)];

    // A model that answers in under a quarter of the ceiling has earned the
    // floor; anything slower scales linearly back up to it.
    const quick = this.ceilingMs / 4;
    if (median <= quick) { return this.floorMs; }
    const ratio = Math.min(1, (median - quick) / (this.ceilingMs - quick || 1));
    return Math.round(this.floorMs + ratio * (this.ceilingMs - this.floorMs));
  }

  /** Median observed latency, for the status bar. */
  medianMs(): number {
    if (this.samples.length === 0) { return 0; }
    return [...this.samples].sort((a, b) => a - b)[Math.floor(this.samples.length / 2)];
  }

  reset(): void { this.samples = []; }
}

// ─── Typing through a suggestion ──────────────────────────────────────────────

/**
 * The cheapest suggestion is the one already on screen.
 *
 * When the author types the characters a suggestion was proposing, the honest
 * answer to the next request is the rest of that same suggestion — and it can
 * be given with no round trip at all. Without this, every keystroke through a
 * suggestion re-asks the model, which both costs the latency and risks the
 * answer changing under the author's hands mid-word.
 */
export class ContinuationCache {
  private entry: {
    uri: string; line: number; prefix: string; remaining: string; at: number;
  } | null = null;

  constructor(private readonly ttlMs = 45_000) {}

  remember(uri: string, line: number, linePrefix: string, suggestion: string): void {
    this.entry = { uri, line, prefix: linePrefix, remaining: suggestion, at: Date.now() };
  }

  /**
   * The unsaid remainder, if what the author has typed since is exactly the
   * head of what was suggested. Returns null the moment they diverge.
   */
  continuation(uri: string, line: number, linePrefix: string): string | null {
    const entry = this.entry;
    if (!entry) { return null; }
    if (entry.uri !== uri || entry.line !== line) { return null; }
    if (Date.now() - entry.at >= this.ttlMs) { this.entry = null; return null; }
    if (!linePrefix.startsWith(entry.prefix)) { this.entry = null; return null; }

    const typed = linePrefix.slice(entry.prefix.length);
    if (typed.length === 0) { return entry.remaining; }
    if (!entry.remaining.startsWith(typed)) { this.entry = null; return null; }

    const remaining = entry.remaining.slice(typed.length);
    if (!remaining.trim()) { this.entry = null; return null; }
    return remaining;
  }

  clear(): void { this.entry = null; }
}
