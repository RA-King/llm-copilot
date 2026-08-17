import * as vscode from 'vscode';
import { chat, ChatMessage } from './llmProvider';

// ─── Pending doc-comment state ────────────────────────────────────────────────
//
// When the LLM generates a doc comment, we do NOT apply it immediately.
// Instead we store it here and return it from the InlineCompletionProvider
// as native ghost text. The user Tab-accepts or Escape-dismisses — exactly
// the same UX as Copilot inline suggestions.
//
export interface PendingDocComment {
  uri:        string;   // document URI
  line:       number;   // trigger line (the // or /** line)
  formatted:  string;   // full formatted comment text
  declName:   string;   // for status bar label
}

let _pendingDocComment: PendingDocComment | null = null;

export function getPendingDocComment(): PendingDocComment | null {
  return _pendingDocComment;
}

export function clearPendingDocComment(): void {
  _pendingDocComment = null;
}

function setPendingDocComment(p: PendingDocComment): void {
  _pendingDocComment = p;
}

// ─── Declaration detection ────────────────────────────────────────────────────

export type DeclarationKind =
  | 'function' | 'method' | 'class' | 'interface' | 'struct'
  | 'enum' | 'type' | 'variable' | 'constant' | 'property'
  | 'constructor' | 'getter' | 'setter' | 'namespace' | 'module'
  | 'trait' | 'impl' | 'generic';

export interface Declaration {
  kind: DeclarationKind;
  name: string;
  signature: string;       // The first meaningful line(s) of the declaration
  bodySnippet: string;     // Up to 40 lines of the body for LLM context
  indentPrefix: string;    // Whitespace to match indentation
  language: string;
}

/** Language → preferred doc style */
export type CommentStyle = 'jsdoc' | 'xmldoc' | 'javadoc' | 'pydoc' | 'rustdoc' | 'rubydoc' | 'singleline';

const COMMENT_STYLE_BY_LANG: Record<string, CommentStyle> = {
  javascript: 'jsdoc',   javascriptreact: 'jsdoc',
  typescript: 'jsdoc',   typescriptreact: 'jsdoc',
  java: 'javadoc',       kotlin: 'javadoc',  groovy: 'javadoc',
  csharp: 'xmldoc',
  cpp: 'jsdoc',          c: 'jsdoc',
  rust: 'rustdoc',
  python: 'pydoc',
  go: 'singleline',
  ruby: 'rubydoc',
  php: 'jsdoc',
  swift: 'jsdoc',
  scala: 'javadoc',
};

// Per-language patterns for detecting declarations.
// Each entry: [regex, kind, nameGroupIndex]
type LangPatterns = [RegExp, DeclarationKind, number][];

const PATTERNS_BY_LANG: Record<string, LangPatterns> = {

  // ── JavaScript / TypeScript ──────────────────────────────────────────────
  typescript: [
    [/^\s*(export\s+)?(default\s+)?async\s+function\s*\*?\s*(\w+)\s*[(<]/, 'function', 3],
    [/^\s*(export\s+)?(default\s+)?function\s*\*?\s*(\w+)\s*[(<]/, 'function', 3],
    [/^\s*(export\s+)?abstract\s+class\s+(\w+)/, 'class', 2],
    [/^\s*(export\s+)?class\s+(\w+)/, 'class', 2],
    [/^\s*(export\s+)?interface\s+(\w+)/, 'interface', 2],
    [/^\s*(export\s+)?enum\s+(\w+)/, 'enum', 2],
    [/^\s*(export\s+)?type\s+(\w+)\s*[=<]/, 'type', 2],
    [/^\s*(export\s+)?namespace\s+(\w+)/, 'namespace', 2],
    [/^\s*(export\s+)?module\s+(\w+)/, 'module', 2],
    [/^\s*(public|private|protected|static|readonly|override|\s)*\s*(async\s+)?(\w+)\s*\(/, 'method', 3],
    [/^\s*(export\s+)?(const|let|var)\s+(\w+)\s*[=:]/, 'variable', 3],
    [/^\s*(public|private|protected|readonly|\s)+(\w+)\s*[=:?!]/, 'property', 2],
    [/^\s*constructor\s*\(/, 'constructor', 0],
    [/^\s*(get|set)\s+(\w+)\s*\(/, 'getter', 2],
  ],

  // ── Python ───────────────────────────────────────────────────────────────
  python: [
    [/^\s*(async\s+)?def\s+(__\w+__|_?\w+)\s*\(/, 'function', 2],
    [/^\s*class\s+(\w+)\s*[:(]/, 'class', 1],
    [/^\s*(\w+)\s*[:=]/, 'variable', 1],
  ],

  // ── Java / Kotlin / Groovy ───────────────────────────────────────────────
  java: [
    [/^\s*(public|private|protected|static|final|abstract|synchronized|\s)*\s+(class|abstract\s+class)\s+(\w+)/, 'class', 3],
    [/^\s*(public|private|protected|static|final|abstract|synchronized|\s)*\s+interface\s+(\w+)/, 'interface', 2],
    [/^\s*(public|private|protected|static|final|abstract|synchronized|\s)*\s+enum\s+(\w+)/, 'enum', 2],
    [/^\s*(public|private|protected|static|final|synchronized|\s)*\s+\w[\w<>, \[\]]*\s+(\w+)\s*\(/, 'method', 2],
    [/^\s*(public|private|protected|static|final|\s)*\s+\w[\w<>, \[\]]*\s+(\w+)\s*[=;]/, 'variable', 2],
  ],

  // ── C# ───────────────────────────────────────────────────────────────────
  csharp: [
    [/^\s*(public|private|protected|internal|static|abstract|sealed|partial|override|\s)*\s*(class|record)\s+(\w+)/, 'class', 3],
    [/^\s*(public|private|protected|internal|static|\s)*\s*interface\s+(\w+)/, 'interface', 2],
    [/^\s*(public|private|protected|internal|static|\s)*\s*enum\s+(\w+)/, 'enum', 2],
    [/^\s*(public|private|protected|internal|static|abstract|override|async|\s)*\s+\w[\w<>, \[\]?]*\s+(\w+)\s*\(/, 'method', 2],
    [/^\s*(public|private|protected|internal|static|readonly|const|\s)*\s+\w[\w<>, \[\]?]*\s+(\w+)\s*[{=;]/, 'property', 2],
    [/^\s*(public|private|protected|internal|\s)*\s+(\w+)\s*\(/, 'constructor', 2],
  ],

  // ── C / C++ ──────────────────────────────────────────────────────────────
  cpp: [
    [/^\s*(template\s*<[^>]*>\s*)?(inline\s+|static\s+|virtual\s+|explicit\s+|constexpr\s+)*[\w:*&<> ]+\s+(\w+)\s*\(/, 'function', 3],
    [/^\s*(class|struct)\s+(\w+)/, 'class', 2],
    [/^\s*enum\s+(class\s+)?(\w+)/, 'enum', 2],
    [/^\s*(typedef\s+)?struct\s+(\w+)?/, 'struct', 2],
    [/^\s*namespace\s+(\w+)/, 'namespace', 1],
    [/^\s*(const|static|extern|\s)*\s+\w[\w*& ]*\s+(\w+)\s*[=;([]/, 'variable', 2],
  ],

  // ── Rust ─────────────────────────────────────────────────────────────────
  rust: [
    [/^\s*(pub(\(.*?\))?\s+)?(async\s+)?fn\s+(\w+)/, 'function', 4],
    [/^\s*(pub(\(.*?\))?\s+)?struct\s+(\w+)/, 'struct', 3],
    [/^\s*(pub(\(.*?\))?\s+)?enum\s+(\w+)/, 'enum', 3],
    [/^\s*(pub(\(.*?\))?\s+)?trait\s+(\w+)/, 'trait', 3],
    [/^\s*(pub(\(.*?\))?\s+)?impl(\s*<[^>]*>)?\s+(\w+)/, 'impl', 4],
    [/^\s*(pub(\(.*?\))?\s+)?(const|static|let)\s+(\w+)/, 'constant', 4],
    [/^\s*(pub(\(.*?\))?\s+)?type\s+(\w+)/, 'type', 3],
    [/^\s*(pub(\(.*?\))?\s+)?mod\s+(\w+)/, 'module', 3],
  ],

  // ── Go ───────────────────────────────────────────────────────────────────
  go: [
    [/^\s*func\s+(\(.*?\)\s+)?(\w+)\s*\(/, 'function', 2],
    [/^\s*type\s+(\w+)\s+struct\s*\{/, 'struct', 1],
    [/^\s*type\s+(\w+)\s+interface\s*\{/, 'interface', 1],
    [/^\s*type\s+(\w+)\s+/, 'type', 1],
    [/^\s*var\s+(\w+)\s+/, 'variable', 1],
    [/^\s*const\s+(\w+)\s+/, 'constant', 1],
  ],

  // ── Ruby ─────────────────────────────────────────────────────────────────
  ruby: [
    [/^\s*def\s+(self\.)?(\w+[?!]?)/, 'method', 2],
    [/^\s*class\s+(\w+)/, 'class', 1],
    [/^\s*module\s+(\w+)/, 'module', 1],
    [/^\s*attr_(accessor|reader|writer)\s+:(\w+)/, 'property', 2],
  ],

  // ── PHP ──────────────────────────────────────────────────────────────────
  php: [
    [/^\s*(public|private|protected|static|abstract|final|\s)*\s*function\s+(\w+)\s*\(/, 'function', 2],
    [/^\s*(abstract\s+|final\s+)?class\s+(\w+)/, 'class', 2],
    [/^\s*interface\s+(\w+)/, 'interface', 1],
    [/^\s*trait\s+(\w+)/, 'trait', 1],
    [/^\s*(public|private|protected|static|const|\s)*\s*\$(\w+)/, 'variable', 2],
  ],

  // ── Swift ────────────────────────────────────────────────────────────────
  swift: [
    [/^\s*(public|private|internal|open|fileprivate|static|class|override|mutating|final|\s)*\s*func\s+(\w+)/, 'function', 2],
    [/^\s*(public|private|internal|open|fileprivate|final|\s)*\s*class\s+(\w+)/, 'class', 2],
    [/^\s*(public|private|internal|open|fileprivate|\s)*\s*struct\s+(\w+)/, 'struct', 2],
    [/^\s*(public|private|internal|open|fileprivate|\s)*\s*protocol\s+(\w+)/, 'interface', 2],
    [/^\s*(public|private|internal|open|fileprivate|\s)*\s*enum\s+(\w+)/, 'enum', 2],
    [/^\s*(var|let)\s+(\w+)\s*[=:]/, 'variable', 2],
  ],
};

// Alias shared patterns
PATTERNS_BY_LANG['javascript'] = PATTERNS_BY_LANG['typescript'];
PATTERNS_BY_LANG['javascriptreact'] = PATTERNS_BY_LANG['typescript'];
PATTERNS_BY_LANG['typescriptreact'] = PATTERNS_BY_LANG['typescript'];
PATTERNS_BY_LANG['kotlin'] = PATTERNS_BY_LANG['java'];
PATTERNS_BY_LANG['groovy'] = PATTERNS_BY_LANG['java'];
PATTERNS_BY_LANG['c'] = PATTERNS_BY_LANG['cpp'];

/** Scan forward from `startLine` to find the first non-blank, non-comment line */
function findDeclarationLine(
  document: vscode.TextDocument,
  startLine: number
): number | null {
  for (let i = startLine; i < Math.min(startLine + 5, document.lineCount); i++) {
    const text = document.lineAt(i).text;
    const trimmed = text.trim();
    // Skip blank and comment-only lines
    if (!trimmed || /^(\/\/|\/\*|\*|#|--|;|'|\^)/.test(trimmed)) { continue; }
    return i;
  }
  return null;
}

/** Extract up to `maxLines` lines starting from `startLine` for body context */
function extractBodySnippet(document: vscode.TextDocument, startLine: number, maxLines = 40): string {
  const end = Math.min(startLine + maxLines, document.lineCount);
  const lines: string[] = [];
  for (let i = startLine; i < end; i++) {
    lines.push(document.lineAt(i).text);
  }
  return lines.join('\n');
}

/**
 * Try to detect a declaration starting at or after `declLine`.
 * Returns null if nothing recognizable is found.
 */
export function detectDeclaration(
  document: vscode.TextDocument,
  declLine: number
): Declaration | null {
  const lang = document.languageId;
  const patterns = PATTERNS_BY_LANG[lang] ?? PATTERNS_BY_LANG['typescript'];

  // Collect up to 6 lines for multi-line signatures (e.g. generics, long param lists)
  const signatureLines: string[] = [];
  for (let i = declLine; i < Math.min(declLine + 6, document.lineCount); i++) {
    signatureLines.push(document.lineAt(i).text);
  }
  const sigText = signatureLines.join('\n');

  for (const [pattern, kind, nameGroup] of patterns) {
    const match = pattern.exec(sigText);
    if (!match) { continue; }

    const name = match[nameGroup] ?? match[1] ?? '<unknown>';
    const indentPrefix = document.lineAt(declLine).text.match(/^(\s*)/)?.[1] ?? '';
    const bodySnippet = extractBodySnippet(document, declLine);

    return {
      kind,
      name,
      signature: signatureLines.slice(0, 3).join('\n').trim(),
      bodySnippet,
      indentPrefix,
      language: lang,
    };
  }

  return null;
}

// ─── Comment style rendering ──────────────────────────────────────────────────

export function getCommentStyleForLang(language: string): CommentStyle {
  return COMMENT_STYLE_BY_LANG[language] ?? 'jsdoc';
}

/** Wrap raw LLM text into the correct comment format for the language */
/** Word-count of a string (splits on whitespace) */
function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Wrap a long prose sentence at the nearest word boundary before the 15-word
 * limit. Returns an array of lines (each ≤15 words).
 */
function wrapWords(text: string, maxWords = 15): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) { return [text.trim()]; }

  const result: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= maxWords) {
      result.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) { result.push(current.join(' ')); }
  return result;
}

/**
 * Expand a line that may be longer than 15 words into multiple wrapped lines.
 * Tag lines (e.g. @param, @returns) are wrapped with continuation indent.
 * Structural lines (/// markers, XML tags) are never wrapped.
 */
function expandLine(line: string, maxWords = 15): string[] {
  // Never wrap tag-only or structural markers
  if (/^@(param|returns?|throws?|example|see|since|deprecated|type)\s/.test(line)) {
    // Wrap @param description only, keeping the tag + name on first line
    const m = line.match(/^(@param\s+\{?[\w|]+\}?\s+\w+|@\w+\s*\w*)\s+(.*)/);
    if (m) {
      const tag = m[1];
      const desc = m[2];
      if (wordCount(desc) > maxWords) {
        const wrapped = wrapWords(desc, maxWords);
        return [tag + ' ' + wrapped[0], ...wrapped.slice(1).map(l => '  ' + l)];
      }
    }
    return [line];
  }
  if (wordCount(line) <= maxWords) { return [line]; }
  return wrapWords(line, maxWords);
}

// Strip existing comment markers the LLM may have pre-applied.
// Handles: /// // /** /* * */ # --
// Prevents double-markers like "/// /// text".
function stripCommentMarkers(line: string): string {
  return line
    // Rust/C# ///  or //!
    .replace(/^(\/\/[\/!]\s?)/, '')
    // Block comment body  * or */
    .replace(/^(\*\/?)\s?/, '')
    // Block comment open  /**  or  /*
    .replace(/^\/\*\*?\s?/, '')
    // Single-line  //
    .replace(/^\/\/\s?/, '')
    // Python / Ruby  #
    .replace(/^#\s?/, '')
    // SQL / Lua  --
    .replace(/^--\s?/, '')
    .trim();
}

export function formatDocComment(
  rawText: string,
  style: CommentStyle,
  indentPrefix: string,
  kind: DeclarationKind
): string {
  const indent = indentPrefix;

  // Parse raw LLM text into clean lines
  // stripCommentMarkers removes any prefixes the LLM may have already added
  // (e.g. Rust /// , Python # , JSDoc  * ) so we never produce double-markers.
  const rawLines = rawText
    .replace(/^```[\w]*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim()
    .split('\n')
    .map(l => stripCommentMarkers(l.trim()))
    .filter(l => l.length > 0);

  // Expand any line that exceeds 15 words into multiple lines
  const lines: string[] = [];
  for (const l of rawLines) {
    for (const expanded of expandLine(l)) {
      lines.push(expanded);
    }
  }

  switch (style) {
    case 'pydoc': {
      if (lines.length === 1) { return `${indent}# ${lines[0]}`; }
      return lines.map(l => `${indent}# ${l}`).join('\n');
    }

    case 'rustdoc': {
      return lines.map(l => `${indent}/// ${l}`).join('\n');
    }

    case 'rubydoc': {
      return lines.map(l => `${indent}# ${l}`).join('\n');
    }

    case 'singleline': {
      return lines.map(l => `${indent}// ${l}`).join('\n');
    }

    case 'xmldoc': {
      const summary = lines[0];
      const rest = lines.slice(1);
      const xmlLines = [
        `${indent}/// <summary>`,
        `${indent}/// ${summary}`,
        `${indent}/// </summary>`,
      ];
      for (const l of rest) {
        if (/^param/i.test(l)) {
          const m = l.match(/param\s+(\w+)\s*[-–:]\s*(.*)/i);
          if (m) { xmlLines.push(`${indent}/// <param name="${m[1]}">${m[2]}</param>`); }
        } else if (/^returns?/i.test(l)) {
          const val = l.replace(/^returns?:?\s*/i, '');
          if (val) { xmlLines.push(`${indent}/// <returns>${val}</returns>`); }
        } else if (/^throws?|^exception/i.test(l)) {
          const val = l.replace(/^(throws?|exception):?\s*/i, '');
          if (val) { xmlLines.push(`${indent}/// <exception cref="">${val}</exception>`); }
        } else if (l) {
          xmlLines.push(`${indent}/// <remarks>${l}</remarks>`);
        }
      }
      return xmlLines.join('\n');
    }

    case 'javadoc':
    case 'jsdoc':
    default: {
      const docLines = [`${indent}/**`];
      for (const l of lines) {
        docLines.push(`${indent} * ${l}`);
      }
      docLines.push(`${indent} */`);
      return docLines.join('\n');
    }
  }
}

// ─── LLM prompt builder ──────────────────────────────────────────────────────

export function buildSmartDocPrompt(decl: Declaration): ChatMessage[] {
  const style = getCommentStyleForLang(decl.language);

  const styleGuide: Record<CommentStyle, string> = {
    jsdoc: 'Use JSDoc format. Output PLAIN TEXT only — do NOT include /**, *, or */ markers, the tool adds those. Start with a clear summary sentence. Add @param for each parameter with type and description. Add @returns if non-void. Add @throws if applicable. Add @example if useful.',
    javadoc: 'Use Javadoc format. Output PLAIN TEXT only — do NOT include /**, *, or */ markers. Start with a clear summary sentence. Add @param for each parameter. Add @return if non-void. Add @throws if applicable.',
    xmldoc: 'Output ONLY raw lines — NOT wrapped in XML tags yourself. Start with a summary sentence. Then list params as "param <name> - <desc>". Then "returns: <desc>" if applicable.',
    pydoc: 'Write a concise Python-style docstring as PLAIN TEXT — do NOT include # markers. One-line summary, then Args section if there are parameters, Returns section if non-void, Raises section if applicable.',
    rustdoc: 'Write Rust doc-comment content as PLAIN TEXT — do NOT include /// markers, the tool adds those. One-line summary sentence. Then "# Arguments" section with parameter descriptions if any. Then "# Returns" if applicable. Then "# Examples" with a simple code example if useful.',
    rubydoc: 'Write a concise Ruby comment as PLAIN TEXT — do NOT include # markers. One-line summary, then describe parameters and return value as plain English.',
    singleline: 'Write a concise Go-style comment as PLAIN TEXT — do NOT include // markers. First line must be "<FunctionName> <does what>". Keep it brief.',
  };

  const guide = styleGuide[style];
  const kindLabel = decl.kind.charAt(0).toUpperCase() + decl.kind.slice(1);

  return [
    {
      role: 'system',
      content: `You are an expert technical writer generating documentation comments for ${decl.language} code.
Output ONLY the documentation comment text content — no wrapping fences, no preamble, no "here is the doc".
${guide}`,
    },
    {
      role: 'user',
      content: `Generate a documentation comment for this ${decl.language} ${kindLabel} named "${decl.name}".

Declaration:
\`\`\`${decl.language}
${decl.bodySnippet}
\`\`\`

Output only the comment content (no code fences).`,
    },
  ];
}

// ─── Trigger watcher ─────────────────────────────────────────────────────────

export class DocTriggerWatcher {
  private disposable: vscode.Disposable;

  // State machine: tracks whether the current line looks like a doc comment trigger
  private triggerState = new WeakMap<vscode.TextDocument, {
    line: number;
    style: '//' | '/**';
  }>();

  private selectionDisposable: vscode.Disposable;

  constructor(private statusBar: { setLoading(msg: string): void; setIdle(): void; setError(msg: string): void }) {
    this.disposable = vscode.workspace.onDidChangeTextDocument(
      this.onTextChange.bind(this)
    );
    // If the user moves the cursor away from the pending-comment line, clear
    // the pending state so the ghost text is no longer offered.
    this.selectionDisposable = vscode.window.onDidChangeTextEditorSelection(e => {
      const pending = getPendingDocComment();
      if (!pending) { return; }
      if (e.textEditor.document.uri.toString() !== pending.uri) { clearPendingDocComment(); return; }
      const curLine = e.selections[0]?.active.line ?? -1;
      if (curLine !== pending.line) { clearPendingDocComment(); }
    });
  }

  private async onTextChange(event: vscode.TextDocumentChangeEvent) {
    const cfg = vscode.workspace.getConfiguration('llmCopilot');
    if (!cfg.get('enabled', true)) { return; }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) { return; }
    if (event.contentChanges.length === 0) { return; }

    const doc = event.document;
    const change = event.contentChanges[0];
    const cursorPos = editor.selection.active;
    // Guard: cursor line must be within document bounds
    if (doc.lineCount === 0) { return; }
    const safeCursorLine = Math.max(0, Math.min(cursorPos.line, doc.lineCount - 1));
    const currentLine = doc.lineAt(safeCursorLine).text;
    const trimmed = currentLine.trim();

    // ── Detect trigger patterns ──────────────────────────────────────────
    //
    // We fire when the user has typed exactly:
    //   //       (single-line comment trigger)
    //   /**      (block comment trigger)
    //   /* */    (block comment with closing, common editor auto-completion)
    //
    // and the NEXT non-blank line is a declaration.

    const isSingleLineTrigger = /^\s*\/\/\s*$/.test(currentLine);
    const isBlockTrigger = /^\s*\/\*\*?\s*(\*\/)?\s*$/.test(currentLine);
    const isPythonTrigger = doc.languageId === 'python' && /^\s*#\s*$/.test(currentLine);
    const isRustTrigger = doc.languageId === 'rust' && /^\s*\/\/\/\s*$/.test(currentLine);
    const isRubyTrigger = doc.languageId === 'ruby' && /^\s*#\s*$/.test(currentLine);

    if (!isSingleLineTrigger && !isBlockTrigger && !isPythonTrigger && !isRustTrigger && !isRubyTrigger) {
      return;
    }

    // Only trigger if the change was actually typing // or /** (not just cursor movement)
    const addedText = change.text;
    if (addedText.length > 5) { return; } // paste, not typing

    // ── Strict proximity check ───────────────────────────────────────────
    // The comment sign must be on the IMMEDIATE line above the declaration.
    // We only look at line+1 — if it is blank or another comment, do NOT trigger.
    const nextLineIndex = safeCursorLine + 1;
    if (nextLineIndex >= doc.lineCount) { return; }

    const nextLineText = doc.lineAt(nextLineIndex).text;
    const nextLineTrimmed = nextLineText.trim();

    // Next line must be non-empty and not itself a comment line
    if (!nextLineTrimmed) { return; }
    if (/^(\/\/|\/\*|\*\s|#\s*$|--)/.test(nextLineTrimmed)) { return; }

    // Now verify it is actually a recognisable declaration
    const decl = detectDeclaration(doc, nextLineIndex);
    if (!decl) { return; }

    const declLine = nextLineIndex;

    // If the line immediately above the trigger line (safeCursorLine - 1) is also
    // a comment, or if the declaration already has a comment block above it,
    // do NOT trigger — never duplicate or stack comments.
    if (safeCursorLine > 0) {
      const lineAboveTrigger = doc.lineAt(safeCursorLine - 1).text.trim();
      // Line above trigger is a comment → already has documentation
      if (/^(\/\/|\/\*|\*|\*\/)/.test(lineAboveTrigger) ||
          /^(#|--|'''|""")/.test(lineAboveTrigger)) {
        return;
      }
    }
    // Check if declaration line already has a comment directly above the trigger
    // (covers the case where user is re-typing a comment that already existed)
    const existingCommentPattern = /^\s*(\/\/|\/\*\*?|\*|\/\/\/|#)/;
    // If the trigger line itself is a re-typed comment over existing content, skip
    if (safeCursorLine > 0) {
      // Look at lines 2-5 above the declaration to see if a comment block exists
      for (let lookback = safeCursorLine - 1; lookback >= Math.max(0, safeCursorLine - 4); lookback--) {
        const lookLine = doc.lineAt(lookback).text.trim();
        if (lookLine === '') { break; } // blank line → no existing comment
        if (existingCommentPattern.test(lookLine)) {
          return; // comment block already exists above this declaration
        }
        break; // non-blank, non-comment → no existing comment
      }
    }

    // Debounce: wait 300ms to confirm user stopped typing
    await new Promise(r => setTimeout(r, 300));

    // Re-check editor state
    const nowEditor = vscode.window.activeTextEditor;
    if (!nowEditor || nowEditor.document !== doc) { return; }
    const nowSafeLine = Math.max(0, Math.min(nowEditor.selection.active.line, doc.lineCount - 1));
    const nowLine = doc.lineAt(nowSafeLine).text;
    if (nowLine.trim() !== currentLine.trim()) { return; } // user kept typing

    await this.generateAndInsert(nowEditor, safeCursorLine, decl, currentLine);
  }

  private async generateAndInsert(
    editor: vscode.TextEditor,
    commentLine: number,
    decl: Declaration,
    existingCommentText: string
  ) {
    this.statusBar.setLoading(`Generating doc for ${decl.kind} "${decl.name}"…`);

    try {
      const messages   = buildSmartDocPrompt(decl);
      const rawResponse = await chat(messages);

      if (!rawResponse?.trim()) {
        this.statusBar.setIdle();
        return;
      }

      const style     = getCommentStyleForLang(decl.language);
      const formatted = formatDocComment(rawResponse, style, decl.indentPrefix, decl.kind);

      // ── Store as pending ghost text — do NOT apply immediately ──────────
      // The InlineCompletionProvider will pick this up and present it as
      // native ghost text. The user Tab-accepts or Escape-dismisses.
      setPendingDocComment({
        uri:       editor.document.uri.toString(),
        line:      commentLine,
        formatted,
        declName:  decl.name,
      });

      this.statusBar.setIdle();

      // Trigger VS Code to re-evaluate inline completions at this position.
      // This causes provideInlineCompletionItems to be called, which will
      // find the pending comment and return it as a ghost-text suggestion.
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');

    } catch (err: any) {
      this.statusBar.setError('Doc error');
      const msg = err.message || '';
      if (!/HTTP (405|404|501)/.test(msg) && !msg.includes('proxy not found')) {
        console.error('[LLM Copilot] Doc generation error:', msg);
      }
      const userMsg = /HTTP (405|404|501)/.test(msg) || msg.includes('proxy not found')
        ? `Claude Code proxy not reachable. Run "LLM Copilot: Diagnose Claude Code Connection".`
        : `Failed to generate doc — ${msg}`;
      vscode.window.showErrorMessage(`LLM Copilot: ${userMsg}`);
    }
  }

  dispose() {
    this.disposable.dispose();
    this.selectionDisposable.dispose();
    clearPendingDocComment();
  }
}
