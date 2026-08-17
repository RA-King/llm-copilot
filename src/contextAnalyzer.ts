import * as vscode from 'vscode';
import { analyseStructure, StructureContext } from './structureAnalyzer';

export type CursorIntent =
  | 'new-block' | 'new-statement' | 'new-line-after-complete'
  | 'completing-started' | 'inside-existing' | 'refactor-candidate' | 'ambiguous';

export interface CursorContext {
  intent: CursorIntent;
  isNewLine: boolean;
  prevLineComplete: boolean;
  currentLinePrefix: string;
  currentLineTrimmed: string;
  charsAfterCursor: number;
  nestingDepth: number;
  structure: StructureContext;
}

const COMPLETE_STATEMENT = /[;{})\]]\s*$|^\s*$|^\s*(return|break|continue|throw)\b/;
const OPENS_SCOPE = /[{(:]\s*$/;
const FRESH_TOKEN = /^\s{0,8}([a-zA-Z_$][a-zA-Z0-9_$]{0,20}|\/\/|#|\/\*)$/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--|$)/;

export function analyseCursorContext(
  document: vscode.TextDocument,
  position: vscode.Position
): CursorContext {
  // ── Guard: clamp position to document bounds ────────────────────────────
  if (document.lineCount === 0) {
    const empty = analyseStructure(document, position);
    return { intent: 'ambiguous', isNewLine: true, prevLineComplete: false,
      currentLinePrefix: '', currentLineTrimmed: '', charsAfterCursor: 0,
      nestingDepth: 0, structure: empty };
  }

  const safeLine = Math.max(0, Math.min(position.line, document.lineCount - 1));
  const lineText  = document.lineAt(safeLine).text;
  const safeChar  = Math.max(0, Math.min(position.character, lineText.length));

  const currentLinePrefix  = lineText.substring(0, safeChar);
  const currentLineTrimmed = lineText.trim();
  const charsAfterCursor   = lineText.length - safeChar;

  const lookback = 8;
  const prevLines: string[] = [];
  for (let i = Math.max(0, safeLine - lookback); i < safeLine; i++) {
    try { prevLines.push(document.lineAt(i).text); } catch { prevLines.push(''); }
  }
  const prevTrimmed  = prevLines.map(l => l.trim());
  const lastNonBlank = [...prevTrimmed].reverse().find(l => l.length > 0) ?? '';

  // Count brace depth from last 30 lines up to cursor
  const prefixStartLine = Math.max(0, safeLine - 30);
  let prefixText = '';
  try {
    prefixText = document.getText(
      new vscode.Range(prefixStartLine, 0, safeLine, safeChar)
    );
  } catch { prefixText = currentLinePrefix; }

  let depth = 0;
  for (const ch of prefixText) {
    if (ch === '{') { depth++; }
    else if (ch === '}') { depth = Math.max(0, depth - 1); }
  }

  const prevLineComplete = COMPLETE_STATEMENT.test(lastNonBlank) || OPENS_SCOPE.test(lastNonBlank);
  const isNewLine = currentLineTrimmed.length === 0 || currentLinePrefix.trim().length === 0;

  // Structural analysis — uses the already-clamped safeLine
  const safePosition = new vscode.Position(safeLine, safeChar);
  const structure = analyseStructure(document, safePosition);

  const make = (intent: CursorIntent): CursorContext => ({
    intent, isNewLine, prevLineComplete, currentLinePrefix,
    currentLineTrimmed, charsAfterCursor, nestingDepth: depth, structure,
  });

  if (charsAfterCursor > 2 && currentLinePrefix.trim().length > 2) { return make('inside-existing'); }
  if (!isNewLine && currentLinePrefix.trim().length > 15 && charsAfterCursor === 0) { return make('inside-existing'); }
  if (isNewLine) {
    if (depth === 0 && COMPLETE_STATEMENT.test(lastNonBlank)) { return make('new-block'); }
    if (depth > 0) { return make('new-statement'); }
    return make('new-block');
  }
  if (FRESH_TOKEN.test(currentLinePrefix)) { return make('completing-started'); }
  if (currentLinePrefix.trim().length <= 2) { return make('ambiguous'); }
  if (COMMENT_LINE.test(currentLinePrefix)) { return make('ambiguous'); }
  return make('refactor-candidate');
}

export function shouldSuggest(intent: CursorIntent): boolean {
  return intent === 'new-block' || intent === 'new-statement' ||
    intent === 'new-line-after-complete' || intent === 'completing-started';
}

export function isRefactorCandidate(intent: CursorIntent): boolean {
  return intent === 'refactor-candidate' || intent === 'inside-existing';
}
