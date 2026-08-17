import * as vscode from 'vscode';

/**
 * formatter.ts
 *
 * Responsible for taking raw LLM completion text and producing a perfectly
 * formatted string that:
 *  1. Uses the file's detected indent style (tabs vs spaces, N spaces)
 *  2. Aligns to the cursor's current column (base indent)
 *  3. Preserves relative indent levels within the completion itself
 *  4. Adds/removes blank lines to match the surrounding code rhythm
 *  5. Strips all LLM artefacts (fences, preambles, trailing commentary)
 */

// ─── Indent detection ─────────────────────────────────────────────────────────

export interface IndentStyle {
  useTabs: boolean;
  tabSize: number;          // the editor tab size setting
  unit: string;             // one indent level: '\t' or '  ' or '    ' etc.
}

/**
 * Detect the dominant indent style from the document content.
 * Falls back to editor settings if the document doesn't have enough lines.
 */
export function detectIndentStyle(
  document: vscode.TextDocument,
  editor: vscode.TextEditor
): IndentStyle {
  const tabSize    = editor.options.tabSize as number ?? 4;
  const insertSpaces = editor.options.insertSpaces as boolean ?? true;

  // Sample up to 200 lines
  const sampleSize = Math.min(document.lineCount, 200);
  let tabCount = 0;
  let spaceCount = 0;
  const spaceSizes: Record<number, number> = {};

  for (let i = 0; i < sampleSize; i++) {
    const line = document.lineAt(i).text;
    if (!line.trim()) { continue; }

    const leadingTabs   = line.match(/^\t+/)?.[0].length ?? 0;
    const leadingSpaces = line.match(/^ +/)?.[0].length ?? 0;

    if (leadingTabs > 0) {
      tabCount++;
    } else if (leadingSpaces > 0) {
      spaceCount++;
      // Record the size of this indent run
      spaceSizes[leadingSpaces] = (spaceSizes[leadingSpaces] ?? 0) + 1;
    }
  }

  if (tabCount > spaceCount) {
    return { useTabs: true, tabSize, unit: '\t' };
  }

  // Find the smallest recurring space indent size (likely = 1 indent level)
  let detectedSize = tabSize;
  const sizes = Object.keys(spaceSizes).map(Number).sort((a, b) => a - b);
  for (const sz of sizes) {
    if (sz >= 2 && sz <= 8 && (spaceSizes[sz] ?? 0) >= 3) {
      detectedSize = sz;
      break;
    }
  }

  // If VS Code says "no insert spaces" trust it over heuristic
  if (!insertSpaces) {
    return { useTabs: true, tabSize, unit: '\t' };
  }

  return { useTabs: false, tabSize: detectedSize, unit: ' '.repeat(detectedSize) };
}

// ─── Base indent at cursor ────────────────────────────────────────────────────

/**
 * Return the whitespace prefix of the cursor line (or the line above if cursor
 * is on a blank line). This is the "base indent" the completion must align to.
 */
export function getBaseIndent(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const safeLine = Math.max(0, Math.min(position.line, document.lineCount - 1));

  // If current line is blank/whitespace-only, look at the last non-blank line
  for (let i = safeLine; i >= 0; i--) {
    const text = document.lineAt(i).text;
    if (text.trim().length > 0) {
      return text.match(/^(\s*)/)?.[1] ?? '';
    }
  }
  return '';
}

// ─── Surrounding blank-line rhythm ───────────────────────────────────────────

interface BlankLineContext {
  /** true if there's a blank line immediately before the cursor position */
  blankBefore: boolean;
  /** true if there's a blank line immediately after the cursor position */
  blankAfter: boolean;
  /** true if methods in this file are separated by blank lines */
  methodsHaveBlankSeparators: boolean;
}

export function detectBlankLineContext(
  document: vscode.TextDocument,
  position: vscode.Position
): BlankLineContext {
  const safeLine = Math.max(0, Math.min(position.line, document.lineCount - 1));

  const blankBefore = safeLine > 0
    ? document.lineAt(safeLine - 1).text.trim() === ''
    : false;
  const blankAfter  = safeLine < document.lineCount - 1
    ? document.lineAt(safeLine + 1).text.trim() === ''
    : false;

  // Heuristic: scan up to 100 lines looking for paired "}" + blank + non-blank
  let blankSeparatorCount = 0;
  let totalTransitions    = 0;
  for (let i = 1; i < Math.min(document.lineCount - 1, 100); i++) {
    const prev = document.lineAt(i - 1).text.trim();
    const curr = document.lineAt(i).text.trim();
    const next = i + 1 < document.lineCount ? document.lineAt(i + 1).text.trim() : '';
    if (prev === '}' && curr === '' && next !== '') {
      blankSeparatorCount++;
    }
    if (prev === '}' && curr !== '') {
      totalTransitions++;
    }
  }
  const methodsHaveBlankSeparators = blankSeparatorCount > totalTransitions * 0.4;

  return { blankBefore, blankAfter, methodsHaveBlankSeparators };
}

// ─── Core formatter ───────────────────────────────────────────────────────────

/**
 * Take raw LLM output and return a perfectly formatted completion string
 * ready to be inserted at `position`.
 *
 * Steps:
 *  1. Strip LLM artefacts
 *  2. Detect the completion's own minimum indent (to normalise it)
 *  3. Re-indent every line to: baseIndent + (relativeIndentLevels * indentUnit)
 *  4. Adjust leading/trailing blank lines to match surrounding rhythm
 *  5. Ensure the first line aligns with what's already on the cursor line
 */
export function formatCompletion(
  raw: string,
  document: vscode.TextDocument,
  position: vscode.Position,
  indentStyle: IndentStyle
): string {
  // ── Step 1: strip artefacts ───────────────────────────────────────────────
  let text = stripArtefacts(raw);
  if (!text) { return ''; }

  const baseIndent = getBaseIndent(document, position);
  const blankCtx   = detectBlankLineContext(document, position);

  // ── Step 2: split into lines and find minimum indent ─────────────────────
  const lines = text.split('\n');

  // Normalise CRLF
  const normLines = lines.map(l => l.replace(/\r$/, ''));

  // Find the smallest indent among non-blank lines in the completion
  const nonBlank = normLines.filter(l => l.trim().length > 0);
  if (nonBlank.length === 0) { return ''; }

  // Count leading whitespace chars (tabs count as tabSize spaces for comparison)
  const minIndentLen = nonBlank.reduce((min, l) => {
    const leading = l.match(/^(\s*)/)?.[1] ?? '';
    const len = measureIndent(leading, indentStyle.tabSize);
    return Math.min(min, len);
  }, Infinity);

  // ── Step 3: re-indent each line ───────────────────────────────────────────
  const baseLen = measureIndent(baseIndent, indentStyle.tabSize);

  const reindented = normLines.map((line, idx) => {
    if (line.trim() === '') {
      // Preserve blank lines as truly blank (no trailing whitespace)
      return '';
    }
    const leading    = line.match(/^(\s*)/)?.[1] ?? '';
    const lineIndent = measureIndent(leading, indentStyle.tabSize);
    const relativeLevel = Math.max(0, lineIndent - minIndentLen);

    // For the first line: don't add baseIndent because VS Code places the
    // cursor at the insertion point which already has the base indent.
    // For subsequent lines: prepend the full base indent.
    const targetLen  = idx === 0 ? relativeLevel : baseLen + relativeLevel;
    const newLeading = buildIndent(targetLen, indentStyle);
    return newLeading + line.trimStart();
  });

  // ── Step 4: blank line handling ───────────────────────────────────────────
  // If the completion is a method/function and surrounding code uses blank
  // separators, ensure there's a blank line before (but only if cursor line
  // itself isn't already blank).
  const completionIsBlock = isBlockLevelCompletion(reindented);

  let result = reindented;

  if (completionIsBlock && blankCtx.methodsHaveBlankSeparators && !blankCtx.blankBefore) {
    // Prepend a blank line before the block
    result = ['', ...result];
  }

  if (completionIsBlock && blankCtx.methodsHaveBlankSeparators && !blankCtx.blankAfter) {
    // Append a blank line after the block
    result = [...result, ''];
  }

  // ── Step 5: trim trailing blank lines ────────────────────────────────────
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }
  // Remove leading blank lines (cursor position handles placement)
  while (result.length > 0 && result[0].trim() === '') {
    result.shift();
  }

  if (result.length === 0) { return ''; }

  return result.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip LLM output artefacts exhaustively */
export function stripArtefacts(text: string): string {
  return text
    // Code fences with or without language tag
    .replace(/^```[\w]*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
    // Common preamble patterns
    .replace(/^(Here'?s?( is)?( the)?( completion| code| suggestion)?[:\-]?\s*\n?)/i, '')
    .replace(/^Completion(\s*\(new code only\))?:\s*\n?/i, '')
    .replace(/^Result:\s*\n?/i, '')
    .replace(/^Output:\s*\n?/i, '')
    // Trailing commentary after the code
    .replace(/\n+\/\/\s*(Note|TODO|This|The above|I've|Feel free).*$/gi, '')
    .trimEnd();
}

/** Measure the visual width of a leading whitespace string */
function measureIndent(leading: string, tabSize: number): number {
  let n = 0;
  for (const ch of leading) {
    if (ch === '\t') { n += tabSize; }
    else { n++; }
  }
  return n;
}

/** Build a leading-whitespace string of `targetLen` visual columns */
function buildIndent(targetLen: number, style: IndentStyle): string {
  if (targetLen <= 0) { return ''; }
  if (style.useTabs) {
    const tabs   = Math.floor(targetLen / style.tabSize);
    const spaces = targetLen % style.tabSize;
    return '\t'.repeat(tabs) + ' '.repeat(spaces);
  }
  return ' '.repeat(targetLen);
}

/** Heuristic: does the completion look like a block-level item (method, class, etc.)? */
function isBlockLevelCompletion(lines: string[]): boolean {
  if (lines.length < 2) { return false; }
  const first = lines[0].trim();
  return /^(function|async\s+function|class|interface|enum|def\s|fn\s|pub\s|private\s|public\s|protected\s|static\s|override\s|(get|set)\s+\w)/.test(first)
    || lines.some(l => l.trimEnd().endsWith('{') || l.trimEnd().endsWith(':'));
}
