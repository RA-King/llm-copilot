import * as vscode from 'vscode';
import * as path from 'path';

/**
 * workspaceContext.ts
 *
 * Gathers cross-file context (type signatures, imports, interfaces, function
 * signatures) that the LLM needs to produce correctly-typed completions.
 *
 * Strategy — fast, no language server dependency:
 *  1. Use vscode.workspace.findFiles to locate related files
 *  2. Scan them with regex for exported declarations
 *  3. Feed the relevant signatures into the completion prompt
 */

export interface WorkspaceSignatures {
  /** Relevant signatures from other files, ready to inject into the prompt */
  context: string;
  /** Source files that were scanned */
  sources: string[];
}

// ── Declaration extraction patterns (language-specific) ─────────────────────

const EXPORT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*export\s+(type|interface|class|abstract\s+class|enum)\s+(\w+)[^{]*/,
    /^\s*export\s+(async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[\w<>\[\]|,\s?]+)?/,
    /^\s*export\s+const\s+(\w+)\s*(?::\s*[\w<>\[\]|,\s?]+)?/,
    /^\s*export\s+default\s+(class|function)\s+(\w+)/,
  ],
  javascript: [
    /^\s*export\s+(async\s+)?function\s+(\w+)\s*\([^)]*\)/,
    /^\s*export\s+class\s+(\w+)/,
    /^\s*export\s+const\s+(\w+)/,
    /^\s*module\.exports\s*=/,
  ],
  python: [
    /^\s*(async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[\w\[\]|,\s]+)?:/,
    /^\s*class\s+(\w+)\s*(?:\([^)]*\))?:/,
  ],
  java: [
    /^\s*(public|protected)\s+(?:static\s+|abstract\s+|final\s+)?(?:[\w<>\[\]]+)\s+(\w+)\s*\([^)]*\)/,
    /^\s*(public|protected)\s+(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+(\w+)/,
  ],
  csharp: [
    /^\s*(public|protected|internal)\s+(?:static\s+|abstract\s+|virtual\s+|override\s+|async\s+)?(?:[\w<>\[\]?]+)\s+(\w+)\s*\(/,
    /^\s*(public|protected|internal)\s+(?:abstract\s+|sealed\s+|partial\s+)?(?:class|interface|struct|enum|record)\s+(\w+)/,
  ],
  rust: [
    /^\s*(pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)(?:\s*->\s*[\w<>&' ]+)?/,
    /^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type)\s+(\w+)/,
  ],
  go: [
    /^\s*func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/,
    /^\s*type\s+(\w+)\s+(struct|interface)/,
  ],
};
EXPORT_PATTERNS['typescriptreact'] = EXPORT_PATTERNS['typescript'];
EXPORT_PATTERNS['javascriptreact'] = EXPORT_PATTERNS['javascript'];

// ── File extensions per language ─────────────────────────────────────────────

const LANG_GLOBS: Record<string, string> = {
  typescript:      '**/*.{ts,tsx}',
  typescriptreact: '**/*.{ts,tsx}',
  javascript:      '**/*.{js,jsx,mjs}',
  javascriptreact: '**/*.{js,jsx,mjs}',
  python:          '**/*.py',
  java:            '**/*.java',
  csharp:          '**/*.cs',
  rust:            '**/*.rs',
  go:              '**/*.go',
  cpp:             '**/*.{cpp,cc,cxx,h,hpp}',
  c:               '**/*.{c,h}',
};

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Gather relevant signatures from other workspace files.
 * Runs quickly (regex-only, no AST) and respects a time budget.
 *
 * @param currentFile   The file currently being edited (excluded from scan)
 * @param language      Language ID
 * @param cursorPrefix  Text before cursor (used to find referenced names)
 * @param timeBudgetMs  Max milliseconds to spend scanning (default 800ms)
 */
export async function gatherWorkspaceSignatures(
  currentFile: string,
  language: string,
  cursorPrefix: string,
  timeBudgetMs = 800
): Promise<WorkspaceSignatures> {
  const glob = LANG_GLOBS[language];
  if (!glob) { return { context: '', sources: [] }; }

  const patterns = EXPORT_PATTERNS[language] ?? [];
  if (!patterns.length) { return { context: '', sources: [] }; }

  const deadline = Date.now() + timeBudgetMs;
  const signatures: string[] = [];
  const sources: string[] = [];

  // ── Find relevant identifiers in the cursor prefix ───────────────────────
  // Extract any capitalised names or imported identifiers to guide which
  // signatures are actually relevant to the current completion context.
  const referencedNames = extractReferencedNames(cursorPrefix);

  // ── Find files ────────────────────────────────────────────────────────────
  let files: vscode.Uri[] = [];
  try {
    files = await vscode.workspace.findFiles(
      glob,
      '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**}',
      200  // max files to consider
    );
  } catch { return { context: '', sources: [] }; }

  // Prioritise files whose names relate to the referenced identifiers
  const prioritised = prioritiseFiles(files, referencedNames, currentFile);

  for (const uri of prioritised) {
    if (Date.now() > deadline) { break; }
    if (uri.fsPath === currentFile) { continue; }

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fileSigs = extractSignatures(doc, patterns, referencedNames);
      if (fileSigs.length > 0) {
        const relPath = vscode.workspace.asRelativePath(uri);
        signatures.push(`// from ${relPath}:\n${fileSigs.join('\n')}`);
        sources.push(relPath);
      }
    } catch { continue; }
  }

  if (signatures.length === 0) { return { context: '', sources: [] }; }

  // Cap to avoid bloating the prompt
  const trimmed = signatures.slice(0, 12);
  const context =
    `// ── Related declarations from workspace ──\n` +
    trimmed.join('\n\n') +
    `\n// ──────────────────────────────────────────`;

  return { context, sources };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract capitalised and imported names from the cursor prefix */
function extractReferencedNames(prefix: string): Set<string> {
  const names = new Set<string>();
  // TypeScript/JS imports: import { Foo, Bar } from ...
  for (const m of prefix.matchAll(/import\s+.*?{([^}]+)}/g)) {
    for (const name of m[1].split(',')) {
      names.add(name.trim().split(/\s+as\s+/)[0].trim());
    }
  }
  // Capitalised identifiers (likely types/classes)
  for (const m of prefix.matchAll(/\b([A-Z][a-zA-Z0-9]+)\b/g)) {
    names.add(m[1]);
  }
  // Rust use statements
  for (const m of prefix.matchAll(/use\s+[\w:]+::(\w+)/g)) {
    names.add(m[1]);
  }
  // Python imports
  for (const m of prefix.matchAll(/from\s+\S+\s+import\s+([\w,\s]+)/g)) {
    for (const name of m[1].split(',')) {
      names.add(name.trim());
    }
  }
  return names;
}

/** Prioritise files that are likely to contain referenced identifiers */
function prioritiseFiles(
  files: vscode.Uri[],
  names: Set<string>,
  currentFile: string
): vscode.Uri[] {
  if (names.size === 0) { return files.filter(f => f.fsPath !== currentFile); }

  const nameList = [...names].map(n => n.toLowerCase());
  const scored = files
    .filter(f => f.fsPath !== currentFile)
    .map(uri => {
      const base = path.basename(uri.fsPath).toLowerCase();
      const score = nameList.filter(n => base.includes(n)).length;
      return { uri, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.map(s => s.uri);
}

/** Extract matching signature lines from a document */
function extractSignatures(
  doc: vscode.TextDocument,
  patterns: RegExp[],
  relevantNames: Set<string>
): string[] {
  const sigs: string[] = [];
  const MAX_SIGS_PER_FILE = 20;

  for (let i = 0; i < doc.lineCount && sigs.length < MAX_SIGS_PER_FILE; i++) {
    const line = doc.lineAt(i).text;
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        const sig = line.trim();
        // If we have a names filter, only include if the sig mentions one of the names
        if (relevantNames.size === 0 || [...relevantNames].some(n => sig.includes(n))) {
          sigs.push(sig);
        } else if (sigs.length < 5) {
          // Still include a few even without name match for overall context
          sigs.push(sig);
        }
        break;
      }
    }
  }
  return sigs;
}
