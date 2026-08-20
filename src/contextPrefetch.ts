import * as vscode from 'vscode';
import {
  extractSurroundingContext, SurroundingContext,
} from './signatureExtractor';
import {
  gatherSemanticContext, emptySemanticContext, hasLanguageServer, SemanticContext,
} from './semanticContext';
import { gatherWorkspaceSignatures } from './workspaceContext';

/**
 * contextPrefetch.ts
 *
 * Latency strategy for ghost text.
 *
 * The completion pipeline used to run strictly in series:
 *
 *     [ debounce 500ms ] → [ gather context ~700-900ms ] → [ LLM call ] → show
 *
 * The debounce window is dead time — we are deliberately waiting for the user
 * to stop typing. The context gather does not depend on anything that happens
 * during it, so it can run *inside* that window instead of after it:
 *
 *     [ debounce 500ms ]                                 → [ LLM call ] → show
 *     [ gather context ~700-900ms ]
 *
 * By the time the provider fires, the context is usually already resolved and
 * awaiting it costs nothing. Two further savings come from the cache key:
 *
 *   • It is keyed on things that are STABLE while you type — the enclosing
 *     signature text, the container, the line, and the member-access receiver —
 *     not on the document version. So the keystrokes within a line all share
 *     one gather rather than each starting their own.
 *
 *   • The workspace-wide regex scan is skipped once a language server has
 *     answered for the language, because it exists only as the fallback for
 *     when one has not.
 */

export interface PreparedContext {
  surrounding: SurroundingContext;
  semantic: SemanticContext;
  workspace: { context: string; sources: string[] };
}

export interface PrepareOptions {
  semanticEnabled: boolean;
  semanticBudgetMs: number;
  maxSymbols: number;
  maxDeclarations: number;
  workspaceBudgetMs: number;
}

interface CacheEntry {
  promise: Promise<PreparedContext>;
  createdAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5_000;
const CACHE_MAX = 24;

/** Stats, for the latency reporting in the status bar / logs. */
let hits = 0;
let misses = 0;

// ─── Key construction ─────────────────────────────────────────────────────────

/**
 * The member-access receiver being typed (`foo.`, `foo::`, `foo->`), which is
 * the one part of the line prefix that genuinely changes what is in scope.
 * Everything else the user types on the line leaves the answer unchanged.
 */
function receiverOf(linePrefix: string): string {
  return linePrefix.match(/([A-Za-z_$][\w$]*)\s*(?:\.|->|::)\s*\w*$/)?.[1] ?? '';
}

function keyFor(
  document: vscode.TextDocument,
  position: vscode.Position,
  surrounding: SurroundingContext,
  linePrefix: string
): string {
  return [
    document.uri.toString(),
    document.languageId,
    surrounding.enclosing?.header ?? '',
    surrounding.container?.header ?? '',
    position.line,
    receiverOf(linePrefix),
  ].join('|');
}

// ─── Gathering ────────────────────────────────────────────────────────────────

async function gather(
  document: vscode.TextDocument,
  position: vscode.Position,
  surrounding: SurroundingContext,
  linePrefix: string,
  opts: PrepareOptions
): Promise<PreparedContext> {
  const language = document.languageId;

  // Once real symbol resolution is available, the regex sweep over the
  // workspace is redundant work on the critical path — skip it.
  const needWorkspaceScan = !(opts.semanticEnabled && hasLanguageServer(language));

  const [semantic, workspace] = await Promise.all([
    opts.semanticEnabled
      ? gatherSemanticContext(document, position, surrounding, linePrefix, undefined, {
          budgetMs: opts.semanticBudgetMs,
          maxSymbols: opts.maxSymbols,
          maxDeclarations: opts.maxDeclarations,
        }).catch(() => emptySemanticContext())
      : Promise.resolve(emptySemanticContext()),
    needWorkspaceScan
      ? gatherWorkspaceSignatures(
          document.fileName, language, referenceWindow(document, position), opts.workspaceBudgetMs)
          .catch(() => ({ context: '', sources: [] as string[] }))
      : Promise.resolve({ context: '', sources: [] as string[] }),
  ]);

  return { surrounding, semantic, workspace };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the prepared context for this cursor, reusing an in-flight or recent
 * gather when one matches. Always resolves — never rejects.
 */
export function prepareContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  linePrefix: string,
  opts: PrepareOptions
): { promise: Promise<PreparedContext>; cached: boolean; surrounding: SurroundingContext } {
  // Cheap enough (<1ms even on a 10k-line file) to always recompute, and it is
  // what the cache key is derived from.
  let surrounding: SurroundingContext;
  try {
    surrounding = extractSurroundingContext(document, position);
  } catch {
    surrounding = emptySurrounding(document.languageId);
  }

  const key = keyFor(document, position, surrounding, linePrefix);
  const now = Date.now();
  const existing = cache.get(key);

  if (existing && now - existing.createdAt < CACHE_TTL_MS) {
    hits++;
    // Reuse the resolved symbols, but pair them with the CURRENT surrounding
    // context so nothing downstream sees a stale signature.
    return {
      promise: existing.promise.then(p => ({ ...p, surrounding })),
      cached: true,
      surrounding,
    };
  }

  misses++;
  const promise = gather(document, position, surrounding, linePrefix, opts)
    .catch(() => ({
      surrounding,
      semantic: emptySemanticContext(),
      workspace: { context: '', sources: [] as string[] },
    }));

  evictStale(now);
  cache.set(key, { promise, createdAt: now });
  return { promise, cached: false, surrounding };
}

/**
 * Start gathering now and discard the result — called from the debouncer the
 * moment the timer is set, so the work overlaps the wait instead of following
 * it. Cheap to call on every keystroke: the key is stable while you type, so
 * repeated calls join the same in-flight gather.
 */
export function prefetchContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  linePrefix: string,
  opts: PrepareOptions
): void {
  try {
    prepareContext(document, position, linePrefix, opts).promise.catch(() => undefined);
  } catch {
    // Prefetching is pure optimisation — never let it surface an error.
  }
}

/** Drop everything cached for a document (called when it changes structurally). */
export function invalidateDocument(uri: vscode.Uri): void {
  const prefix = uri.toString() + '|';
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) { cache.delete(key); }
  }
}

export function clearPrefetchCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/** Hit-rate stats, for diagnostics. */
export function prefetchStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: cache.size };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function evictStale(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.createdAt >= CACHE_TTL_MS) { cache.delete(key); }
  }
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (!oldest) { break; }
    cache.delete(oldest);
  }
}

/**
 * The text the workspace scan mines for referenced identifiers: the head of the
 * file (where the imports live) plus the lines just above the cursor (where the
 * types actually in play are named). Sending the whole file would work but
 * costs more to scan for no extra signal.
 */
function referenceWindow(document: vscode.TextDocument, position: vscode.Position): string {
  const lastLine = Math.max(0, document.lineCount - 1);
  const headEnd = Math.min(60, lastLine);
  const head = document.getText(
    new vscode.Range(0, 0, headEnd, document.lineAt(headEnd).text.length));

  const nearStart = Math.max(headEnd + 1, position.line - 40);
  if (nearStart >= position.line) { return head; }
  const near = document.getText(new vscode.Range(nearStart, 0, position.line, 0));
  return `${head}\n${near}`;
}

function emptySurrounding(language: string): SurroundingContext {
  return {
    language, enclosing: null, container: null, scopeChain: [],
    bindings: [], returnExpressions: [], memberAccesses: [], freeIdentifiers: [],
  };
}
