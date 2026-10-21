import { ChatMessage } from './llmProvider';
import { numberLines } from './codeReview';
import { LineEdit } from './editHistory';

/**
 * Next edit suggestions: from the edits just made, predict the one that comes
 * next — the other uses of a renamed variable, the call site of a function
 * that just gained a parameter, the matching branch of a switch — anywhere in
 * the file, not only at the cursor.
 *
 * The model answers with one search/replace block. Quoting the text to change
 * rather than giving line numbers or offsets is what keeps the answer
 * applicable when the model miscounts.
 */

export interface NextEditRequest {
  language: string;
  file: string;
  /** EditHistory.render() — the recent edits, oldest first. */
  history: string;
  /** The part of the file shown to the model, and the one-based line it starts on. */
  window: string;
  windowStart: number;
  /** One-based. */
  cursorLine: number;
}

export function buildNextEditPrompt(req: NextEditRequest): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You predict the next edit a developer will make to a ${req.language} file, from the edits they just made. ` +
        'Look for the edit that the recent ones make necessary or obvious: the remaining uses of something ' +
        'renamed, a call that must change because a signature changed, the same change applied to sibling ' +
        'code, an import the new code needs. Do not repeat or undo an edit already made, and do not invent ' +
        'new features.\n\n' +
        'Reply with exactly one block in this form, copying the lines to change exactly as they appear ' +
        '(without the line numbers), and with enough of them to be unique in the file:\n' +
        '<<<<<<< SEARCH\n' +
        'lines as they are now\n' +
        '=======\n' +
        'the same lines after the edit\n' +
        '>>>>>>> REPLACE\n\n' +
        'If no further edit clearly follows from the recent ones, reply with exactly: NONE',
    },
    {
      role: 'user',
      content:
        `File: ${req.file}\n\nRecent edits, oldest first:\n${req.history}\n\n` +
        `The file around the cursor (line ${req.cursorLine}):\n${numberLines(req.window, req.windowStart)}`,
    },
  ];
}

export interface SearchReplace {
  search: string;
  replace: string;
}

/** The block from a reply, or undefined for NONE or anything unreadable. */
export function parseNextEdit(reply: string): SearchReplace | undefined {
  const m = /<{5,}\s*SEARCH[^\n]*\n([\s\S]*?)\n?={5,}[^\n]*\n([\s\S]*?)\n?>{5,}\s*REPLACE/.exec(reply.replace(/\r\n/g, '\n'));
  if (!m) { return undefined; }
  // Numbered lines quoted back despite the instruction.
  const strip = (s: string) => s.split('\n').every(l => /^\s*\d+ \| /.test(l) || !l.trim())
    ? s.split('\n').map(l => l.replace(/^\s*\d+ \| /, '')).join('\n')
    : s;
  const search = strip(m[1]);
  const replace = strip(m[2]);
  if (!search.trim() || search === replace) { return undefined; }
  return { search, replace };
}

export interface LocatedEdit {
  /** Offsets into the document text. */
  start: number;
  end: number;
  replace: string;
}

/**
 * Where the quoted text is, choosing the occurrence nearest the cursor when it
 * appears more than once. Falls back to matching with trailing whitespace
 * ignored, the most common way a model's quote differs from the file.
 */
export function locateEdit(text: string, edit: SearchReplace, cursorOffset: number): LocatedEdit | undefined {
  const exact = occurrences(text, edit.search);
  if (exact.length) {
    const start = nearest(exact, cursorOffset);
    return { start, end: start + edit.search.length, replace: edit.replace };
  }

  const lines = text.split('\n');
  const wanted = edit.search.split('\n').map(l => l.trimEnd());
  const starts: number[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (wanted.every((w, j) => lines[i + j].trimEnd() === w)) { starts.push(i); }
  }
  if (!starts.length) { return undefined; }
  const line = starts.map(i => offsets[i]).reduce((best, o) =>
    Math.abs(o - cursorOffset) < Math.abs(best - cursorOffset) ? o : best);
  const first = offsets.indexOf(line);
  const lastLine = first + wanted.length - 1;
  return { start: line, end: offsets[lastLine] + lines[lastLine].length, replace: edit.replace };
}

function occurrences(text: string, search: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(search); at >= 0; at = text.indexOf(search, at + 1)) { found.push(at); }
  return found;
}

function nearest(offsets: number[], target: number): number {
  return offsets.reduce((best, o) => Math.abs(o - target) < Math.abs(best - target) ? o : best);
}

/**
 * True when applying the edit would put back what the last edit took away —
 * a model "fixing" the change the developer just made.
 */
export function revertsLastEdit(edit: SearchReplace, last: LineEdit | undefined): boolean {
  if (!last) { return false; }
  const before = last.before.join('\n');
  const after = last.after.join('\n');
  return edit.search.trim() !== '' &&
    after.includes(edit.search.trim()) && before.includes(edit.replace.trim()) &&
    edit.replace.trim() !== '';
}

/** The changed part of a located edit, for display: what goes and what comes. */
export function trimEdit(text: string, edit: LocatedEdit): LocatedEdit {
  const old = text.slice(edit.start, edit.end);
  let head = 0;
  while (head < old.length && head < edit.replace.length && old[head] === edit.replace[head]) { head++; }
  let tail = 0;
  while (tail < old.length - head && tail < edit.replace.length - head &&
    old[old.length - 1 - tail] === edit.replace[edit.replace.length - 1 - tail]) { tail++; }
  return {
    start: edit.start + head,
    end: edit.end - tail,
    replace: edit.replace.slice(head, edit.replace.length - tail),
  };
}
