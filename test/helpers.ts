/**
 * Shared test helpers: fake vscode.TextDocument / TextEditor / Position that
 * implement just enough of the API for the functions under test.
 */
import { Position } from './__mocks__/vscode';

export interface FakeDocument {
  languageId: string;
  lineCount: number;
  lineAt(line: number): { text: string; lineNumber: number };
  getText(range?: { start: Position; end: Position }): string;
}

/**
 * Build a fake TextDocument from a string of source code.
 * `getText(range)` returns the substring spanned by the range's positions.
 */
export function makeDocument(text: string, languageId = 'typescript'): FakeDocument {
  const lines = text.split('\n');
  return {
    languageId,
    lineCount: lines.length,
    lineAt(line: number) {
      if (line < 0 || line >= lines.length) {
        throw new Error(`lineAt out of range: ${line} (lineCount=${lines.length})`);
      }
      return { text: lines[line], lineNumber: line };
    },
    getText(range?: { start: Position; end: Position }): string {
      if (!range) {
        return text;
      }
      const { start, end } = range;
      if (start.line === end.line) {
        return (lines[start.line] ?? '').substring(start.character, end.character);
      }
      const parts: string[] = [];
      parts.push((lines[start.line] ?? '').substring(start.character));
      for (let i = start.line + 1; i < end.line; i++) {
        parts.push(lines[i] ?? '');
      }
      parts.push((lines[end.line] ?? '').substring(0, end.character));
      return parts.join('\n');
    },
  };
}

/** Build a fake TextEditor exposing just the `options` used by the formatter. */
export function makeEditor(opts: { tabSize?: number; insertSpaces?: boolean } = {}) {
  return {
    options: {
      tabSize: opts.tabSize ?? 4,
      insertSpaces: opts.insertSpaces ?? true,
    },
  };
}

/**
 * Convenience Position factory. Returns `any` because the functions under test
 * are typed against the real `@types/vscode` Position (which has extra methods);
 * the mock only needs `.line` / `.character` at runtime.
 */
export function pos(line: number, character: number): any {
  return new Position(line, character);
}
