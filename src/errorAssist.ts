/**
 * errorAssist.ts
 *
 * The pane the user actually sees. An error in the terminal or the debug
 * console goes in; a short list of candidate fixes comes back, each one a line
 * long. Picking one carries the whole thing — the output, the resolved source,
 * and the approach chosen — into the chat panel, where the answer arrives with
 * the code in it and the conversation can continue.
 *
 * The shortlist exists because a stack trace usually has more than one
 * plausible cause, and reading four one-line hypotheses is faster than reading
 * one long answer that guessed wrong. Nothing longer is generated until the
 * user has said which hypothesis is worth pursuing.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { CapturedError, ErrorCaptureService } from './errorCapture';
import { ParsedError, StackFrame, describeError, parseError, rankFrames } from './errorParser';
import {
  ChatMessage, ErrorContext, chat,
  buildErrorExplainPrompt, buildErrorQuestionPrompt,
  buildErrorSolutionsPrompt, buildErrorWalkthroughPrompt,
} from './llmProvider';

// ─── Solutions ────────────────────────────────────────────────────────────────

export interface ErrorSolution {
  /** The one-line heading shown in the pane. */
  title: string;
  /** The reasoning under it — cause, and the change proposed. */
  detail: string;
}

/** `1.` / `2)` / `- ` / `* ` / `Fix 3:` — every way a model numbers a list. */
const ITEM_START = /^\s*(?:(?:\d+)[.)]|[-*•]|(?:solution|fix|option|cause)\s*\d*\s*[:.])\s*(.+)$/i;

/** Markdown a picker shows as literal characters rather than as formatting. */
function cleanProse(text: string): string {
  return text.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function cleanTitle(text: string): string {
  return cleanProse(text.replace(/^#+\s*/, '')).replace(/[:\s]+$/, '').trim();
}

/**
 * Reads the shortlist back out of the reply. Models drift between numbered
 * lists, bullets and bolded headings no matter how the format is specified, so
 * all three are accepted, and a title that runs long is split at its first
 * sentence with the remainder pushed into the detail.
 */
export function parseSolutions(raw: string, limit = 6): ErrorSolution[] {
  const solutions: ErrorSolution[] = [];
  let current: ErrorSolution | undefined;

  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('```')) { continue; }

    // A heading on its own line is a title. Checked before the bullet forms,
    // whose leading `*` would otherwise eat the first star of a bolded one.
    const heading = /^\*\*(.+?)\*\*:?$/.exec(text) ?? /^#+\s+(.+)$/.exec(text);
    const started = heading ?? ITEM_START.exec(text);
    if (started) {
      current = { title: cleanTitle(started[1]), detail: '' };
      if (current.title) { solutions.push(current); }
      continue;
    }

    if (current) {
      const prose = cleanProse(text);
      current.detail = current.detail ? `${current.detail} ${prose}` : prose;
    }
  }

  for (const solution of solutions) {
    if (solution.title.length <= 80) { continue; }
    const split = solution.title.search(/[.;:] /);
    const at = split > 20 ? split : 77;
    const overflow = solution.title.slice(at + 1).trim();
    solution.title = solution.title.slice(0, at).trim() + (split > 20 ? '' : '…');
    solution.detail = overflow ? `${overflow} ${solution.detail}`.trim() : solution.detail;
  }

  return solutions.filter(s => s.title).slice(0, limit);
}

// ─── Resolved source ──────────────────────────────────────────────────────────

interface FrameContext {
  frame: StackFrame;
  uri: vscode.Uri;
  languageId: string;
  /** Zero-based line the snippet starts at, for labelling. */
  startLine: number;
  snippet: string;
}

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('llmCopilot').get<T>(key, fallback);
}

// ─── The assistant ────────────────────────────────────────────────────────────

interface ChatTarget {
  ask(display: string, messages: ChatMessage[]): Promise<void>;
  show(): void;
}

interface StatusTarget {
  setLoading(message: string): void;
  setIdle(): void;
  setError(message: string): void;
}

export class ErrorAssistant {
  constructor(
    private readonly chatProvider: ChatTarget,
    private readonly statusBar: StatusTarget,
    private readonly capture: ErrorCaptureService
  ) {}

  // ── Entry points ────────────────────────────────────────────────────────────

  /**
   * Terminal panel. A selection wins — it says exactly which failure is meant —
   * and otherwise the last command that exited badly is used.
   */
  async analyseTerminal(): Promise<void> {
    const selected = await this.capture.captureTerminalSelection();
    const captured = selected ?? this.capture.latest('terminal');
    if (!captured) {
      const hint = this.capture.hasShellIntegration
        ? 'No failed command was seen. Select the error text in the terminal and try again.'
        : 'This terminal does not report its commands. Select the error text in the terminal and try again.';
      vscode.window.showInformationMessage(`LLM Copilot: ${hint}`);
      return;
    }
    await this.analyse(captured);
  }

  /** Debug panel — whatever the debugger last stopped on or printed. */
  async analyseDebug(): Promise<void> {
    const captured = this.capture.latest('debug');
    if (!captured) {
      vscode.window.showInformationMessage(
        'LLM Copilot: nothing has failed in a debug session yet.'
      );
      return;
    }
    await this.analyse(captured);
  }

  /** Command palette — every failure still held, newest first. */
  async pickRecent(): Promise<void> {
    const recent = this.capture.recent();
    if (recent.length === 0) {
      vscode.window.showInformationMessage(
        'LLM Copilot: no errors captured yet from the terminal or the debugger.'
      );
      return;
    }

    interface CaptureItem extends vscode.QuickPickItem { captured: CapturedError; }
    const items: CaptureItem[] = recent.map(captured => {
      const parsed = parseError(captured.text, captured.source);
      return {
        captured,
        label: `$(${captured.source === 'debug' ? 'debug-alt' : 'terminal'}) ${parsed ? parsed.headline : captured.text.split('\n')[0]}`,
        description: captured.origin,
        detail: new Date(captured.at).toLocaleTimeString(),
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Which failure should be looked at?',
      matchOnDescription: true,
    });
    if (picked) { await this.analyse(picked.captured); }
  }

  // ── The pane ────────────────────────────────────────────────────────────────

  /** Reads the capture, asks for candidate fixes, and shows them. */
  async analyse(captured: CapturedError): Promise<void> {
    const parsed = parseError(captured.text, captured.source);
    if (!parsed) {
      await this.askRawly(captured);
      return;
    }

    const frames = await this.gatherContext(parsed);
    const context = toErrorContext(captured, parsed, frames);

    let solutions: ErrorSolution[] = [];
    this.statusBar.setLoading('Reading the error…');
    try {
      const count = setting('errorAssist.solutionCount', 4);
      const reply = await chat(buildErrorSolutionsPrompt(context, count));
      solutions = parseSolutions(reply, count);
      this.statusBar.setIdle();
    } catch (err: any) {
      this.statusBar.setError('Error');
      vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`);
      return;
    }

    await this.showPane(parsed, context, frames, solutions);
  }

  private async showPane(
    parsed: ParsedError,
    context: ErrorContext,
    frames: FrameContext[],
    solutions: ErrorSolution[]
  ): Promise<void> {
    interface PaneItem extends vscode.QuickPickItem {
      id: 'solution' | 'explain' | 'ask' | 'open' | 'copy';
      solution?: ErrorSolution;
    }
    type PaneEntry = PaneItem | (vscode.QuickPickItem & { id?: undefined });

    const items: PaneEntry[] = solutions.map((solution, index) => ({
      id: 'solution',
      solution,
      label: `$(lightbulb) ${solution.title}`,
      description: index === 0 ? 'most likely' : undefined,
      detail: solution.detail || undefined,
    }));

    if (items.length > 0) {
      items.push({ label: 'Or', kind: vscode.QuickPickItemKind.Separator });
    }

    items.push({
      id: 'explain',
      label: '$(comment-discussion) Explain this error',
      detail: 'What it means and how the program got here — no fix yet',
    });
    items.push({
      id: 'ask',
      label: '$(question) Ask something about it…',
      detail: 'Your own question, with the error and its code attached',
    });

    const top = frames[0];
    if (top) {
      const name = path.basename(top.uri.fsPath);
      items.push({
        id: 'open',
        label: `$(go-to-file) Open ${name}${top.frame.line ? ':' + top.frame.line : ''}`,
        detail: vscode.workspace.asRelativePath(top.uri),
      });
    }

    items.push({ id: 'copy', label: '$(clippy) Copy the error text' });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: describeError(parsed),
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!picked?.id) { return; }

    switch (picked.id) {
      case 'solution':
        await this.chatProvider.ask(
          this.seedText(context, `**Fix to try:** ${picked.solution!.title}`),
          buildErrorWalkthroughPrompt(context, picked.solution!)
        );
        break;

      case 'explain':
        await this.chatProvider.ask(
          this.seedText(context, 'What is this error telling me?'),
          buildErrorExplainPrompt(context)
        );
        break;

      case 'ask': {
        const question = await vscode.window.showInputBox({
          prompt: 'Ask about this error',
          placeHolder: 'e.g. why is it null here? what changed since it worked?',
          ignoreFocusOut: true,
        });
        if (!question?.trim()) { return; }
        await this.chatProvider.ask(
          this.seedText(context, question),
          buildErrorQuestionPrompt(context, question)
        );
        break;
      }

      case 'open':
        if (top) {
          const doc = await vscode.workspace.openTextDocument(top.uri);
          const editor = await vscode.window.showTextDocument(doc);
          const line = Math.max(0, (top.frame.line ?? 1) - 1);
          const at = new vscode.Position(line, Math.max(0, (top.frame.column ?? 1) - 1));
          editor.selection = new vscode.Selection(at, at);
          editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
        }
        break;

      case 'copy':
        await vscode.env.clipboard.writeText(context.errorText);
        vscode.window.showInformationMessage('LLM Copilot: error text copied.');
        break;
    }
  }

  /** Nothing recognisable in the output — hand it to the chat as it stands. */
  private async askRawly(captured: CapturedError): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'LLM Copilot: no error could be read out of that output. Ask about it anyway?',
      'Ask in Chat', 'Cancel'
    );
    if (choice !== 'Ask in Chat') { return; }

    const context: ErrorContext = {
      source: captured.source,
      origin: captured.origin,
      runtime: 'unknown',
      headline: captured.text.split('\n')[0] ?? '',
      errorText: captured.text,
      codeContext: '',
    };
    await this.chatProvider.ask(
      this.seedText(context, 'What went wrong here?'),
      buildErrorQuestionPrompt(context, 'What went wrong here?')
    );
  }

  // ── Chat hand-off ───────────────────────────────────────────────────────────

  /**
   * What the chat window shows as the user's turn. The model gets the whole
   * context; the bubble gets the question and enough of the output to recognise
   * it, since the panel it came from may already have scrolled away.
   */
  private seedText(context: ErrorContext, question: string): string {
    const lines = context.errorText.split('\n');
    const shown = lines.length > 14 ? [...lines.slice(0, 14), `… ${lines.length - 14} more lines`] : lines;
    const where = context.source === 'debug' ? 'debug session' : 'terminal';
    return `${question}\n\nFrom the ${where} (${context.origin}):\n\`\`\`text\n${shown.join('\n')}\n\`\`\``;
  }

  // ── Source resolution ───────────────────────────────────────────────────────

  /** Reads the code around the first frames that point into the workspace. */
  private async gatherContext(parsed: ParsedError): Promise<FrameContext[]> {
    const span = Math.max(10, setting('errorAssist.contextLines', 40));
    const found: FrameContext[] = [];

    for (const frame of rankFrames(parsed.frames)) {
      if (found.length >= 2) { break; }

      const uri = await this.resolveFrame(frame);
      if (!uri) { continue; }
      if (found.some(f => f.uri.fsPath === uri.fsPath && f.frame.line === frame.line)) { continue; }

      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const centre = Math.min(Math.max(0, (frame.line ?? 1) - 1), doc.lineCount - 1);
        const start = Math.max(0, centre - Math.floor(span / 2));
        const end = Math.min(doc.lineCount - 1, centre + Math.floor(span / 2));
        found.push({
          frame,
          uri,
          languageId: doc.languageId,
          startLine: start,
          snippet: doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length)),
        });
      } catch {
        // Unreadable or binary — the next frame may still resolve.
      }
    }

    return found;
  }

  /**
   * Turns the path a trace printed into a file in this workspace. Absolute
   * paths are checked as-is; anything relative is tried against each workspace
   * folder and then, as a last resort, searched for by file name — a Java trace
   * only names `Order.java`, never where it lives.
   */
  private async resolveFrame(frame: StackFrame): Promise<vscode.Uri | undefined> {
    const raw = frame.file.replace(/^file:\/\//, '');
    if (!raw || raw.startsWith('node:') || raw.includes('<')) { return undefined; }

    if (path.isAbsolute(raw)) {
      return await exists(vscode.Uri.file(raw));
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const candidate = await exists(vscode.Uri.joinPath(folder.uri, raw));
      if (candidate) { return candidate; }
    }

    const name = path.basename(raw);
    if (!name.includes('.')) { return undefined; }
    const matches = await vscode.workspace.findFiles(
      `**/${name}`, '**/{node_modules,out,dist,build,target,.git}/**', 8
    );
    if (matches.length === 0) { return undefined; }

    // Prefer a match whose tail is the path the trace printed.
    const tail = raw.replace(/\\/g, '/');
    return matches.find(uri => uri.path.endsWith(tail)) ?? matches[0];
  }
}

async function exists(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory ? undefined : uri;
  } catch {
    return undefined;
  }
}

// ─── Prompt context ───────────────────────────────────────────────────────────

function toErrorContext(
  captured: CapturedError, parsed: ParsedError, frames: FrameContext[]
): ErrorContext {
  const codeContext = frames
    .map(f => {
      const where = `${vscode.workspace.asRelativePath(f.uri)}, lines ${f.startLine + 1}-${f.startLine + f.snippet.split('\n').length}`;
      const marker = f.frame.line ? ` (the trace names line ${f.frame.line})` : '';
      return `${where}${marker}:\n\`\`\`${f.languageId}\n${f.snippet}\n\`\`\``;
    })
    .join('\n\n');

  return {
    source: captured.source,
    origin: captured.origin,
    runtime: parsed.origin,
    headline: parsed.headline,
    errorText: parsed.text,
    codeContext,
  };
}
