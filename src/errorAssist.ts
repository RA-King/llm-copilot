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
  buildErrorDiagnosisPrompt, buildErrorExplainPrompt, buildErrorQuestionPrompt,
  buildErrorSolutionsPrompt, buildErrorWalkthroughPrompt,
} from './llmProvider';
import { DeepContext, EMPTY_DEEP_CONTEXT, ResolvedFrame, gatherDeepContext } from './deepContext';

// ─── Solutions ────────────────────────────────────────────────────────────────

export interface ErrorSolution {
  /** The one-line heading shown in the pane. */
  title: string;
  /** The reasoning under it — cause, and the change proposed. */
  detail: string;
  /** The file the fix edits, as the model named it; '' when it named none. */
  file?: string;
  /** The line within that file, one-based; 0 when unstated. */
  line?: number;
  /** How sure the model said it was. */
  confidence?: 'likely' | 'possible' | 'unlikely';
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
      current = readTarget(cleanTitle(started[1]));
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

/**
 * Pull the `[file:line]` and `(likely)` the solutions prompt asks for out of a
 * title, leaving the title itself readable.
 *
 * Both are optional and both are hints. A model that ignores the format loses
 * the jump-to-the-edit entry in the pane and nothing else, which is why they
 * are parsed off the title rather than demanded as structured output.
 */
export function readTarget(rawTitle: string): ErrorSolution {
  let title = rawTitle;
  let file = '';
  let line = 0;
  let confidence: ErrorSolution['confidence'];

  const located = /\[([^\]\s]+?)(?::(\d+))?\]/.exec(title);
  if (located && /[./\\]/.test(located[1])) {
    file = located[1];
    line = located[2] ? parseInt(located[2], 10) : 0;
    title = title.replace(located[0], '').trim();
  }

  const sureness = /\((likely|possible|unlikely)\)/i.exec(title);
  if (sureness) {
    confidence = sureness[1].toLowerCase() as ErrorSolution['confidence'];
    title = title.replace(sureness[0], '').trim();
  }

  title = title.replace(/[\s—–-]+$/, '').trim();
  return { title, detail: '', file, line, confidence };
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

    this.statusBar.setLoading('Resolving the files the trace names…');
    const frames = await this.gatherContext(parsed);

    // What the rest of the project says about the names in this failure. It is
    // the difference between a fix written against the real signatures and one
    // written against plausible ones, so it is gathered before the first ask
    // rather than only when the user drills in.
    let deep: DeepContext = EMPTY_DEEP_CONTEXT;
    if (setting('errorAssist.deepContext', true)) {
      this.statusBar.setLoading('Reading the project around it…');
      deep = await gatherDeepContext(parsed, frames.map(toResolvedFrame), {
        budgetChars: setting('errorAssist.projectContextChars', 4000),
        includeManifest: true,
        includeDependents: true,
      }).catch(() => EMPTY_DEEP_CONTEXT);
    }

    const context = toErrorContext(captured, parsed, frames, deep);

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

    await this.showPane(parsed, context, frames, solutions, deep);
  }

  private async showPane(
    parsed: ParsedError,
    context: ErrorContext,
    frames: FrameContext[],
    solutions: ErrorSolution[],
    deep: DeepContext
  ): Promise<void> {
    interface PaneItem extends vscode.QuickPickItem {
      id: 'solution' | 'diagnose' | 'explain' | 'ask' | 'open' | 'goto' | 'copy';
      solution?: ErrorSolution;
    }
    type PaneEntry = PaneItem | (vscode.QuickPickItem & { id?: undefined });

    const items: PaneEntry[] = solutions.map((solution, index) => ({
      id: 'solution',
      solution,
      label: `$(lightbulb) ${solution.title}`,
      // The site of the edit is more use here than a ranking the user can see
      // for themselves from the order.
      description: describeSolution(solution, index),
      detail: solution.detail || undefined,
    }));

    if (items.length > 0) {
      items.push({ label: 'Or', kind: vscode.QuickPickItemKind.Separator });
    }

    items.push({
      id: 'diagnose',
      label: '$(microscope) Work it through properly',
      detail: deep.text
        ? `Full diagnosis against ${deep.resolvedNames.length} resolved name${deep.resolvedNames.length === 1 ? '' : 's'}` +
          (deep.dependents.length ? ` and ${deep.dependents.length} caller${deep.dependents.length === 1 ? '' : 's'}` : '')
        : 'Full diagnosis: the sequence, the cause, the change, the fallout',
    });
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

    // Anywhere else the answer named, reachable without leaving the pane.
    for (const target of namedTargets(solutions, top)) {
      items.push({
        id: 'goto',
        solution: target,
        label: `$(go-to-file) Open ${target.file}${target.line ? ':' + target.line : ''}`,
        detail: 'Named by one of the fixes above',
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

      case 'diagnose':
        await this.chatProvider.ask(
          this.seedText(context, 'Work this through properly — cause, change, and what else it touches.'),
          buildErrorDiagnosisPrompt(context)
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
          await reveal(top.uri, (top.frame.line ?? 1) - 1, (top.frame.column ?? 1) - 1);
        }
        break;

      case 'goto': {
        const target = picked.solution;
        if (!target?.file) { return; }
        const uri = await this.resolveNamedFile(target.file);
        if (!uri) {
          vscode.window.showWarningMessage(`LLM Copilot: could not find ${target.file} in the workspace.`);
          return;
        }
        await reveal(uri, Math.max(0, (target.line ?? 1) - 1), 0);
        break;
      }

      case 'copy':
        await vscode.env.clipboard.writeText(context.errorText);
        vscode.window.showInformationMessage('LLM Copilot: error text copied.');
        break;
    }
  }

  /** A path the answer named, turned back into a file that exists. */
  private async resolveNamedFile(named: string): Promise<vscode.Uri | undefined> {
    const cleaned = named.replace(/^\.\//, '').replace(/\\/g, '/');

    if (path.isAbsolute(cleaned)) { return await exists(vscode.Uri.file(cleaned)); }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const candidate = await exists(vscode.Uri.joinPath(folder.uri, cleaned));
      if (candidate) { return candidate; }
    }

    const matches = await vscode.workspace.findFiles(
      `**/${path.basename(cleaned)}`, '**/{node_modules,out,dist,build,target,.git}/**', 8);
    return matches.find(uri => uri.path.endsWith(cleaned)) ?? matches[0];
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

/** Open a file at a position and put it in the middle of the screen. */
async function reveal(uri: vscode.Uri, line: number, column: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const at = new vscode.Position(
    Math.max(0, Math.min(line, doc.lineCount - 1)), Math.max(0, column));
  editor.selection = new vscode.Selection(at, at);
  editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
}

/** The pane's right-hand column: where the fix lands, and how sure it is. */
function describeSolution(solution: ErrorSolution, index: number): string | undefined {
  const parts: string[] = [];
  if (solution.file) {
    parts.push(`${path.basename(solution.file)}${solution.line ? ':' + solution.line : ''}`);
  }
  if (solution.confidence) { parts.push(solution.confidence); }
  else if (index === 0) { parts.push('most likely'); }
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * Files the candidate fixes named that are not the one the trace already
 * pointed at. A cause that lives one file away from the throw is common, and
 * without this the pane makes the user go and find it.
 */
function namedTargets(
  solutions: ErrorSolution[], top: FrameContext | undefined
): ErrorSolution[] {
  const already = top ? vscode.workspace.asRelativePath(top.uri, false).replace(/\\/g, '/') : '';
  const seen = new Set<string>();
  const out: ErrorSolution[] = [];

  for (const solution of solutions) {
    if (!solution.file) { continue; }
    const key = `${solution.file}:${solution.line ?? 0}`;
    if (seen.has(key)) { continue; }
    if (already && (already.endsWith(solution.file) || solution.file.endsWith(already))) { continue; }
    seen.add(key);
    out.push(solution);
    if (out.length >= 3) { break; }
  }

  return out;
}

/** What `deepContext` needs from a frame this module already resolved. */
function toResolvedFrame(frame: FrameContext): ResolvedFrame {
  return {
    uri: frame.uri,
    languageId: frame.languageId,
    startLine: frame.startLine,
    snippet: frame.snippet,
    tracedLine: frame.frame.line ?? 0,
  };
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
  captured: CapturedError, parsed: ParsedError, frames: FrameContext[],
  deep: DeepContext = EMPTY_DEEP_CONTEXT
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
    projectContext: deep.text || undefined,
  };
}
