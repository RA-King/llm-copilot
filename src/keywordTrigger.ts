/**
 * keywordTrigger.ts
 *
 * Maps language IDs to keyword sets that should immediately trigger a
 * ghost completion when typed as the first token on a line.
 *
 * Design: keywords that START a new declaration or statement block.
 * We intentionally exclude flow-control keywords that appear mid-expression
 * (e.g. `return`, `break`) because those are inside existing code.
 */

// ─── Keyword sets per language ─────────────────────────────────────────────

const KEYWORDS: Record<string, Set<string>> = {

  typescript: new Set([
    // Declaration starters
    'function', 'async', 'class', 'interface', 'enum', 'type', 'namespace',
    'abstract', 'export', 'import', 'const', 'let', 'var',
    // Method/accessor inside class
    'constructor', 'get', 'set', 'static', 'private', 'public', 'protected',
    'override', 'readonly',
    // Control flow that opens a block
    'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally',
    // Module
    'module', 'declare',
  ]),

  javascript: new Set([
    'function', 'async', 'class', 'const', 'let', 'var', 'import', 'export',
    'constructor', 'get', 'set', 'static',
    'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally',
  ]),

  python: new Set([
    'def', 'async', 'class', 'import', 'from',
    'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally',
    'return', 'yield', 'lambda', 'pass',
    '@',  // decorator
  ]),

  java: new Set([
    'public', 'private', 'protected', 'static', 'final', 'abstract',
    'class', 'interface', 'enum', 'record',
    'void', 'int', 'long', 'double', 'float', 'boolean', 'String',
    'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally',
    'import', 'package',
    '@',  // annotation
  ]),

  csharp: new Set([
    'public', 'private', 'protected', 'internal', 'static', 'readonly',
    'abstract', 'virtual', 'override', 'sealed', 'partial', 'async',
    'class', 'struct', 'interface', 'enum', 'record', 'delegate', 'event',
    'void', 'var', 'int', 'string', 'bool', 'double', 'float', 'decimal',
    'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'try', 'catch', 'finally',
    'using', 'namespace',
    '[',  // attribute
  ]),

  rust: new Set([
    'fn', 'async', 'pub', 'struct', 'enum', 'impl', 'trait', 'type',
    'mod', 'use', 'let', 'const', 'static', 'extern',
    'if', 'else', 'for', 'while', 'loop', 'match',
    '#',  // attribute
  ]),

  go: new Set([
    'func', 'type', 'struct', 'interface', 'var', 'const', 'import', 'package',
    'if', 'else', 'for', 'switch', 'select', 'go', 'defer',
    'map', 'chan', 'make', 'new',
  ]),

  cpp: new Set([
    'void', 'int', 'long', 'double', 'float', 'bool', 'char', 'auto',
    'class', 'struct', 'enum', 'template', 'namespace', 'typedef', 'using',
    'public', 'private', 'protected', 'static', 'const', 'virtual', 'override',
    'explicit', 'inline', 'extern', 'constexpr',
    'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch',
    '#',  // preprocessor
  ]),

  c: new Set([
    'void', 'int', 'long', 'double', 'float', 'char', 'unsigned', 'signed',
    'struct', 'enum', 'typedef', 'static', 'const', 'extern', 'inline',
    'if', 'else', 'for', 'while', 'do', 'switch',
    '#',
  ]),

  kotlin: new Set([
    'fun', 'class', 'interface', 'object', 'enum', 'sealed', 'data',
    'val', 'var', 'const', 'override', 'abstract', 'open', 'private',
    'public', 'protected', 'internal', 'suspend', 'inline', 'companion',
    'if', 'else', 'for', 'while', 'do', 'when', 'try', 'catch', 'finally',
    'import', 'package',
    '@',
  ]),

  swift: new Set([
    'func', 'class', 'struct', 'enum', 'protocol', 'extension',
    'var', 'let', 'typealias', 'associatedtype',
    'override', 'private', 'public', 'internal', 'fileprivate', 'open',
    'static', 'final', 'required', 'convenience', 'lazy', 'weak', 'unowned',
    'if', 'else', 'for', 'while', 'repeat', 'switch', 'do', 'try', 'catch',
    'guard', 'defer', 'import',
    '@',
  ]),

  ruby: new Set([
    'def', 'class', 'module', 'attr_accessor', 'attr_reader', 'attr_writer',
    'private', 'public', 'protected',
    'if', 'elsif', 'else', 'unless', 'case', 'when', 'while', 'until', 'for',
    'begin', 'rescue', 'ensure', 'end',
    'require', 'include', 'extend',
  ]),

  php: new Set([
    'function', 'class', 'interface', 'trait', 'abstract', 'final',
    'public', 'private', 'protected', 'static', 'readonly',
    'if', 'elseif', 'else', 'for', 'foreach', 'while', 'do', 'switch',
    'try', 'catch', 'finally',
    'namespace', 'use', 'require', 'include',
    '#', '//',
  ]),

  scala: new Set([
    'def', 'val', 'var', 'class', 'object', 'trait', 'case', 'sealed',
    'abstract', 'override', 'private', 'public', 'protected',
    'if', 'else', 'for', 'while', 'do', 'match', 'try', 'catch', 'finally',
    'import', 'package', 'extends', 'with',
    '@',
  ]),

  dart: new Set([
    'void', 'class', 'abstract', 'interface', 'mixin', 'enum', 'extension',
    'var', 'final', 'const', 'late', 'static', 'dynamic',
    'public', 'private', 'factory', 'get', 'set', 'async', 'await',
    'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally',
    'import', 'export', 'library', 'part',
    '@',
  ]),

};

// Aliases
KEYWORDS['typescriptreact'] = KEYWORDS['typescript'];
KEYWORDS['javascriptreact'] = KEYWORDS['javascript'];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if `token` is a keyword that should trigger a completion
 * in the given language when typed as the first non-whitespace token on a line.
 */
export function isKeywordTrigger(token: string, language: string): boolean {
  const set = KEYWORDS[language];
  if (!set) { return false; }
  return set.has(token.trimEnd());
}

/**
 * Given the current line prefix, extract the first token and check if it's
 * a keyword trigger. Returns the keyword if so, otherwise null.
 */
export function extractKeywordTrigger(
  linePrefix: string,
  language: string
): string | null {
  const trimmed = linePrefix.trimStart();
  if (!trimmed) { return null; }

  // Match the first word (or # / @ as single-char triggers)
  const m = trimmed.match(/^([#@]|[a-zA-Z_$][\w$]*)/);
  if (!m) { return null; }

  const token = m[1];
  // Only trigger when the line consists of JUST the keyword (possibly with trailing space)
  // i.e. the user just finished typing the keyword and hasn't started the name yet
  const rest = trimmed.slice(token.length);
  if (rest !== '' && rest !== ' ' && rest !== '\t') { return null; }

  return isKeywordTrigger(token, language) ? token : null;
}
