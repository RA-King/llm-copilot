import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { chat } from './llmProvider';
import {
  annotateDiff, buildReviewChangesPrompt, buildReviewSelectionPrompt, parseReviewFindings, ReviewFinding,
} from './codeReview';
import { buildPullRequestPrompt, buildTerminalCommandPrompt, parseTerminalSuggestion } from './assistPrompts';

/**
 * The commands that work over the repository rather than the cursor: code
 * review, pull request descriptions, and turning a request into a shell
 * command.
 */

type Status = { setLoading(m: string): void; setIdle(): void; setError(m: string): void };

export function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); } else { resolve(stdout); }
    });
  });
}

/** The repository the active file is in, else the first workspace folder. */
export async function repositoryRoot(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && active.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active))
    || vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return undefined; }
  try {
    return (await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return undefined;
  }
}

// ─── Code review ──────────────────────────────────────────────────────────────

export class ReviewCommands implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('llm-copilot-review');

  constructor(private readonly status: Status) {}

  async reviewSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    const doc = editor.document;
    const range = editor.selection.isEmpty
      ? new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      : new vscode.Range(editor.selection.start.line, 0, editor.selection.end.line,
          doc.lineAt(editor.selection.end.line).text.length);

    const file = vscode.workspace.asRelativePath(doc.uri, false);
    const findings = await this.ask('Reviewing…', buildReviewSelectionPrompt(
      doc.getText(range), doc.languageId, file, range.start.line + 1));
    if (!findings) { return; }

    this.diagnostics.delete(doc.uri);
    const inRange = findings.filter(f => f.line >= range.start.line + 1 && f.line <= range.end.line + 1);
    this.diagnostics.set(doc.uri, inRange.map(f => this.toDiagnostic(doc, f)));
    this.report(inRange.length);
  }

  async reviewChanges(): Promise<void> {
    const root = await repositoryRoot();
    if (!root) {
      vscode.window.showWarningMessage('LLM Copilot: open a folder inside a git repository to review its changes.');
      return;
    }
    let diff = '';
    try { diff = await git(root, ['diff', 'HEAD', '--no-color', '-U3']); }
    catch { diff = await git(root, ['diff', '--no-color', '-U3']).catch(() => ''); }
    if (!diff.trim()) {
      vscode.window.showInformationMessage('LLM Copilot: there are no uncommitted changes to review.');
      return;
    }

    const findings = await this.ask('Reviewing changes…', buildReviewChangesPrompt(annotateDiff(diff).slice(0, 30000)));
    if (!findings) { return; }

    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    let shown = 0;
    for (const finding of findings) {
      if (!finding.file) { continue; }
      const uri = vscode.Uri.file(path.join(root, finding.file));
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const list = byFile.get(uri.toString()) ?? [];
        list.push(this.toDiagnostic(doc, finding));
        byFile.set(uri.toString(), list);
        shown++;
      } catch { /* a file the model misnamed */ }
    }
    for (const [key, list] of byFile) { this.diagnostics.set(vscode.Uri.parse(key), list); }
    this.report(shown);
  }

  clear(): void { this.diagnostics.clear(); }

  private async ask(label: string, messages: Parameters<typeof chat>[0]): Promise<ReviewFinding[] | undefined> {
    this.status.setLoading(label);
    try {
      const reply = await chat(messages);
      this.status.setIdle();
      return parseReviewFindings(reply);
    } catch (err: any) {
      this.status.setError('Review failed');
      vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`);
      return undefined;
    }
  }

  private toDiagnostic(doc: vscode.TextDocument, f: ReviewFinding): vscode.Diagnostic {
    const line = Math.min(Math.max(f.line - 1, 0), doc.lineCount - 1);
    const text = doc.lineAt(line);
    const range = new vscode.Range(line, text.firstNonWhitespaceCharacterIndex, line, text.text.length);
    const severity = f.severity === 'error' ? vscode.DiagnosticSeverity.Error
      : f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;
    const diagnostic = new vscode.Diagnostic(range, f.message, severity);
    diagnostic.source = 'LLM Copilot review';
    return diagnostic;
  }

  private report(count: number): void {
    if (count === 0) {
      vscode.window.showInformationMessage('LLM Copilot review: nothing worth raising.');
      return;
    }
    vscode.window.showInformationMessage(
      `LLM Copilot review: ${count} comment${count === 1 ? '' : 's'} added to the Problems panel.`, 'Show'
    ).then(choice => {
      if (choice === 'Show') { void vscode.commands.executeCommand('workbench.actions.view.problems'); }
    });
  }

  dispose(): void { this.diagnostics.dispose(); }
}

// ─── Pull request description ─────────────────────────────────────────────────

async function baseBranch(root: string): Promise<string> {
  try {
    const head = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (head) { return head; }
  } catch { /* no remote HEAD recorded */ }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    try { await git(root, ['rev-parse', '--verify', '--quiet', candidate]); return candidate; }
    catch { /* try the next */ }
  }
  return 'HEAD~1';
}

export async function generatePullRequestDescription(status: Status): Promise<void> {
  const root = await repositoryRoot();
  if (!root) {
    vscode.window.showWarningMessage('LLM Copilot: open a folder inside a git repository first.');
    return;
  }

  status.setLoading('Writing pull request description…');
  try {
    const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const base = await baseBranch(root);
    const range = `${base}...HEAD`;
    const [log, stat, diff] = await Promise.all([
      git(root, ['log', '--no-color', '--format=%s%n%b', `${base}..HEAD`]),
      git(root, ['diff', '--no-color', '--stat', range]),
      git(root, ['diff', '--no-color', range]),
    ]);
    if (!log.trim() && !diff.trim()) {
      status.setIdle();
      vscode.window.showInformationMessage(`LLM Copilot: ${branch} has no changes against ${base}.`);
      return;
    }

    const reply = await chat(buildPullRequestPrompt({ branch, base, log, stat, diff }));
    status.setIdle();
    const text = reply.trim();
    await vscode.env.clipboard.writeText(text);
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage('LLM Copilot: pull request description copied to the clipboard.');
  } catch (err: any) {
    status.setError('Error');
    vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`);
  }
}

// ─── Terminal commands ────────────────────────────────────────────────────────

function shellName(): string {
  const configured = vscode.env.shell || process.env.SHELL || process.env.ComSpec || '';
  const base = path.basename(configured).replace(/\.exe$/i, '').toLowerCase();
  return base || (process.platform === 'win32' ? 'powershell' : 'bash');
}

function platformName(): string {
  return process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : `Linux (${os.release()})`;
}

export async function suggestTerminalCommand(status: Status, prefill?: string): Promise<void> {
  const request = await vscode.window.showInputBox({
    prompt: 'Describe the command you need',
    placeHolder: 'e.g. find the ten largest files under src, kill whatever is listening on port 3000…',
    value: prefill,
    ignoreFocusOut: true,
  });
  if (!request?.trim()) { return; }

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  status.setLoading('Writing command…');
  let suggestion;
  try {
    suggestion = parseTerminalSuggestion(await chat(buildTerminalCommandPrompt(request, shellName(), platformName(), folder)));
    status.setIdle();
  } catch (err: any) {
    status.setError('Error');
    vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`);
    return;
  }
  if (!suggestion.command) {
    vscode.window.showWarningMessage('LLM Copilot: no command came back for that request.');
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(terminal) Insert into terminal', id: 'insert', description: 'to read before pressing Enter' },
      { label: '$(play) Run in terminal', id: 'run' },
      { label: '$(copy) Copy', id: 'copy' },
    ],
    { title: suggestion.command, placeHolder: suggestion.explanation || suggestion.command, ignoreFocusOut: true }
  );
  if (!choice) { return; }

  if (choice.id === 'copy') {
    await vscode.env.clipboard.writeText(suggestion.command);
    return;
  }
  const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('LLM Copilot');
  terminal.show();
  terminal.sendText(suggestion.command, choice.id === 'run');
}
