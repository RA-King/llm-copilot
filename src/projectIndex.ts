import * as path from 'path';
import * as vscode from 'vscode';

/**
 * projectIndex.ts
 *
 * What the whole application looks like, held in memory and on disk.
 *
 * The per-keystroke context gatherers answer questions about the cursor and
 * the file it sits in. Neither of them can answer "where is `OrderRepository`
 * declared", "who calls this function" or "what does this project even
 * contain", and those are exactly the questions a deep answer needs — the
 * difference between a fix that compiles and a fix that is right.
 *
 * So the workspace is read once, reduced to declarations and imports, and kept:
 *
 *   • A symbol table — name → the files that declare it, with the declaration
 *     line itself, so a lookup returns something quotable rather than a path.
 *   • An import graph, forwards and backwards. Forwards gives the code a file
 *     depends on; backwards gives the code that depends on it, which is what
 *     "will this change break anything" needs.
 *   • A digest of the project's shape — languages, entry points, manifests —
 *     for the prompts that need orientation rather than detail.
 *
 * Cost is the reason this is a module rather than a call. A full read of a
 * mid-sized repository is seconds, which is unaffordable on the completion
 * path and trivial once per session, so it happens in the background after
 * activation and is written to disk keyed by each file's mtime and size. A
 * second session re-reads only what changed, which is normally nothing.
 */

// ─── Shape ────────────────────────────────────────────────────────────────────

export type SymbolKind =
  | 'class' | 'interface' | 'struct' | 'trait' | 'enum'
  | 'function' | 'method' | 'type' | 'const' | 'component';

export interface IndexedSymbol {
  name: string;
  kind: SymbolKind;
  /** Zero-based line the declaration starts on. */
  line: number;
  /** The declaration as written, trimmed — quotable in a prompt. */
  signature: string;
  exported: boolean;
}

export interface IndexedFile {
  /** Workspace-relative, forward slashes. */
  path: string;
  language: string;
  mtime: number;
  size: number;
  symbols: IndexedSymbol[];
  /** Module specifiers exactly as written. */
  imports: string[];
  /** Names pulled in by those imports. */
  importedNames: string[];
  /** The specifiers above that resolved to a file in this workspace. */
  edges: string[];
}

export interface ProjectDigest {
  /** Files indexed, by language, largest first. */
  languages: { language: string; files: number }[];
  /** package.json, pyproject.toml, go.mod … whatever the project declares itself with. */
  manifests: string[];
  /** Files nothing else imports but which import plenty — the ways in. */
  entryPoints: string[];
  /** Top-level directories holding code, with how much. */
  areas: { dir: string; files: number }[];
  totalFiles: number;
}

export interface IndexStatus {
  state: 'idle' | 'building' | 'ready';
  files: number;
  symbols: number;
  /** Milliseconds the last full build took. */
  builtInMs: number;
  /** True when the last build stopped at the file ceiling. */
  truncated: boolean;
}

export interface IndexOptions {
  maxFiles: number;
  maxFileSizeKb: number;
  exclude: string[];
}

export const DEFAULT_INDEX_OPTIONS: IndexOptions = {
  maxFiles: 4000,
  maxFileSizeKb: 256,
  exclude: [],
};

// ─── Languages ────────────────────────────────────────────────────────────────

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.cs': 'csharp', '.rs': 'rust', '.go': 'go', '.rb': 'ruby', '.php': 'php',
  '.swift': 'swift', '.dart': 'dart',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
};

/** One glob covering everything the index can read — cheaper than one find per language. */
const SOURCE_GLOB = `**/*.{${Object.keys(EXT_LANGUAGE).map(e => e.slice(1)).join(',')}}`;

const ALWAYS_EXCLUDED = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**',
  '**/target/**', '**/vendor/**', '**/__pycache__/**', '**/.venv/**', '**/venv/**',
  '**/.gradle/**', '**/bin/**', '**/obj/**', '**/coverage/**', '**/.next/**',
];

const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'Gemfile', 'pubspec.yaml', 'Package.swift', 'CMakeLists.txt',
  '*.csproj', '*.sln',
]);

// ─── Declaration patterns ─────────────────────────────────────────────────────
//
// Regex rather than a parser, deliberately. The index has to cope with a dozen
// languages and with files that do not currently compile, and it only needs the
// declaration line — not its body, not its types resolved. Anything subtler
// belongs to the language server, which `semanticContext.ts` already asks.

interface DeclPattern { re: RegExp; kind: SymbolKind; group: number; }

const DECLARATIONS: Record<string, DeclPattern[]> = {
  typescript: [
    { re: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', group: 1 },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', group: 1 },
    { re: /^\s*(?:export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', group: 1 },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, kind: 'type', group: 1 },
    { re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', group: 1 },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: 'function', group: 1 },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const', group: 1 },
    { re: /^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/, kind: 'method', group: 1 },
  ],
  python: [
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { re: /^(?:\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
    { re: /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/, kind: 'const', group: 1 },
  ],
  java: [
    { re: /^\s*(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { re: /^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]+>\s*)?[\w<>\[\],.?\s]+\s+([A-Za-z_]\w*)\s*\(/, kind: 'method', group: 1 },
  ],
  csharp: [
    { re: /^\s*(?:public|internal|protected|private)?\s*(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { re: /^\s*(?:public|internal|protected|private)\s+(?:static\s+|virtual\s+|override\s+|async\s+)*[\w<>\[\]?,.\s]+\s+([A-Za-z_]\w*)\s*\(/, kind: 'method', group: 1 },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct', group: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum', group: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait', group: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: 'type', group: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
  ],
  go: [
    { re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: 'struct', group: 1 },
    { re: /^\s*type\s+([A-Za-z_]\w*)\s+/, kind: 'type', group: 1 },
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: 'function', group: 1 },
  ],
  ruby: [
    { re: /^\s*class\s+([A-Z]\w*)/, kind: 'class', group: 1 },
    { re: /^\s*module\s+([A-Z]\w*)/, kind: 'class', group: 1 },
    { re: /^\s*def\s+(?:self\.)?([a-z_]\w*[?!]?)/, kind: 'function', group: 1 },
  ],
  php: [
    { re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { re: /^\s*interface\s+([A-Za-z_]\w*)/, kind: 'interface', group: 1 },
    { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
  ],
  cpp: [
    { re: /^\s*(?:class|struct)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { re: /^\s*(?:[\w:<>*&\s]+\s+)?([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(/, kind: 'method', group: 2 },
    { re: /^[A-Za-z_][\w:<>*&\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, kind: 'function', group: 1 },
  ],
};

DECLARATIONS['typescriptreact'] = DECLARATIONS['typescript'];
DECLARATIONS['javascript'] = DECLARATIONS['typescript'];
DECLARATIONS['javascriptreact'] = DECLARATIONS['typescript'];
DECLARATIONS['kotlin'] = [
  { re: /^\s*(?:open\s+|abstract\s+|sealed\s+|data\s+)?(?:class|interface|object|enum class)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
  { re: /^\s*(?:private\s+|internal\s+|public\s+|override\s+|suspend\s+)*fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)/, kind: 'function', group: 1 },
];
DECLARATIONS['scala'] = DECLARATIONS['kotlin'];
DECLARATIONS['swift'] = [
  { re: /^\s*(?:public\s+|internal\s+|private\s+|open\s+)?(?:final\s+)?(?:class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
  { re: /^\s*(?:public\s+|private\s+|internal\s+|static\s+|override\s+)*func\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
];
DECLARATIONS['dart'] = DECLARATIONS['swift'];
DECLARATIONS['c'] = DECLARATIONS['cpp'];

// ─── Import patterns ──────────────────────────────────────────────────────────

interface ImportHit { specifier: string; names: string[]; }

function readImports(line: string, language: string): ImportHit | null {
  switch (language) {
    case 'typescript': case 'typescriptreact':
    case 'javascript': case 'javascriptreact': {
      const es = /^\s*import\s+(?:(.+?)\s+from\s+)?['"]([^'"]+)['"]/.exec(line);
      if (es) { return { specifier: es[2], names: bindingNames(es[1] ?? '') }; }
      const cjs = /^\s*(?:const|let|var)\s+(.+?)\s*=\s*require\(\s*['"]([^'"]+)['"]/.exec(line);
      if (cjs) { return { specifier: cjs[2], names: bindingNames(cjs[1]) }; }
      return null;
    }
    case 'python': {
      const from = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
      if (from) {
        return { specifier: from[1], names: from[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(Boolean) };
      }
      const plain = /^\s*import\s+([\w.]+)/.exec(line);
      return plain ? { specifier: plain[1], names: [plain[1].split('.').pop() ?? ''] } : null;
    }
    case 'java': case 'kotlin': case 'scala': {
      const m = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/.exec(line);
      if (!m) { return null; }
      return { specifier: m[1], names: [m[1].split('.').pop() ?? ''].filter(n => n !== '*') };
    }
    case 'go': {
      const m = /^\s*(?:\w+\s+)?"([^"]+)"\s*$/.exec(line);
      return m ? { specifier: m[1], names: [m[1].split('/').pop() ?? ''] } : null;
    }
    case 'rust': {
      const m = /^\s*(?:pub\s+)?use\s+((?:\w+::)*\w+)(?:::\{([^}]*)\})?/.exec(line);
      if (!m) { return null; }
      const names = m[2]
        ? m[2].split(',').map(n => n.trim()).filter(Boolean)
        : [m[1].split('::').pop() ?? ''];
      return { specifier: m[1], names };
    }
    case 'csharp': {
      const m = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/.exec(line);
      return m ? { specifier: m[1], names: [m[1].split('.').pop() ?? ''] } : null;
    }
    case 'php': {
      const m = /^\s*use\s+([\w\\]+)/.exec(line);
      return m ? { specifier: m[1], names: [m[1].split('\\').pop() ?? ''] } : null;
    }
    case 'ruby': {
      const m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(line);
      return m ? { specifier: m[1], names: [] } : null;
    }
    case 'c': case 'cpp': {
      const m = /^\s*#include\s+[<"]([^>"]+)[>"]/.exec(line);
      return m ? { specifier: m[1], names: [] } : null;
    }
    default:
      return null;
  }
}

/** `{ a, b as c }`, `Foo`, `* as ns` → the names actually brought into scope. */
function bindingNames(clause: string): string[] {
  const names: string[] = [];
  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced) {
    for (const part of braced[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) { names.push(name); }
    }
  }
  const bare = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s+as\s+/g, '').split(',');
  for (const part of bare) {
    const name = part.trim().split(/\s+as\s+/).pop()?.trim();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) { names.push(name); }
  }
  return names;
}

// ─── Reading one file ─────────────────────────────────────────────────────────

/**
 * Reduce a source file to its declarations and imports. Only the head of the
 * file is searched for imports — every language this handles puts them there,
 * and scanning the whole file for them doubles the cost for nothing.
 */
export function summariseSource(
  relPath: string, text: string, language: string, mtime: number, size: number
): IndexedFile {
  const patterns = DECLARATIONS[language] ?? [];
  const lines = text.split('\n');
  const symbols: IndexedSymbol[] = [];
  const imports: string[] = [];
  const importedNames = new Set<string>();
  const IMPORT_WINDOW = Math.min(lines.length, 120);
  const MAX_SYMBOLS = 240;

  for (let i = 0; i < IMPORT_WINDOW; i++) {
    const hit = readImports(lines[i], language);
    if (!hit) { continue; }
    imports.push(hit.specifier);
    for (const name of hit.names) { if (name) { importedNames.add(name); } }
  }

  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i++) {
    const line = lines[i];
    if (line.length > 400) { continue; }
    for (const pattern of patterns) {
      const m = pattern.re.exec(line);
      if (!m) { continue; }
      const name = m[pattern.group];
      if (!name || RESERVED.has(name)) { break; }
      symbols.push({
        name,
        kind: pattern.kind,
        line: i,
        signature: line.trim().slice(0, 200),
        exported: /\b(export|pub|public)\b/.test(line) || language === 'python' || language === 'go',
      });
      break;
    }
  }

  return {
    path: relPath, language, mtime, size, symbols,
    imports, importedNames: [...importedNames], edges: [],
  };
}

/** Control-flow words the loose patterns would otherwise read as declarations. */
const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try',
  'match', 'when', 'with', 'case', 'new', 'delete', 'typeof', 'await',
]);

// ─── Import resolution ────────────────────────────────────────────────────────

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Turn a module specifier into a file this index holds. Relative paths are
 * resolved properly; everything else falls back to matching the last segment
 * against file names, which is how a Java or C# import has to be read anyway.
 */
function resolveSpecifier(
  from: string, specifier: string, language: string, byPath: Map<string, IndexedFile>,
  byBasename: Map<string, string[]>
): string | null {
  if (specifier.startsWith('.')) {
    const base = normalise(path.posix.join(path.posix.dirname(from), specifier));
    if (byPath.has(base)) { return base; }
    for (const ext of TS_EXTENSIONS) {
      if (byPath.has(base + ext)) { return base + ext; }
      if (byPath.has(`${base}/index${ext}`)) { return `${base}/index${ext}`; }
    }
    if (byPath.has(base + '.py')) { return base + '.py'; }
    if (byPath.has(base + '.rb')) { return base + '.rb'; }
    return null;
  }

  if (language === 'python') {
    const asPath = specifier.replace(/\./g, '/');
    for (const candidate of [`${asPath}.py`, `${asPath}/__init__.py`]) {
      const hit = [...byPath.keys()].find(p => p === candidate || p.endsWith('/' + candidate));
      if (hit) { return hit; }
    }
  }

  const tail = specifier.split(/[./\\:]/).filter(Boolean).pop();
  if (!tail) { return null; }
  const candidates = byBasename.get(tail.toLowerCase());
  if (!candidates || candidates.length === 0) { return null; }
  // A package-qualified import narrows to the candidate whose path matches most
  // of the specifier; a bare name takes the only candidate or nothing.
  if (candidates.length === 1) { return candidates[0]; }
  const wanted = specifier.replace(/[.\\]/g, '/').toLowerCase();
  return candidates.find(c => wanted.includes(c.replace(/\.\w+$/, '').toLowerCase())) ?? null;
}

function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

// ─── The index ────────────────────────────────────────────────────────────────

const CACHE_VERSION = 2;

interface PersistedIndex {
  version: number;
  root: string;
  builtAt: number;
  files: IndexedFile[];
}

export class ProjectIndex {
  private files = new Map<string, IndexedFile>();
  /** Lowercased symbol name → the paths declaring it. */
  private symbolIndex = new Map<string, { path: string; symbol: IndexedSymbol }[]>();
  /** Path → the paths that import it. */
  private importers = new Map<string, Set<string>>();
  /** Lowercased basename → paths, for resolving non-relative specifiers. */
  private byBasename = new Map<string, string[]>();

  private status: IndexStatus = {
    state: 'idle', files: 0, symbols: 0, builtInMs: 0, truncated: false,
  };
  private building: Promise<void> | null = null;
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: vscode.Uri | undefined,
    private options: IndexOptions = DEFAULT_INDEX_OPTIONS
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  getStatus(): IndexStatus { return { ...this.status }; }

  isReady(): boolean { return this.status.state === 'ready'; }

  setOptions(options: IndexOptions): void { this.options = options; }

  /**
   * Bring the index up to date. Reuses the disk cache for every file whose
   * mtime and size are unchanged, so the common case — reopening a workspace
   * nobody has touched — costs a directory listing and a JSON parse.
   *
   * Concurrent calls join the build in progress rather than starting a second.
   */
  async build(progress?: (done: number, total: number) => void): Promise<void> {
    if (this.building) { return this.building; }
    this.building = this.runBuild(progress).finally(() => { this.building = null; });
    return this.building;
  }

  private async runBuild(progress?: (done: number, total: number) => void): Promise<void> {
    const started = Date.now();
    this.status = { ...this.status, state: 'building' };

    const cached = await this.readCache();
    const previous = new Map(cached.map(f => [f.path, f]));

    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        SOURCE_GLOB, `{${[...ALWAYS_EXCLUDED, ...this.options.exclude].join(',')}}`,
        this.options.maxFiles
      );
    } catch {
      this.status = { ...this.status, state: 'idle' };
      return;
    }

    const truncated = uris.length >= this.options.maxFiles;
    const next = new Map<string, IndexedFile>();
    const sizeCeiling = this.options.maxFileSizeKb * 1024;
    let done = 0;

    // Read in batches, yielding between them. The extension host is shared with
    // the editor's own work; a tight loop over a few thousand files would be
    // felt as a stall even though none of this is on the completion path.
    const BATCH = 24;
    for (let i = 0; i < uris.length; i += BATCH) {
      const batch = uris.slice(i, i + BATCH);
      await Promise.all(batch.map(async uri => {
        const rel = normalise(vscode.workspace.asRelativePath(uri, false));
        const language = EXT_LANGUAGE[path.extname(uri.fsPath).toLowerCase()];
        if (!language) { return; }

        let stat: vscode.FileStat;
        try { stat = await vscode.workspace.fs.stat(uri); } catch { return; }
        if (stat.size > sizeCeiling) { return; }

        const hit = previous.get(rel);
        if (hit && hit.mtime === stat.mtime && hit.size === stat.size) {
          next.set(rel, hit);
          return;
        }

        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(bytes).toString('utf8');
          next.set(rel, summariseSource(rel, text, language, stat.mtime, stat.size));
        } catch {
          // Binary, unreadable or deleted between the listing and the read.
        }
      }));

      done += batch.length;
      progress?.(done, uris.length);
      await yieldToHost();
    }

    this.files = next;
    this.reindex();
    this.status = {
      state: 'ready',
      files: this.files.size,
      symbols: this.symbolIndex.size,
      builtInMs: Date.now() - started,
      truncated,
    };
    await this.writeCache();
  }

  /** Re-read one file after an edit, keeping the rest of the index intact. */
  async refresh(uri: vscode.Uri): Promise<void> {
    const language = EXT_LANGUAGE[path.extname(uri.fsPath).toLowerCase()];
    if (!language) { return; }
    const rel = normalise(vscode.workspace.asRelativePath(uri, false));

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > this.options.maxFileSizeKb * 1024) { this.files.delete(rel); }
      else {
        const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        const text = open
          ? open.getText()
          : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        this.files.set(rel, summariseSource(rel, text, language, stat.mtime, stat.size));
      }
    } catch {
      this.files.delete(rel);
    }

    this.reindex();
    this.status = { ...this.status, files: this.files.size, symbols: this.symbolIndex.size };
    this.scheduleFlush();
  }

  forget(uri: vscode.Uri): void {
    const rel = normalise(vscode.workspace.asRelativePath(uri, false));
    if (!this.files.delete(rel)) { return; }
    this.reindex();
    this.scheduleFlush();
  }

  clear(): void {
    this.files.clear();
    this.symbolIndex.clear();
    this.importers.clear();
    this.byBasename.clear();
    this.status = { state: 'idle', files: 0, symbols: 0, builtInMs: 0, truncated: false };
  }

  // ── Derived tables ────────────────────────────────────────────────────────

  private reindex(): void {
    this.symbolIndex.clear();
    this.importers.clear();
    this.byBasename.clear();

    for (const file of this.files.values()) {
      const base = path.posix.basename(file.path).replace(/\.\w+$/, '').toLowerCase();
      const bucket = this.byBasename.get(base);
      if (bucket) { bucket.push(file.path); } else { this.byBasename.set(base, [file.path]); }

      for (const symbol of file.symbols) {
        const key = symbol.name.toLowerCase();
        const entry = this.symbolIndex.get(key);
        if (entry) { entry.push({ path: file.path, symbol }); }
        else { this.symbolIndex.set(key, [{ path: file.path, symbol }]); }
      }
    }

    for (const file of this.files.values()) {
      file.edges = [];
      for (const specifier of file.imports) {
        const target = resolveSpecifier(
          file.path, specifier, file.language, this.files, this.byBasename);
        if (!target || target === file.path) { continue; }
        file.edges.push(target);
        const back = this.importers.get(target);
        if (back) { back.add(file.path); } else { this.importers.set(target, new Set([file.path])); }
      }
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** Every declaration of a name, best match first (exact case beats fold). */
  lookup(name: string, limit = 6): { path: string; symbol: IndexedSymbol }[] {
    const hits = this.symbolIndex.get(name.toLowerCase()) ?? [];
    return [...hits]
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);

    function score(hit: { path: string; symbol: IndexedSymbol }): number {
      return (hit.symbol.name === name ? 4 : 0)
        + (hit.symbol.exported ? 2 : 0)
        + (hit.symbol.kind === 'class' || hit.symbol.kind === 'interface' ? 1 : 0);
    }
  }

  /** The files that import this one — who breaks if its contract changes. */
  dependents(relPath: string, limit = 12): string[] {
    return [...(this.importers.get(normalise(relPath)) ?? [])].slice(0, limit);
  }

  /** The files this one imports, as far as they resolved inside the workspace. */
  dependencies(relPath: string): string[] {
    return this.files.get(normalise(relPath))?.edges ?? [];
  }

  get(relPath: string): IndexedFile | undefined {
    return this.files.get(normalise(relPath));
  }

  /**
   * Files near this one in the sense that matters for completion: what it
   * imports, what imports it, then its siblings on disk. Ordered, so a caller
   * with a small budget takes from the front and gets the most relevant.
   */
  neighbourhood(relPath: string, limit = 12): string[] {
    const self = normalise(relPath);
    const ordered: string[] = [];
    const seen = new Set([self]);

    const push = (p: string) => {
      if (seen.has(p) || !this.files.has(p)) { return; }
      seen.add(p);
      ordered.push(p);
    };

    for (const edge of this.dependencies(self)) { push(edge); }
    for (const back of this.importers.get(self) ?? []) { push(back); }

    // One more hop out, so a type reached through a barrel file is still found.
    for (const edge of [...ordered]) {
      if (ordered.length >= limit * 2) { break; }
      for (const next of this.dependencies(edge)) { push(next); }
    }

    const dir = path.posix.dirname(self);
    for (const file of this.files.keys()) {
      if (ordered.length >= limit * 2) { break; }
      if (path.posix.dirname(file) === dir) { push(file); }
    }

    return ordered.slice(0, limit);
  }

  /**
   * The declarations behind a set of names, rendered for a prompt. This is the
   * whole point of the index on the completion path: the model is told what
   * `OrderRepository.findByCustomer` actually takes, rather than guessing.
   */
  declarationsFor(names: Iterable<string>, budgetChars = 2000): string {
    const blocks: string[] = [];
    const used = new Set<string>();
    let spent = 0;

    for (const name of names) {
      if (spent >= budgetChars) { break; }
      for (const hit of this.lookup(name, 2)) {
        const key = `${hit.path}:${hit.symbol.line}`;
        if (used.has(key)) { continue; }
        used.add(key);
        const line = `${hit.path}:${hit.symbol.line + 1}  ${hit.symbol.signature}`;
        if (spent + line.length > budgetChars) { break; }
        blocks.push(line);
        spent += line.length + 1;
      }
    }

    return blocks.length
      ? `// Declarations found elsewhere in this project:\n${blocks.map(b => `//   ${b}`).join('\n')}`
      : '';
  }

  /**
   * The cross-file context block for a completion: the declarations of the
   * names visible at the cursor, plus a sketch of the files this one is wired
   * to. Bounded by characters rather than files, because one large module
   * should not crowd out five small ones.
   */
  completionContext(relPath: string, referenced: Iterable<string>, budgetChars = 2400): string {
    const sections: string[] = [];
    const declarations = this.declarationsFor(referenced, Math.floor(budgetChars * 0.6));
    if (declarations) { sections.push(declarations); }

    const neighbours = this.neighbourhood(relPath, 6);
    const sketch: string[] = [];
    let spent = declarations.length;

    for (const neighbour of neighbours) {
      const file = this.files.get(neighbour);
      if (!file || file.symbols.length === 0) { continue; }
      const exported = file.symbols.filter(s => s.exported).slice(0, 6);
      if (exported.length === 0) { continue; }
      const block = `// ${neighbour}\n${exported.map(s => `//   ${s.signature}`).join('\n')}`;
      if (spent + block.length > budgetChars) { break; }
      sketch.push(block);
      spent += block.length;
    }

    if (sketch.length) {
      sections.push(`// Related files:\n${sketch.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  /** Orientation rather than detail — what kind of project this is. */
  digest(): ProjectDigest {
    const byLanguage = new Map<string, number>();
    const byArea = new Map<string, number>();

    for (const file of this.files.values()) {
      byLanguage.set(file.language, (byLanguage.get(file.language) ?? 0) + 1);
      const top = file.path.includes('/') ? file.path.split('/')[0] : '.';
      byArea.set(top, (byArea.get(top) ?? 0) + 1);
    }

    const entryPoints = [...this.files.values()]
      .filter(f => (this.importers.get(f.path)?.size ?? 0) === 0 && f.edges.length >= 2)
      .sort((a, b) => b.edges.length - a.edges.length)
      .slice(0, 6)
      .map(f => f.path);

    return {
      languages: [...byLanguage].map(([language, files]) => ({ language, files }))
        .sort((a, b) => b.files - a.files),
      manifests: this.manifests,
      entryPoints,
      areas: [...byArea].map(([dir, files]) => ({ dir, files }))
        .sort((a, b) => b.files - a.files).slice(0, 8),
      totalFiles: this.files.size,
    };
  }

  /** Rendered digest, for the prompts that open with "this is the project". */
  renderDigest(): string {
    const d = this.digest();
    if (d.totalFiles === 0) { return ''; }
    const lines = [`Project: ${d.totalFiles} source files indexed.`];
    if (d.languages.length) {
      lines.push(`Languages: ${d.languages.slice(0, 4).map(l => `${l.language} (${l.files})`).join(', ')}.`);
    }
    if (d.areas.length) {
      lines.push(`Layout: ${d.areas.map(a => `${a.dir}/ (${a.files})`).join(', ')}.`);
    }
    if (d.manifests.length) { lines.push(`Manifests: ${d.manifests.join(', ')}.`); }
    if (d.entryPoints.length) { lines.push(`Likely entry points: ${d.entryPoints.join(', ')}.`); }
    return lines.join('\n');
  }

  private manifests: string[] = [];

  /** Called by the owner once per build; cheap enough not to cache harder. */
  async findManifests(): Promise<void> {
    const found: string[] = [];
    for (const name of MANIFEST_NAMES) {
      try {
        const hits = await vscode.workspace.findFiles(
          name.includes('*') ? `**/${name}` : `**/${name}`,
          `{${ALWAYS_EXCLUDED.join(',')}}`, 3);
        for (const hit of hits) { found.push(normalise(vscode.workspace.asRelativePath(hit, false))); }
      } catch { /* a folder that cannot be listed is not a manifest */ }
    }
    this.manifests = found.slice(0, 12);
  }

  // ── Disk cache ────────────────────────────────────────────────────────────

  private cacheUri(): vscode.Uri | null {
    if (!this.storage) { return null; }
    return vscode.Uri.joinPath(this.storage, `project-index-${this.workspaceKey()}.json`);
  }

  private workspaceKey(): string {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()).join('|');
    let hash = 0;
    for (let i = 0; i < roots.length; i++) {
      hash = (hash * 31 + roots.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  private async readCache(): Promise<IndexedFile[]> {
    const uri = this.cacheUri();
    if (!uri) { return []; }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as PersistedIndex;
      if (parsed.version !== CACHE_VERSION) { return []; }
      return parsed.files ?? [];
    } catch {
      return [];
    }
  }

  private async writeCache(): Promise<void> {
    const uri = this.cacheUri();
    if (!uri || !this.storage) { return; }
    const payload: PersistedIndex = {
      version: CACHE_VERSION,
      root: this.workspaceKey(),
      builtAt: Date.now(),
      // `edges` is derived, so it is not worth the disk space or the risk of
      // loading a graph that no longer matches the files.
      files: [...this.files.values()].map(f => ({ ...f, edges: [] })),
    };
    try {
      await vscode.workspace.fs.createDirectory(this.storage);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload), 'utf8'));
    } catch {
      // A read-only or missing storage directory costs a slower next start,
      // nothing more.
    }
  }

  /** Coalesce the writes that follow a burst of saves into one. */
  private scheduleFlush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); }
    this.flushTimer = setTimeout(() => { void this.writeCache(); }, 4_000);
  }

  dispose(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); }
    this.dirty.clear();
  }
}

function yieldToHost(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Module-level handle ──────────────────────────────────────────────────────
//
// The completion path reaches for the index through a function rather than an
// injected dependency, because it is optional: every caller has to work when
// the index has not been built, is disabled, or is still warming up.

let active: ProjectIndex | null = null;

export function setProjectIndex(index: ProjectIndex | null): void { active = index; }

export function getProjectIndex(): ProjectIndex | null { return active; }
