/**
 * The edits made to one document recently, kept as before/after runs of
 * whole lines. This is what a next-edit prediction is read from: having
 * renamed `user` to `account` on one line, the next edit is very likely the
 * same rename a few lines down.
 *
 * Keystrokes in the same place merge into one entry, so typing a word is one
 * edit rather than six; an entry whose lines end up as they started — typed
 * and then deleted — disappears.
 */

export interface TextChange {
  /** Offset into the text as it was before this change. */
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export interface LineEdit {
  /** Zero-based line, in the document as it stands now, where the edit starts. */
  startLine: number;
  before: string[];
  after: string[];
}

function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { line++; }
  }
  return line;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

export class EditHistory {
  private text = '';
  private entries: LineEdit[] = [];

  constructor(private readonly limit = 6) {}

  /** Start over from this text, forgetting what came before. */
  reset(text: string): void {
    this.text = text;
    this.entries = [];
  }

  get current(): string { return this.text; }

  edits(): LineEdit[] {
    return this.entries.map(e => ({ ...e, before: [...e.before], after: [...e.after] }));
  }

  /** The most recent edit, or undefined. */
  last(): LineEdit | undefined {
    const e = this.entries[this.entries.length - 1];
    return e && { ...e, before: [...e.before], after: [...e.after] };
  }

  /**
   * Apply a batch of changes as the editor reports them. Changes in one batch
   * do not overlap and their offsets all refer to the text before the batch,
   * so they are applied from the end backwards.
   */
  apply(changes: readonly TextChange[]): void {
    const ordered = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
    for (const change of ordered) { this.applyOne(change); }
  }

  private applyOne(change: TextChange): void {
    const oldLines = this.text.split('\n');
    const cs = lineAt(this.text, change.rangeOffset);
    const ce = lineAt(this.text, change.rangeOffset + change.rangeLength);
    const removedBreaks = ce - cs;
    const addedBreaks = (change.text.match(/\n/g) ?? []).length;
    const delta = addedBreaks - removedBreaks;

    this.text = this.text.slice(0, change.rangeOffset) + change.text +
      this.text.slice(change.rangeOffset + change.rangeLength);
    const newLines = this.text.split('\n');

    const last = this.entries[this.entries.length - 1];
    const le = last ? last.startLine + last.after.length - 1 : -2;
    if (last && cs <= le + 1 && ce >= last.startLine - 1) {
      // Touches the lines the last edit produced: widen that edit to cover both.
      const us = Math.min(last.startLine, cs);
      const ue = Math.max(le, ce);
      last.before = [
        ...oldLines.slice(us, last.startLine),
        ...last.before,
        ...oldLines.slice(le + 1, ue + 1),
      ];
      last.after = newLines.slice(us, ue + delta + 1);
      last.startLine = us;
      if (sameLines(last.before, last.after)) { this.entries.pop(); }
      this.shift(ue, delta, last);
      return;
    }

    const entry: LineEdit = {
      startLine: cs,
      before: oldLines.slice(cs, ce + 1),
      after: newLines.slice(cs, ce + delta + 1),
    };
    this.shift(ce, delta, undefined);
    if (sameLines(entry.before, entry.after)) { return; }
    this.entries.push(entry);
    if (this.entries.length > this.limit) { this.entries.shift(); }
  }

  /** Keep older entries pointing at the right lines after lines above them moved. */
  private shift(afterLine: number, delta: number, except: LineEdit | undefined): void {
    if (delta === 0) { return; }
    for (const entry of this.entries) {
      if (entry !== except && entry.startLine > afterLine) { entry.startLine += delta; }
    }
  }

  /**
   * The edits as compact diffs, oldest first, with unchanged lines at either
   * end of each entry trimmed away.
   */
  render(): string {
    return this.entries.map(e => {
      let head = 0;
      while (head < e.before.length && head < e.after.length && e.before[head] === e.after[head]) { head++; }
      let tail = 0;
      while (tail < e.before.length - head && tail < e.after.length - head &&
        e.before[e.before.length - 1 - tail] === e.after[e.after.length - 1 - tail]) { tail++; }
      const removed = e.before.slice(head, e.before.length - tail).map(l => `- ${l}`);
      const added = e.after.slice(head, e.after.length - tail).map(l => `+ ${l}`);
      return [`@@ line ${e.startLine + head + 1}`, ...removed, ...added].join('\n');
    }).join('\n');
  }
}
