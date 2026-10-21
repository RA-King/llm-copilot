import * as vscode from 'vscode';
import { chat, ChatMessage } from './llmProvider';
import { buildDiagnosticFixPrompt, extractCodeBlock } from './assistPrompts';
import { getProjectIndex } from './projectIndex';

/**
 * "Fix with LLM Copilot" and "Explain with LLM Copilot" in the lightbulb of
 * any diagnostic, from any language server or linter.
 */

/** Lines either side of the problem sent with it, and replaced by the answer. */
const WINDOW = 6;

export class DiagnosticCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    if (!vscode.workspace.getConfiguration('llmCopilot').get('enabled', true)) { return []; }
    const diagnostics = context.diagnostics.filter(d => d.severity !== vscode.DiagnosticSeverity.Hint);
    if (diagnostics.length === 0) { return []; }

    const fix = new vscode.CodeAction('Fix with LLM Copilot', vscode.CodeActionKind.QuickFix);
    fix.diagnostics = diagnostics;
    fix.command = { command: 'llmCopilot.fixDiagnostics', title: fix.title, arguments: [document.uri, diagnostics] };

    const explain = new vscode.CodeAction('Explain with LLM Copilot', vscode.CodeActionKind.QuickFix);
    explain.diagnostics = diagnostics;
    explain.command = { command: 'llmCopilot.explainDiagnostics', title: explain.title, arguments: [document.uri, diagnostics] };

    return [fix, explain];
  }
}

/** The run of lines a fix is allowed to rewrite. */
function windowFor(document: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]): vscode.Range {
  const first = Math.min(...diagnostics.map(d => d.range.start.line));
  const last = Math.max(...diagnostics.map(d => d.range.end.line));
  const start = Math.max(0, first - WINDOW);
  const end = Math.min(document.lineCount - 1, last + WINDOW);
  return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
}

function describe(d: vscode.Diagnostic): string {
  const source = d.source ? `${d.source}: ` : '';
  const code = typeof d.code === 'object' ? d.code.value : d.code;
  return `line ${d.range.start.line + 1}: ${source}${d.message}${code !== undefined ? ` (${code})` : ''}`;
}

function declarationsNear(text: string): string {
  const index = getProjectIndex();
  if (!index) { return ''; }
  const names = new Set(text.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []);
  return index.declarationsFor(names, 1500);
}

export async function fixDiagnostics(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const range = windowFor(document, diagnostics);
  const original = document.getText(range);
  const version = document.version;

  const reply = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'LLM Copilot: fixing…', cancellable: false },
    () => chat(buildDiagnosticFixPrompt({
      language: document.languageId,
      file: vscode.workspace.asRelativePath(uri, false),
      problems: diagnostics.map(describe),
      firstLine: range.start.line + 1,
      code: original,
      declarations: declarationsNear(original),
    }))
  );

  const fixed = extractCodeBlock(reply);
  if (!fixed.trim() || fixed === original) {
    vscode.window.showInformationMessage('LLM Copilot: no change was proposed for this problem.');
    return;
  }
  if (document.version !== version) {
    vscode.window.showWarningMessage('LLM Copilot: the file changed while the fix was being written; try again.');
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, fixed);
  if (!await vscode.workspace.applyEdit(edit)) { return; }

  const choice = await vscode.window.showInformationMessage(
    `LLM Copilot fixed: ${diagnostics[0].message.split('\n')[0].slice(0, 80)}`, 'Undo'
  );
  if (choice === 'Undo') {
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('undo');
  }
}

export function buildDiagnosticExplainPrompt(
  document: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]
): { display: string; messages: ChatMessage[] } {
  const range = windowFor(document, diagnostics);
  const file = vscode.workspace.asRelativePath(document.uri, false);
  const problems = diagnostics.map(describe).join('\n');
  return {
    display: `Explain: ${diagnostics[0].message.split('\n')[0]}`,
    messages: [
      {
        role: 'system',
        content: 'You are an expert programmer. Explain what the reported problem means, why this code ' +
          'triggers it, and how to fix it, with the corrected code in a fenced block. Be concise.',
      },
      {
        role: 'user',
        content: `${file}\n\n${problems}\n\n\`\`\`${document.languageId}\n${document.getText(range)}\n\`\`\``,
      },
    ],
  };
}
