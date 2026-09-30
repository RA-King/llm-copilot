import * as path from 'path';
import * as vscode from 'vscode';
import { ParsedError } from './errorParser';
import { ProjectIndex, getProjectIndex } from './projectIndex';

/**
 * deepContext.ts
 *
 * What an error needs around it before an answer is worth reading.
 *
 * The source at the failing line is the obvious context, and on its own it is
 * rarely enough. `undefined is not a function` at `repo.findByCustomer(id)`
 * cannot be answered from that line: the answer is in whatever `repo` is, what
 * that type declares, and who constructed it. A model given only the failing
 * line has to invent those, and it does — confidently, and wrongly.
 *
 * The project index knows all three, so the error pane asks it:
 *
 *   • Every identifier named in the message or on the failing lines is looked
 *     up, and its declaration — the real one, from wherever in the project it
 *     lives — goes into the prompt.
 *   • The files that import the failing one are listed, because a fix that
 *     changes a signature has to be a fix for them too.
 *   • The project's manifest goes in, trimmed, because half of all runtime
 *     failures are a dependency, a version or a script.
 *   • A one-paragraph digest of the project's shape goes in first, so the
 *     answer is written for this codebase rather than for the language.
 */

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** What the caller already resolved: the source around each failing frame. */
export interface ResolvedFrame {
  uri: vscode.Uri;
  languageId: string;
  /** Zero-based line the snippet starts at. */
  startLine: number;
  snippet: string;
  /** The line the trace named, one-based; 0 when it named none. */
  tracedLine: number;
}

export interface DeepContextOptions {
  /** Ceiling on the whole rendered block. */
  budgetChars: number;
  /** Include the project manifest. */
  includeManifest: boolean;
  /** Include the list of files importing the failing one. */
  includeDependents: boolean;
}

export const DEFAULT_DEEP_OPTIONS: DeepContextOptions = {
  budgetChars: 4000,
  includeManifest: true,
  includeDependents: true,
};

export interface DeepContext {
  /** The rendered block, ready to append to an error prompt; '' when empty. */
  text: string;
  /** Identifiers that were looked up and found, for the pane's own labelling. */
  resolvedNames: string[];
  /** Workspace-relative paths that import the failing file. */
  dependents: string[];
}

export const EMPTY_DEEP_CONTEXT: DeepContext = { text: '', resolvedNames: [], dependents: [] };

// ─── Gathering ────────────────────────────────────────────────────────────────

export async function gatherDeepContext(
  parsed: ParsedError,
  frames: ResolvedFrame[],
  options: DeepContextOptions = DEFAULT_DEEP_OPTIONS,
  index: ProjectIndex | null = getProjectIndex()
): Promise<DeepContext> {
  if (!index || !index.isReady()) { return EMPTY_DEEP_CONTEXT; }

  const sections: string[] = [];
  let spent = 0;
  const take = (block: string): boolean => {
    if (!block) { return true; }
    if (spent + block.length > options.budgetChars) { return false; }
    sections.push(block);
    spent += block.length;
    return true;
  };

  const digest = index.renderDigest();
  if (digest) { take(`── This project ──\n${digest}`); }

  // ── Identifiers worth resolving ───────────────────────────────────────────
  const names = identifiersToResolve(parsed, frames);
  const declarations = index.declarationsFor(names, Math.floor(options.budgetChars * 0.4));
  const resolvedNames = names.filter(n => index.lookup(n, 1).length > 0);

  if (declarations) {
    take(
      '── Where the names in this failure are declared ──\n' +
      'These are read from the project, not inferred. Use the real signatures.\n' +
      declarations
    );
  }

  // ── Who depends on the failing file ───────────────────────────────────────
  let dependents: string[] = [];
  const failing = frames[0];
  if (options.includeDependents && failing) {
    const rel = vscode.workspace.asRelativePath(failing.uri, false).replace(/\\/g, '/');
    dependents = index.dependents(rel, 10);
    if (dependents.length) {
      take(
        `── Callers of ${rel} ──\n` +
        'A change to what this file exports has to hold for these too:\n' +
        dependents.map(d => `  ${d}`).join('\n')
      );
    }

    const imported = index.dependencies(rel);
    if (imported.length) {
      take(`── ${rel} depends on ──\n${imported.slice(0, 10).map(d => `  ${d}`).join('\n')}`);
    }
  }

  // ── The project manifest ──────────────────────────────────────────────────
  if (options.includeManifest) {
    const manifest = await readManifest(index, Math.max(0, options.budgetChars - spent));
    if (manifest) { take(manifest); }
  }

  return { text: sections.join('\n\n'), resolvedNames, dependents };
}

// ─── Identifier extraction ────────────────────────────────────────────────────

/**
 * The names worth looking up: the ones the error itself printed, then the ones
 * on the lines the trace pointed at. Ordered, because the budget runs out and
 * the message's own nouns are the ones the answer turns on.
 */
export function identifiersToResolve(parsed: ParsedError, frames: ResolvedFrame[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const add = (name: string) => {
    if (!name || seen.has(name) || NOISE.has(name) || name.length < 3) { return; }
    seen.add(name);
    ordered.push(name);
  };

  // The headline and the message name the thing that failed, usually verbatim.
  for (const name of extractIdentifiers(parsed.headline)) { add(name); }
  for (const name of extractIdentifiers(parsed.text.split('\n').slice(0, 4).join(' '))) { add(name); }

  // Then the symbols the trace's own frames named.
  for (const frame of parsed.frames.slice(0, 6)) {
    if (frame.symbol) { for (const name of extractIdentifiers(frame.symbol)) { add(name); } }
  }

  // Then the code itself, restricted to the line the trace pointed at and its
  // immediate neighbours — the rest of the snippet is context, not cause.
  for (const frame of frames.slice(0, 2)) {
    const lines = frame.snippet.split('\n');
    const centre = frame.tracedLine > 0 ? frame.tracedLine - 1 - frame.startLine : Math.floor(lines.length / 2);
    for (let i = Math.max(0, centre - 1); i <= Math.min(lines.length - 1, centre + 1); i++) {
      for (const name of extractIdentifiers(lines[i] ?? '')) { add(name); }
    }
  }

  return ordered.slice(0, 24);
}

/** Identifiers and dotted receivers, split into their parts. */
function extractIdentifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) { out.push(m[0]); }
  return out;
}

/** Words that appear in every trace and resolve to nothing useful. */
const NOISE = new Set([
  'error', 'Error', 'TypeError', 'ValueError', 'Exception', 'RuntimeError',
  'null', 'undefined', 'None', 'true', 'false', 'this', 'self', 'super',
  'function', 'object', 'Object', 'string', 'String', 'number', 'Number',
  'boolean', 'Boolean', 'Array', 'return', 'const', 'let', 'var', 'await',
  'async', 'import', 'from', 'class', 'interface', 'public', 'private',
  'static', 'void', 'int', 'new', 'throw', 'catch', 'try', 'not', 'the',
  'and', 'for', 'with', 'has', 'was', 'main', 'module', 'line', 'file',
  'at', 'in', 'is', 'of', 'to', 'call', 'stack', 'trace', 'Traceback',
]);

// ─── The manifest ─────────────────────────────────────────────────────────────

/**
 * The project's own declaration of itself: dependencies, scripts, versions.
 * Read in full for the small formats and trimmed to the parts that matter for
 * package.json, which is routinely long and mostly irrelevant.
 */
async function readManifest(index: ProjectIndex, budget: number): Promise<string> {
  if (budget < 200) { return ''; }
  const manifests = index.digest().manifests;
  if (manifests.length === 0) { return ''; }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return ''; }

  // The shallowest manifest is the project's own; deeper ones belong to
  // packages inside it and say less about the failure.
  const chosen = [...manifests].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];

  try {
    const uri = vscode.Uri.joinPath(folder.uri, chosen);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    const trimmed = path.basename(chosen) === 'package.json'
      ? trimPackageJson(text)
      : text.slice(0, budget - 100);
    if (!trimmed.trim()) { return ''; }
    return `── ${chosen} ──\n\`\`\`\n${trimmed.slice(0, budget - 100)}\n\`\`\``;
  } catch {
    return '';
  }
}

/** package.json without the fields that never explain a stack trace. */
function trimPackageJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const kept: Record<string, unknown> = {};
    for (const field of ['name', 'version', 'type', 'main', 'engines', 'scripts',
                         'dependencies', 'devDependencies', 'peerDependencies']) {
      if (parsed[field] !== undefined) { kept[field] = parsed[field]; }
    }
    return JSON.stringify(kept, null, 2);
  } catch {
    return text.slice(0, 1200);
  }
}
