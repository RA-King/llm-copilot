import * as vscode from 'vscode';
import { SurroundingContext } from './signatureExtractor';

/**
 * semanticContext.ts
 *
 * Talks to the *language's own analyser* — whichever language server is
 * installed for the file (tsserver, Pylance, rust-analyzer, jdt.ls, gopls,
 * clangd, OmniSharp…) — through VS Code's `vscode.execute*Provider` command
 * bridge.
 *
 * That server has already parsed and type-checked the project, so it is the
 * authority on:
 *   • what the enclosing symbol actually is          (document symbols)
 *   • what identifiers are legal at this exact point (completion provider)
 *   • what type a referenced identifier has          (hover provider)
 *   • the real source of an imported declaration     (definition provider)
 *   • the parameters of the call being typed         (signature help)
 *
 * Everything here is best-effort and time-budgeted: if no language server is
 * installed, or it is still indexing, every call fails soft and the regex
 * layer in `signatureExtractor.ts` carries the context on its own.
 */

// ─── Result types ─────────────────────────────────────────────────────────────

export interface SymbolInScope {
  name: string;
  kind: string;
  detail: string;   // usually the signature/type as the language server prints it
}

export interface ResolvedDeclaration {
  /** Workspace-relative path the declaration lives in */
  file: string;
  /** The declaration source, trimmed to a useful number of lines */
  code: string;
  /** The symbol this declaration was resolved for */
  symbol: string;
}

export interface SemanticContext {
  /** `Container.method` path from the document symbol tree */
  symbolPath: string;
  /** Signature/detail of the innermost enclosing symbol, per the language server */
  enclosingDetail: string;
  /** Identifiers the language server says are valid at the cursor */
  symbolsInScope: SymbolInScope[];
  /** Type information for identifiers on the current line */
  hoverTypes: Array<{ name: string; type: string }>;
  /** Declarations pulled from the files the current file actually depends on */
  declarations: ResolvedDeclaration[];
  /** Active call signature, when the cursor sits inside a call's arguments */
  activeSignature: string;
  /** Diagnostics already present around the cursor — the model should not repeat them */
  nearbyDiagnostics: string[];
  /** True when at least one provider answered (i.e. a language server exists) */
  languageServerAvailable: boolean;
}

export function emptySemanticContext(): SemanticContext {
  return {
    symbolPath: '', enclosingDetail: '', symbolsInScope: [], hoverTypes: [],
    declarations: [], activeSignature: '', nearbyDiagnostics: [],
    languageServerAvailable: false,
  };
}

// ─── Small utilities ──────────────────────────────────────────────────────────

const SYMBOL_KIND_NAMES: Record<number, string> = {
  0: 'file', 1: 'module', 2: 'namespace', 3: 'package', 4: 'class', 5: 'method',
  6: 'property', 7: 'field', 8: 'constructor', 9: 'enum', 10: 'interface',
  11: 'function', 12: 'variable', 13: 'constant', 14: 'string', 15: 'number',
  16: 'boolean', 17: 'array', 18: 'object', 19: 'key', 20: 'null',
  21: 'enum-member', 22: 'struct', 23: 'event', 24: 'operator', 25: 'type-parameter',
};

const COMPLETION_KIND_NAMES: Record<number, string> = {
  0: 'text', 1: 'method', 2: 'function', 3: 'constructor', 4: 'field',
  5: 'variable', 6: 'class', 7: 'interface', 8: 'module', 9: 'property',
  10: 'unit', 11: 'value', 12: 'enum', 13: 'keyword', 14: 'snippet',
  15: 'color', 16: 'file', 17: 'reference', 18: 'folder', 19: 'enum-member',
  20: 'constant', 21: 'struct', 22: 'event', 23: 'operator', 24: 'type-parameter',
};

/** Run a command with a hard timeout; never throws. */
async function withBudget<T>(
  fn: () => Thenable<T>,
  ms: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(fn()).then(v => (v ?? fallback)),
      new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) { clearTimeout(timer); }
  }
}

function plainText(v: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof v === 'string') { return v; }
  if ('value' in v) { return v.value; }
  return '';
}

/** Reduce a hover blob to just the signature/type line. */
function distilHover(contents: Array<vscode.MarkdownString | vscode.MarkedString>): string {
  const text = contents.map(plainText).join('\n');
  // Language servers put the signature in a fenced block first
  const fenced = text.match(/```[\w]*\r?\n([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const firstMeaningful = body
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('*') && !l.startsWith('---'));
  return (firstMeaningful ?? '').replace(/\s+/g, ' ').slice(0, 200);
}

// ─── Document symbols → enclosing symbol path ─────────────────────────────────

interface FlatSymbol { name: string; detail: string; kind: string; range: vscode.Range; depth: number; }

function flattenSymbols(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position,
  depth = 0,
  acc: FlatSymbol[] = []
): FlatSymbol[] {
  for (const s of symbols) {
    if (!s.range.contains(position)) { continue; }
    acc.push({
      name: s.name,
      detail: s.detail ?? '',
      kind: SYMBOL_KIND_NAMES[s.kind as unknown as number] ?? 'symbol',
      range: s.range,
      depth,
    });
    if (s.children?.length) { flattenSymbols(s.children, position, depth + 1, acc); }
  }
  return acc;
}

async function getEnclosingSymbols(
  uri: vscode.Uri,
  position: vscode.Position,
  budgetMs: number
): Promise<FlatSymbol[]> {
  const symbols = await withBudget<vscode.DocumentSymbol[] | undefined>(
    () => vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', uri),
    budgetMs,
    undefined
  );
  if (!symbols?.length) { return []; }
  // SymbolInformation[] (flat) also possible — only DocumentSymbol has `.children`
  if (!('children' in symbols[0]) && !('range' in symbols[0])) { return []; }
  try { return flattenSymbols(symbols, position); } catch { return []; }
}

// ─── Completion provider → identifiers legal at the cursor ────────────────────

/**
 * Ask the language server what may legally appear here. This is the single
 * highest-value signal: it is the language's real scope resolution, including
 * inherited members, imported symbols and generic instantiations.
 */
async function getSymbolsInScope(
  uri: vscode.Uri,
  position: vscode.Position,
  budgetMs: number,
  limit: number
): Promise<SymbolInScope[]> {
  const list = await withBudget<vscode.CompletionList | undefined>(
    () => vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', uri, position, undefined, limit * 3),
    budgetMs,
    undefined
  );
  const items = list?.items;
  if (!items?.length) { return []; }

  const ranked = items
    .filter(i => {
      const kind = i.kind as unknown as number;
      // Drop keywords, snippets, text and file/folder noise — we want real symbols
      return kind !== 13 && kind !== 14 && kind !== 0 && kind !== 16 && kind !== 18;
    })
    .slice(0, limit * 2)
    .map(i => {
      const label = typeof i.label === 'string' ? i.label : i.label.label;
      const labelDetail = typeof i.label === 'string' ? '' : (i.label.detail ?? '');
      const detail = (i.detail ?? '') || labelDetail;
      return {
        name: label,
        kind: COMPLETION_KIND_NAMES[i.kind as unknown as number] ?? 'symbol',
        detail: detail.replace(/\s+/g, ' ').slice(0, 120),
      };
    });

  // Prefer entries that carry type information — those teach the model the most
  ranked.sort((a, b) => (b.detail ? 1 : 0) - (a.detail ? 1 : 0));

  const seen = new Set<string>();
  const out: SymbolInScope[] = [];
  for (const r of ranked) {
    if (!r.name || r.name.startsWith('_') || seen.has(r.name)) { continue; }
    seen.add(r.name);
    out.push(r);
    if (out.length >= limit) { break; }
  }
  return out;
}

// ─── Hover → types of the identifiers actually referenced nearby ──────────────

async function getHoverTypes(
  document: vscode.TextDocument,
  position: vscode.Position,
  names: string[],
  budgetMs: number
): Promise<Array<{ name: string; type: string }>> {
  if (!names.length) { return []; }
  const deadline = Date.now() + budgetMs;
  const out: Array<{ name: string; type: string }> = [];
  const searchStart = Math.max(0, position.line - 25);

  for (const name of names) {
    if (Date.now() > deadline) { break; }
    const at = findIdentifierPosition(document, name, searchStart, position.line);
    if (!at) { continue; }
    const hovers = await withBudget<vscode.Hover[] | undefined>(
      () => vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', document.uri, at),
      Math.max(60, deadline - Date.now()),
      undefined
    );
    if (!hovers?.length) { continue; }
    const type = distilHover(hovers.flatMap(h => h.contents));
    if (type) { out.push({ name, type }); }
  }
  return out;
}

/** Locate the last occurrence of `name` as a whole word in a line window. */
function findIdentifierPosition(
  document: vscode.TextDocument,
  name: string,
  fromLine: number,
  toLine: number
): vscode.Position | null {
  const re = new RegExp(`\\b${escapeRe(name)}\\b`);
  for (let i = toLine; i >= fromLine; i--) {
    if (i < 0 || i >= document.lineCount) { continue; }
    let text = '';
    try { text = document.lineAt(i).text; } catch { continue; }
    const m = re.exec(text);
    if (m && m.index >= 0) { return new vscode.Position(i, m.index + 1); }
  }
  return null;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── Definition provider → read the files the code actually depends on ────────

/**
 * For each referenced type/function, ask the language server where it is
 * defined, open THAT file, and lift the declaration out of it.
 *
 * This is the "read the needed files" step: instead of grepping the whole
 * workspace and guessing, we follow the real resolution the compiler performs.
 */
async function resolveDeclarations(
  document: vscode.TextDocument,
  position: vscode.Position,
  names: string[],
  budgetMs: number,
  maxDeclarations: number
): Promise<ResolvedDeclaration[]> {
  if (!names.length) { return []; }
  const deadline = Date.now() + budgetMs;
  const out: ResolvedDeclaration[] = [];
  const visited = new Set<string>();
  const searchStart = Math.max(0, position.line - 60);

  for (const name of names) {
    if (out.length >= maxDeclarations || Date.now() > deadline) { break; }
    const at = findIdentifierPosition(document, name, searchStart, position.line);
    if (!at) { continue; }

    const locations = await withBudget<Array<vscode.Location | vscode.LocationLink> | undefined>(
      () => vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeDefinitionProvider', document.uri, at),
      Math.max(80, Math.min(400, deadline - Date.now())),
      undefined
    );
    if (!locations?.length) { continue; }

    for (const loc of locations.slice(0, 1)) {
      const uri = 'uri' in loc ? loc.uri : loc.targetUri;
      const range = 'range' in loc ? loc.range : (loc.targetRange ?? loc.targetSelectionRange);
      if (!uri || !range) { continue; }
      // Skip self-definitions and node_modules type stubs that bloat the prompt
      const key = `${uri.toString()}:${range.start.line}`;
      if (visited.has(key)) { continue; }
      visited.add(key);
      if (uri.toString() === document.uri.toString()
          && Math.abs(range.start.line - position.line) < 3) { continue; }

      const code = await readDeclaration(uri, range, deadline);
      if (!code) { continue; }
      out.push({
        file: vscode.workspace.asRelativePath(uri),
        code,
        symbol: name,
      });
    }
  }
  return out;
}

/** Open the target file and lift out the declaration (signature + members). */
async function readDeclaration(
  uri: vscode.Uri,
  range: vscode.Range,
  deadline: number,
  maxLines = 26
): Promise<string> {
  if (Date.now() > deadline) { return ''; }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch { return ''; }

  const start = Math.max(0, range.start.line);
  // Prefer the language server's own full range when it gave us one
  const declaredEnd = range.end.line > range.start.line ? range.end.line : start;
  const end = Math.min(doc.lineCount - 1, Math.max(declaredEnd, start + maxLines - 1));

  const lines: string[] = [];
  let depth = 0;
  let sawBody = false;

  for (let i = start; i <= end; i++) {
    let text = '';
    try { text = doc.lineAt(i).text; } catch { break; }
    lines.push(text);

    for (const ch of text) {
      if (ch === '{') { depth++; sawBody = true; }
      else if (ch === '}') { depth--; }
    }
    // Stop at the end of the declaration's body
    if (sawBody && depth <= 0 && i > start) { break; }
    // For signature-only languages / interfaces, stop at a blank line
    if (!sawBody && i > start && text.trim() === '') { lines.pop(); break; }
    if (lines.length >= maxLines) { lines.push('  // …'); break; }
  }

  // Trim common leading indentation so the prompt stays compact
  const nonBlank = lines.filter(l => l.trim());
  if (!nonBlank.length) { return ''; }
  const minIndent = Math.min(...nonBlank.map(l => (l.match(/^\s*/)?.[0].length ?? 0)));
  return lines.map(l => l.slice(minIndent)).join('\n').trim();
}

// ─── Signature help → the call the cursor is inside ───────────────────────────

async function getActiveSignature(
  uri: vscode.Uri,
  position: vscode.Position,
  budgetMs: number
): Promise<string> {
  const help = await withBudget<vscode.SignatureHelp | undefined>(
    () => vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider', uri, position),
    budgetMs,
    undefined
  );
  const sig = help?.signatures?.[help.activeSignature ?? 0];
  if (!sig) { return ''; }
  const active = sig.parameters?.[help!.activeParameter ?? 0];
  const paramLabel = active
    ? (typeof active.label === 'string' ? active.label : sig.label.slice(active.label[0], active.label[1]))
    : '';
  return paramLabel
    ? `${sig.label}   (currently filling: ${paramLabel})`
    : sig.label;
}

// ─── Diagnostics near the cursor ──────────────────────────────────────────────

function getNearbyDiagnostics(uri: vscode.Uri, position: vscode.Position): string[] {
  try {
    return vscode.languages.getDiagnostics(uri)
      .filter(d => Math.abs(d.range.start.line - position.line) <= 6)
      .filter(d => d.severity === vscode.DiagnosticSeverity.Error
                || d.severity === vscode.DiagnosticSeverity.Warning)
      .slice(0, 4)
      .map(d => `line ${d.range.start.line + 1}: ${d.message.replace(/\s+/g, ' ').slice(0, 160)}`);
  } catch { return []; }
}

// ─── Which names are worth resolving ──────────────────────────────────────────

/**
 * Choose the identifiers to spend hover/definition budget on: the types that
 * appear in the enclosing signature, plus types referenced on the current line.
 */
export function selectNamesToResolve(
  surrounding: SurroundingContext,
  linePrefix: string,
  limit = 8
): string[] {
  const scored = new Map<string, number>();
  const bump = (n: string, by: number) => {
    if (!n || n.length < 2 || !/^[A-Za-z_$]/.test(n)) { return; }
    scored.set(n, (scored.get(n) ?? 0) + by);
  };

  // Types named in the enclosing signature carry the most weight
  const e = surrounding.enclosing;
  if (e) {
    for (const p of e.params) { for (const t of typeNames(p.type)) { bump(t, 6); } }
    for (const t of typeNames(e.returnType)) { bump(t, 8); }
    for (const t of typeNames(e.throws)) { bump(t, 3); }
  }
  if (surrounding.container) { bump(surrounding.container.name, 5); }

  // Types of bindings in scope
  for (const b of surrounding.bindings) { for (const t of typeNames(b.type)) { bump(t, 3); } }

  // Whatever the user is typing right now matters most of all
  for (const m of linePrefix.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) { bump(m[1], 10); }
  // The receiver of a member access being typed: `foo.ba|`
  const receiver = linePrefix.match(/([A-Za-z_$][\w$]*)\s*(?:\.|->|::)\s*\w*$/);
  if (receiver) { bump(receiver[1], 14); }

  // Free identifiers (likely imports) get a small nudge
  for (const f of surrounding.freeIdentifiers) { bump(f, 1); }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n)
    .filter(n => !PRIMITIVES.has(n))
    .slice(0, limit);
}

const PRIMITIVES = new Set([
  'string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'object',
  'int', 'long', 'short', 'byte', 'char', 'float', 'double', 'bool', 'str',
  'i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'usize', 'isize', 'f32', 'f64',
  'Self', 'self', 'this', 'null', 'undefined', 'None', 'Any', 'var', 'val', 'let',
  'const', 'auto', 'error', 'nil', 'true', 'false',
]);

/** Pull the bare type names out of a type expression like `Map<string, Foo[]>`. */
export function typeNames(type: string): string[] {
  if (!type) { return []; }
  const out: string[] = [];
  for (const m of type.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    if (!PRIMITIVES.has(m[1])) { out.push(m[1]); }
  }
  return out;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface SemanticOptions {
  /** Ceiling on the wall-clock budget for the whole gather (ms). The effective
   *  budget adapts downward from here based on how fast this language server
   *  has actually been. */
  budgetMs?: number;
  /** Max in-scope symbols to report */
  maxSymbols?: number;
  /** Max cross-file declarations to read */
  maxDeclarations?: number;
}

// ─── Per-language health tracking ─────────────────────────────────────────────

/**
 * The budget is a TIMEOUT, not a wait: a responsive language server returns
 * immediately no matter how high it is set. It only costs us when the server is
 * slow or absent — so we learn each language's real latency and stop waiting
 * far longer than it has ever needed.
 *
 * A language with no server installed is far more expensive than a slow one:
 * every completion pays the full budget to learn nothing. After a few empty
 * answers in a row that language is skipped outright for a cooldown period.
 */
interface LanguageHealth {
  /** Exponentially-weighted mean of observed gather durations (ms) */
  ewmaMs: number;
  /** Consecutive gathers where no provider answered at all */
  emptyStreak: number;
  /** Skip semantic gathering for this language until this timestamp */
  skipUntil: number;
  /** Whether a language server has ever answered for this language */
  everAnswered: boolean;
}

const health = new Map<string, LanguageHealth>();

const EMPTY_STREAK_LIMIT = 3;
const COOLDOWN_MS = 60_000;
const MIN_BUDGET_MS = 150;
/** How much slack to allow over the observed mean before timing out */
const BUDGET_SLACK = 3;

function healthFor(language: string): LanguageHealth {
  let h = health.get(language);
  if (!h) {
    h = { ewmaMs: 0, emptyStreak: 0, skipUntil: 0, everAnswered: false };
    health.set(language, h);
  }
  return h;
}

/**
 * The budget to actually use, given what this language server has done before.
 * Returns 0 when the language is in cooldown — the caller should skip entirely.
 */
export function effectiveBudget(language: string, ceilingMs: number): number {
  const h = healthFor(language);
  if (Date.now() < h.skipUntil) { return 0; }
  if (h.ewmaMs <= 0) { return ceilingMs; }
  return Math.min(ceilingMs, Math.max(MIN_BUDGET_MS, Math.round(h.ewmaMs * BUDGET_SLACK)));
}

function recordGather(language: string, durationMs: number, answered: boolean): void {
  const h = healthFor(language);
  h.ewmaMs = h.ewmaMs > 0 ? h.ewmaMs * 0.7 + durationMs * 0.3 : durationMs;
  if (answered) {
    h.everAnswered = true;
    h.emptyStreak = 0;
    h.skipUntil = 0;
  } else {
    h.emptyStreak++;
    if (h.emptyStreak >= EMPTY_STREAK_LIMIT) {
      // Nothing is listening for this language — stop paying to find out.
      h.skipUntil = Date.now() + COOLDOWN_MS;
      h.emptyStreak = 0;
    }
  }
}

/**
 * True when a language server has answered for this language. The caller uses
 * this to skip the workspace-wide regex scan, which exists only as the
 * no-language-server fallback and is far more expensive than it is worth once
 * real symbol resolution is available.
 */
export function hasLanguageServer(language: string): boolean {
  return healthFor(language).everAnswered;
}

/** Test seam — forget everything learned about language-server health. */
export function __resetSemanticHealth(): void { health.clear(); }

/**
 * Gather everything the language's own analyser knows about this cursor.
 * Every sub-step is independently time-boxed and failure-tolerant.
 */
export async function gatherSemanticContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  surrounding: SurroundingContext,
  linePrefix: string,
  token?: vscode.CancellationToken,
  opts: SemanticOptions = {}
): Promise<SemanticContext> {
  const language = document.languageId;
  const maxSymbols = opts.maxSymbols ?? 30;
  const maxDeclarations = opts.maxDeclarations ?? 4;
  const result = emptySemanticContext();

  if (token?.isCancellationRequested) { return result; }

  // Adapt the timeout to this language server's measured latency, and skip
  // entirely while a language with no server installed is in cooldown.
  const budget = effectiveBudget(language, opts.budgetMs ?? 900);
  if (budget <= 0) { return result; }

  const names = selectNamesToResolve(surrounding, linePrefix);
  const startedAt = Date.now();

  // Fan out — these providers are independent, so run them concurrently.
  const [symbols, inScope, activeSignature, declarations, hoverTypes] = await Promise.all([
    getEnclosingSymbols(document.uri, position, Math.round(budget * 0.4)),
    getSymbolsInScope(document.uri, position, Math.round(budget * 0.7), maxSymbols),
    getActiveSignature(document.uri, position, Math.round(budget * 0.3)),
    resolveDeclarations(document, position, names, Math.round(budget * 0.9), maxDeclarations),
    getHoverTypes(document, position, names.slice(0, 4), Math.round(budget * 0.5)),
  ]);

  const answered =
    symbols.length > 0 || inScope.length > 0 || declarations.length > 0 || !!activeSignature;
  recordGather(language, Date.now() - startedAt, answered);

  if (token?.isCancellationRequested) { return result; }

  result.symbolPath = symbols.map(s => s.name).join('.');
  result.enclosingDetail = symbols.length
    ? `${symbols[symbols.length - 1].kind} ${symbols[symbols.length - 1].name}${symbols[symbols.length - 1].detail ? ' ' + symbols[symbols.length - 1].detail : ''}`
    : '';
  result.symbolsInScope = inScope;
  result.activeSignature = activeSignature;
  result.declarations = declarations;
  result.hoverTypes = hoverTypes;
  result.nearbyDiagnostics = getNearbyDiagnostics(document.uri, position);
  result.languageServerAvailable = answered;

  return result;
}

// ─── Prompt rendering ─────────────────────────────────────────────────────────

/** Render the semantic context as a compact prompt block. */
export function renderSemanticForPrompt(sem: SemanticContext): string {
  const parts: string[] = [];

  if (sem.symbolPath) { parts.push(`Cursor is inside: ${sem.symbolPath}`); }
  if (sem.enclosingDetail) { parts.push(`Resolved signature: ${sem.enclosingDetail}`); }
  if (sem.activeSignature) { parts.push(`Call being written: ${sem.activeSignature}`); }

  if (sem.hoverTypes.length) {
    parts.push('Resolved types:\n' + sem.hoverTypes.map(h => `  ${h.name} — ${h.type}`).join('\n'));
  }

  if (sem.symbolsInScope.length) {
    const listed = sem.symbolsInScope
      .map(s => s.detail ? `${s.name} (${s.kind}) ${s.detail}` : `${s.name} (${s.kind})`)
      .slice(0, 30);
    parts.push(
      'Identifiers the compiler says are valid at this position — ' +
      'use ONLY these names for anything you did not declare yourself:\n' +
      listed.map(l => `  ${l}`).join('\n')
    );
  }

  if (sem.declarations.length) {
    parts.push(
      'Actual declarations from the files this code depends on:\n' +
      sem.declarations
        .map(d => `  // ${d.file} — ${d.symbol}\n${indentBlock(d.code, '  ')}`)
        .join('\n\n')
    );
  }

  if (sem.nearbyDiagnostics.length) {
    parts.push(
      'Existing problems reported by the language server near the cursor ' +
      '(do not reproduce these mistakes):\n' +
      sem.nearbyDiagnostics.map(d => `  ${d}`).join('\n')
    );
  }

  return parts.join('\n\n');
}

function indentBlock(text: string, pad: string): string {
  return text.split('\n').map(l => pad + l).join('\n');
}
