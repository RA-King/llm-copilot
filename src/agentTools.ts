import * as vscode from 'vscode';
import { exec } from 'child_process';
import { findUnique, numberArg, safeRelativePath, stringArg, ToolCall } from './agentProtocol';
import { AgentTools, ToolOutcome } from './agentSession';
import { numberLines } from './codeReview';
import { getProjectIndex } from './projectIndex';

/**
 * The agent's hands in a VS Code workspace. Edits are applied straight away
 * and saved, so a command run afterwards sees them; every file touched is
 * remembered as it was first found, which is what the change list's diffs and
 * "Undo all" work from. Commands never run without the user's say-so.
 */

const EXCLUDE = '**/{node_modules,.git,out,dist,build,target,.venv,venv,__pycache__,.next,coverage}/**';
const READ_CHUNK = 400;

export type CommandDecision = 'run' | 'skip';

export interface ChangedFile {
  path: string;
  /** null when the agent created the file. */
  original: string | null;
}

export const ORIGINAL_SCHEME = 'llm-copilot-original';

/** Serves the contents files had before an agent run, for the diff view. */
export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  private readonly runs = new Map<string, Map<string, string | null>>();

  remember(runId: string, files: Map<string, string | null>): void { this.runs.set(runId, files); }

  uriFor(runId: string, path: string): vscode.Uri {
    return vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${path}`, query: runId });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.runs.get(uri.query)?.get(uri.path.slice(1)) ?? '';
  }
}

export class WorkspaceAgentTools implements AgentTools {
  /** Relative path → contents before the first change, or null for a new file. */
  readonly originals = new Map<string, string | null>();
  private readonly edited = new Set<string>();

  constructor(
    private readonly root: vscode.Uri,
    private readonly confirmCommand: (command: string) => Promise<CommandDecision>,
    private readonly commandTimeoutMs: number,
  ) {}

  changes(): ChangedFile[] {
    return [...this.originals].map(([path, original]) => ({ path, original }));
  }

  async run(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    switch (call.name) {
      case 'list_files': return this.listFiles(call);
      case 'read_file': return this.readFile(call);
      case 'search_text': return this.searchText(call);
      case 'find_symbol': return this.findSymbol(call);
      case 'edit_file': return this.editFile(call);
      case 'create_file': return this.createFile(call);
      case 'get_problems': return this.getProblems(call);
      case 'run_command': return this.runCommand(call, signal);
      default:
        return { ok: false, output: `There is no tool called ${call.name}.`, summary: `Unknown tool ${call.name}` };
    }
  }

  // ── Paths ──────────────────────────────────────────────────────────────────

  private resolve(raw: string): { rel: string; uri: vscode.Uri } {
    const safe = safeRelativePath(raw, this.root.fsPath);
    if ('error' in safe) { throw new Error(safe.error); }
    return { rel: safe.path, uri: vscode.Uri.joinPath(this.root, safe.path) };
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  private async listFiles(call: ToolCall): Promise<ToolOutcome> {
    const pattern = stringArg(call, 'pattern', false) || '**/*';
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, pattern), EXCLUDE, 300);
    const paths = uris.map(u => vscode.workspace.asRelativePath(u, false)).sort();
    const more = uris.length >= 300 ? '\n… (more files; narrow the pattern)' : '';
    return { ok: true, output: (paths.join('\n') || 'No files match.') + more, summary: `Listed ${paths.length} files matching ${pattern}` };
  }

  private async readFile(call: ToolCall): Promise<ToolOutcome> {
    const { rel, uri } = this.resolve(stringArg(call, 'path')!);
    const doc = await vscode.workspace.openTextDocument(uri);
    const total = doc.lineCount;
    const start = Math.max(1, numberArg(call, 'start_line') ?? 1);
    const end = Math.min(total, numberArg(call, 'end_line') ?? Math.min(total, start + READ_CHUNK - 1), start + READ_CHUNK - 1);
    if (start > total) {
      return { ok: false, output: `${rel} has only ${total} lines.`, summary: `Read ${rel}: past the end` };
    }
    const text = doc.getText(new vscode.Range(start - 1, 0, end - 1, doc.lineAt(end - 1).text.length));
    const rest = end < total ? `\n… (${total - end} more lines; read with start_line ${end + 1})` : '';
    return {
      ok: true,
      output: `${rel} (lines ${start}-${end} of ${total})\n${numberLines(text, start)}${rest}`,
      summary: `Read ${rel}${start > 1 || end < total ? ` lines ${start}–${end}` : ''}`,
    };
  }

  private async searchText(call: ToolCall): Promise<ToolOutcome> {
    const query = stringArg(call, 'query')!;
    const isRegex = call.args['regex'] === true || call.args['regex'] === 'true';
    const include = stringArg(call, 'include', false) || '**/*';
    let pattern: RegExp;
    try { pattern = new RegExp(isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    catch (err: any) { return { ok: false, output: `Bad regular expression: ${err.message}`, summary: 'Search failed' }; }

    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, include), EXCLUDE, 3000);
    const hits: string[] = [];
    for (const uri of uris) {
      if (hits.length >= 60) { break; }
      let bytes: Uint8Array;
      try { bytes = await vscode.workspace.fs.readFile(uri); } catch { continue; }
      if (bytes.length > 512 * 1024 || bytes.includes(0)) { continue; }
      const lines = Buffer.from(bytes).toString('utf8').split('\n');
      const rel = vscode.workspace.asRelativePath(uri, false);
      for (let i = 0; i < lines.length && hits.length < 60; i++) {
        if (pattern.test(lines[i])) { hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`); }
      }
    }
    const more = hits.length >= 60 ? '\n… (more matches; narrow the query or the include glob)' : '';
    return { ok: true, output: (hits.join('\n') || 'No matches.') + more, summary: `Searched for "${query}": ${hits.length} match${hits.length === 1 ? '' : 'es'}` };
  }

  private async findSymbol(call: ToolCall): Promise<ToolOutcome> {
    const name = stringArg(call, 'name')!;
    const index = getProjectIndex();
    let lines: string[] = [];
    if (index?.isReady()) {
      lines = index.lookup(name, 10).map(h => `${h.path}:${h.symbol.line + 1}: ${h.symbol.signature}`);
    }
    if (lines.length === 0) {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name) ?? [];
      lines = symbols.slice(0, 10).map(s =>
        `${vscode.workspace.asRelativePath(s.location.uri, false)}:${s.location.range.start.line + 1}: ${vscode.SymbolKind[s.kind]} ${s.name}`);
    }
    return { ok: true, output: lines.join('\n') || `No declaration of ${name} found.`, summary: `Looked up ${name}: ${lines.length} found` };
  }

  private async getProblems(call: ToolCall): Promise<ToolOutcome> {
    const raw = stringArg(call, 'path', false);
    const target = raw ? this.resolve(raw) : undefined;
    // Language servers re-check an edited file asynchronously; give them a moment.
    if (target ? this.edited.has(target.rel) : this.edited.size > 0) {
      if (target) { await vscode.workspace.openTextDocument(target.uri); }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const entries = target
      ? [[target.uri, vscode.languages.getDiagnostics(target.uri)] as [vscode.Uri, vscode.Diagnostic[]]]
      : vscode.languages.getDiagnostics();
    const lines: string[] = [];
    for (const [uri, diagnostics] of entries) {
      for (const d of diagnostics) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
        const level = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
        lines.push(`${vscode.workspace.asRelativePath(uri, false)}:${d.range.start.line + 1}: ${level}: ${d.message}${d.source ? ` (${d.source})` : ''}`);
        if (lines.length >= 80) { break; }
      }
    }
    const errors = lines.filter(l => l.includes(': error: ')).length;
    return {
      ok: true,
      output: lines.join('\n') || 'No errors or warnings reported.',
      summary: `Checked problems${target ? ` in ${target.rel}` : ''}: ${errors} error${errors === 1 ? '' : 's'}, ${lines.length - errors} warning${lines.length - errors === 1 ? '' : 's'}`,
    };
  }

  // ── Changing ───────────────────────────────────────────────────────────────

  private async editFile(call: ToolCall): Promise<ToolOutcome> {
    const { rel, uri } = this.resolve(stringArg(call, 'path')!);
    const search = stringArg(call, 'search')!;
    const replace = stringArg(call, 'replace')!;
    if (!await this.exists(uri)) {
      return { ok: false, output: `${rel} does not exist; use create_file for a new file.`, summary: `Edit ${rel}: no such file` };
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const found = findUnique(text, search);
    if (typeof found === 'string') {
      return { ok: false, output: `Could not edit ${rel}: ${found}.`, summary: `Edit ${rel} failed: ${found}` };
    }

    if (!this.originals.has(rel)) { this.originals.set(rel, text); }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(found.start), doc.positionAt(found.end)), replace);
    if (!await vscode.workspace.applyEdit(edit)) {
      return { ok: false, output: `The editor refused the edit to ${rel}.`, summary: `Edit ${rel} failed` };
    }
    await doc.save();
    this.edited.add(rel);

    const removed = text.slice(found.start, found.end).split('\n').length;
    const added = replace.split('\n').length;
    return { ok: true, output: `Edited ${rel}.`, summary: `Edited ${rel} (+${added} −${removed})` };
  }

  private async createFile(call: ToolCall): Promise<ToolOutcome> {
    const { rel, uri } = this.resolve(stringArg(call, 'path')!);
    const content = stringArg(call, 'content')!;
    const existed = await this.exists(uri);
    if (!this.originals.has(rel)) {
      this.originals.set(rel, existed ? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') : null);
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    this.edited.add(rel);
    const lines = content.split('\n').length;
    return { ok: true, output: `${existed ? 'Overwrote' : 'Created'} ${rel}.`, summary: `${existed ? 'Rewrote' : 'Created'} ${rel} (${lines} lines)` };
  }

  private async runCommand(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    const command = stringArg(call, 'command')!;
    if (await this.confirmCommand(command) !== 'run') {
      return { ok: false, output: 'The user chose not to run this command. Carry on without it, or finish and explain what is left.', summary: `Skipped: ${command}` };
    }

    return new Promise(resolve => {
      const child = exec(command, {
        cwd: this.root.fsPath, timeout: this.commandTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1' },
      }, (err, stdout, stderr) => {
        signal.removeEventListener('abort', kill);
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        const killed = err && (err as any).killed;
        const output = [stdout, stderr].filter(s => s.trim()).join('\n') || '(no output)';
        resolve({
          ok: code === 0,
          output: `${killed ? `Stopped after ${this.commandTimeoutMs / 1000}s.\n` : ''}Exit code ${code}\n${output}`,
          summary: `Ran ${command} — ${killed ? 'timed out' : `exit ${code}`}`,
        });
      });
      const kill = () => child.kill();
      signal.addEventListener('abort', kill);
    });
  }

  /** Put every touched file back the way the agent found it. */
  async undoAll(): Promise<number> {
    let restored = 0;
    for (const [rel, original] of this.originals) {
      const uri = vscode.Uri.joinPath(this.root, rel);
      try {
        if (original === null) { await vscode.workspace.fs.delete(uri); }
        else { await vscode.workspace.fs.writeFile(uri, Buffer.from(original, 'utf8')); }
        restored++;
      } catch { /* already gone or unwritable; leave it */ }
    }
    this.originals.clear();
    this.edited.clear();
    return restored;
  }
}
