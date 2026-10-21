import * as vscode from 'vscode';

/**
 * Repository instructions, read from the same places GitHub Copilot reads
 * them, so a project that already has them set up gets the same behaviour
 * here without writing anything twice:
 *
 *   .github/copilot-instructions.md          always applies
 *   .github/instructions/*.instructions.md   applies to files matching `applyTo`
 *   AGENTS.md                                always applies
 *
 * The text goes at the front of every chat request — the side panel, inline
 * chat and the selection actions alike.
 */

export interface InstructionFile {
  /** Workspace-relative path the text came from. */
  source: string;
  /** Globs from the `applyTo` header; empty means every file. */
  applyTo: string[];
  body: string;
}

export interface FrontMatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Splits a leading `---` block off a markdown file. Only flat `key: value`
 * pairs are read — that is all the instruction and prompt formats use.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const normalised = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalised);
  if (!match) { return { fields: {}, body: normalised.trim() }; }

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) { continue; }
    fields[kv[1]] = unquote(kv[2].trim());
  }
  return { fields, body: normalised.slice(match[0].length).trim() };
}

function unquote(value: string): string {
  if (value.length >= 2 && /^(['"]).*\1$/.test(value)) { return value.slice(1, -1); }
  return value;
}

/** `applyTo: "**\/*.ts, src/**"` → the individual globs. */
export function splitGlobs(value: string | undefined): string[] {
  if (!value) { return []; }
  return value.replace(/^\[|\]$/g, '').split(',').map(g => unquote(g.trim())).filter(Boolean);
}

/** A minimal glob: `**` crosses directories, `*` and `?` do not, `{a,b}` alternates. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { out += '\\{'; continue; }
      out += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRegExp).join('|') + ')';
      i = end;
    } else {
      out += escapeRegExp(c);
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

export function appliesTo(file: InstructionFile, relPath: string | undefined): boolean {
  if (file.applyTo.length === 0) { return true; }
  if (!relPath) { return false; }
  const target = relPath.replace(/\\/g, '/');
  return file.applyTo.some(glob => glob === '**' || globToRegExp(glob).test(target));
}

/**
 * The instructions that apply to one file, as a single block for the system
 * prompt. Unconditional files come first, scoped ones after, each headed by
 * where it came from so a model quoting a rule can say which file it is in.
 */
export function composeInstructions(files: InstructionFile[], relPath: string | undefined): string {
  const applicable = files
    .filter(f => f.body && appliesTo(f, relPath))
    .sort((a, b) => a.applyTo.length - b.applyTo.length);
  if (applicable.length === 0) { return ''; }
  return 'Follow these instructions from the repository:\n\n' +
    applicable.map(f => `<!-- ${f.source} -->\n${f.body}`).join('\n\n');
}

// ─── Workspace loading ────────────────────────────────────────────────────────

const ALWAYS = ['.github/copilot-instructions.md', 'AGENTS.md'];
const SCOPED_GLOB = '.github/instructions/**/*.instructions.md';

let cached: { at: number; files: InstructionFile[] } | null = null;
const CACHE_MS = 5000;

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}

export async function loadInstructionFiles(): Promise<InstructionFile[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) { return cached.files; }
  const files: InstructionFile[] = [];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const name of ALWAYS) {
      const text = await readText(vscode.Uri.joinPath(folder.uri, name));
      if (text) { files.push({ source: name, applyTo: [], body: parseFrontMatter(text).body }); }
    }
  }

  try {
    for (const uri of await vscode.workspace.findFiles(SCOPED_GLOB, undefined, 50)) {
      const text = await readText(uri);
      if (!text) { continue; }
      const { fields, body } = parseFrontMatter(text);
      files.push({
        source: vscode.workspace.asRelativePath(uri, false),
        applyTo: splitGlobs(fields['applyTo']),
        body,
      });
    }
  } catch { /* no workspace to search */ }

  cached = { at: Date.now(), files };
  return files;
}

/** Drops the cache after one of the files is saved, so an edit applies at once. */
export function invalidateInstructions(): void { cached = null; }

/** The repository instructions for the file in the active editor, or ''. */
export async function instructionsForActiveFile(): Promise<string> {
  if (!vscode.workspace.getConfiguration('llmCopilot').get('customInstructions.enabled', true)) { return ''; }
  const doc = vscode.window.activeTextEditor?.document;
  const relPath = doc && doc.uri.scheme === 'file' ? vscode.workspace.asRelativePath(doc.uri, false) : undefined;
  return composeInstructions(await loadInstructionFiles(), relPath);
}
