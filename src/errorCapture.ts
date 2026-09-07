/**
 * errorCapture.ts
 *
 * Keeps hold of the failures that scroll past in the terminal and the debug
 * console so they can still be asked about a minute later, when the user has
 * finished reading them and wants help.
 *
 * Two feeds:
 *
 *   • Terminal — shell integration reports every command the shell runs, its
 *     output stream and its exit code. A non-zero exit is taken as a failure
 *     outright; a zero exit is only kept when the output reads like one anyway,
 *     which is how test runners and linters that swallow their status behave.
 *     Terminals without shell integration (a plain `Terminal.sendText`, a
 *     remote shell that has not sourced the hooks) are still served: the user
 *     selects the error and {@link ErrorCaptureService.captureTerminalSelection}
 *     lifts it out through the clipboard.
 *
 *   • Debug — a debug adapter tracker sees every message between the editor and
 *     the adapter. `output` events carry whatever the program writes to stdout
 *     and stderr, and a `stopped` event with reason `exception` is the moment
 *     the debugger lands on a throw, at which point the adapter can be asked for
 *     the exception's own description.
 *
 * Nothing here reaches a model. It only remembers; `errorAssist.ts` decides
 * what to do with what was remembered.
 */

import * as vscode from 'vscode';
import { ErrorSource, extractErrorBlock, looksLikeError } from './errorParser';

// ─── Captures ─────────────────────────────────────────────────────────────────

export interface CapturedError {
  id: number;
  source: ErrorSource;
  /** The command line, or the name of the debug session, that produced it. */
  origin: string;
  /** Output, trimmed to the part that matters. */
  text: string;
  cwd?: string;
  /** Process exit code where one was reported. */
  exitCode?: number;
  at: number;
}

/** How much raw output is held per command before the front is dropped. */
const MAX_BUFFERED_CHARS = 60_000;

/** How many past failures stay available to the picker. */
const MAX_KEPT = 20;

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('llmCopilot').get<T>(key, fallback);
}

// ─── Shell integration ────────────────────────────────────────────────────────

// Shell integration reached the stable API after this extension's declared
// engine, so it is reached through a narrow structural type and used only when
// the running editor actually provides it.

interface TerminalExecution {
  commandLine?: { value: string };
  cwd?: vscode.Uri;
  read(): AsyncIterable<string>;
}

interface ShellExecutionStartEvent {
  terminal: vscode.Terminal;
  execution: TerminalExecution;
}

interface ShellExecutionEndEvent extends ShellExecutionStartEvent {
  exitCode: number | undefined;
}

interface ShellIntegrationApi {
  onDidStartTerminalShellExecution?(listener: (e: ShellExecutionStartEvent) => void): vscode.Disposable;
  onDidEndTerminalShellExecution?(listener: (e: ShellExecutionEndEvent) => void): vscode.Disposable;
}

interface RunningCommand {
  command: string;
  cwd?: string;
  output: string;
  /** Resolves when the output stream closes, which is at or just after the end event. */
  reading: Promise<void>;
}

// ─── Debug sessions ───────────────────────────────────────────────────────────

interface DebugBuffer {
  output: string;
  /** Set once a capture has been taken, so the end of the session adds nothing. */
  reported: boolean;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ErrorCaptureService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly captures: CapturedError[] = [];
  private nextId = 1;
  private shellIntegrationSeen = false;

  /**
   * @param onFailure Called when something fails while the user is watching —
   *   the extension uses it to offer the pane without being asked.
   */
  constructor(private readonly onFailure: (error: CapturedError) => void) {}

  /** Starts both feeds. Safe to call on an editor that has neither. */
  register(): void {
    this.watchTerminals();
    this.watchDebugSessions();
  }

  // ── Terminal ────────────────────────────────────────────────────────────────

  private watchTerminals(): void {
    const api = vscode.window as unknown as ShellIntegrationApi;
    if (typeof api.onDidStartTerminalShellExecution !== 'function' ||
        typeof api.onDidEndTerminalShellExecution !== 'function') {
      return;
    }
    this.shellIntegrationSeen = true;

    const running = new Map<TerminalExecution, RunningCommand>();

    this.disposables.push(api.onDidStartTerminalShellExecution(event => {
      if (!setting('errorAssist.enabled', true)) { return; }

      const entry: RunningCommand = {
        command: event.execution.commandLine?.value ?? event.terminal.name,
        cwd: event.execution.cwd?.fsPath,
        output: '',
        reading: Promise.resolve(),
      };

      entry.reading = (async () => {
        try {
          for await (const chunk of event.execution.read()) {
            entry.output += chunk;
            if (entry.output.length > MAX_BUFFERED_CHARS) {
              entry.output = entry.output.slice(-MAX_BUFFERED_CHARS);
            }
          }
        } catch {
          // The terminal was closed while the command was still writing.
        }
      })();

      running.set(event.execution, entry);
    }));

    this.disposables.push(api.onDidEndTerminalShellExecution(async event => {
      const entry = running.get(event.execution);
      running.delete(event.execution);
      if (!entry || !setting('errorAssist.enabled', true)) { return; }

      await entry.reading;

      // A reported exit code is the truth. Without one — some shells and remote
      // sessions do not report — fall back to reading the output.
      const failed = typeof event.exitCode === 'number'
        ? event.exitCode !== 0
        : looksLikeError(entry.output);
      if (!failed || !entry.output.trim()) { return; }

      const captured = this.record({
        source: 'terminal',
        origin: entry.command,
        text: entry.output,
        cwd: entry.cwd,
        exitCode: event.exitCode,
      });
      if (captured) { this.onFailure(captured); }
    }));
  }

  /**
   * Lifts whatever is selected in the terminal out through the clipboard, which
   * is the only route the stable API offers to a terminal's own text. The
   * clipboard is put back the way it was found.
   */
  async captureTerminalSelection(): Promise<CapturedError | undefined> {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) { return undefined; }

    const previous = await vscode.env.clipboard.readText();
    let selected = '';
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      selected = await vscode.env.clipboard.readText();
    } catch {
      selected = '';
    } finally {
      await vscode.env.clipboard.writeText(previous);
    }

    // Nothing was selected — the clipboard still holds what it held before.
    if (!selected.trim() || selected === previous) { return undefined; }

    return this.record({ source: 'terminal', origin: terminal.name, text: selected });
  }

  /** Whether this editor reports shell commands at all. */
  get hasShellIntegration(): boolean {
    return this.shellIntegrationSeen;
  }

  // ── Debug ───────────────────────────────────────────────────────────────────

  private watchDebugSessions(): void {
    const buffers = new Map<string, DebugBuffer>();

    this.disposables.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker: (session: vscode.DebugSession) => {
        const buffer: DebugBuffer = { output: '', reported: false };
        buffers.set(session.id, buffer);

        return {
          onDidSendMessage: (message: any) => {
            if (!setting('errorAssist.enabled', true)) { return; }
            this.readAdapterMessage(session, buffer, message);
          },
          onWillStopSession: () => {
            this.flushSession(session, buffer);
            buffers.delete(session.id);
          },
          onExit: (code: number | undefined) => {
            if (code) { this.flushSession(session, buffer, code); }
          },
        };
      },
    }));
  }

  private readAdapterMessage(session: vscode.DebugSession, buffer: DebugBuffer, message: any): void {
    if (!message || message.type !== 'event') { return; }

    if (message.event === 'output') {
      const category: string = message.body?.category ?? 'console';
      if (category === 'telemetry') { return; }
      buffer.output += message.body?.output ?? '';
      if (buffer.output.length > MAX_BUFFERED_CHARS) {
        buffer.output = buffer.output.slice(-MAX_BUFFERED_CHARS);
      }
      return;
    }

    // Landing on a throw is the one moment where the user is definitely looking
    // at the failure, so it is captured with whatever the adapter knows about it.
    if (message.event === 'stopped' && message.body?.reason === 'exception') {
      void this.recordException(session, buffer, message.body);
    }
  }

  private async recordException(session: vscode.DebugSession, buffer: DebugBuffer, body: any): Promise<void> {
    const parts: string[] = [];
    const described: string = body?.description ?? body?.text ?? '';
    if (described) { parts.push(described); }

    try {
      const info: any = await session.customRequest('exceptionInfo', { threadId: body?.threadId });
      if (info) {
        for (const line of [info.description, info.details?.message, info.details?.stackTrace]) {
          if (line && !parts.includes(line)) { parts.push(line); }
        }
      }
    } catch {
      // Not every adapter implements exceptionInfo; the output buffer still stands.
    }

    if (buffer.output.trim()) { parts.push(buffer.output); }
    const text = parts.join('\n').trim();
    if (!text) { return; }

    buffer.reported = true;
    const captured = this.record({ source: 'debug', origin: session.name, text });
    if (captured) { this.onFailure(captured); }
  }

  /** A session that ends badly without ever stopping on an exception. */
  private flushSession(session: vscode.DebugSession, buffer: DebugBuffer, exitCode?: number): void {
    if (buffer.reported || !buffer.output.trim()) { return; }
    if (!exitCode && !looksLikeError(buffer.output)) { return; }

    buffer.reported = true;
    const captured = this.record({
      source: 'debug',
      origin: session.name,
      text: buffer.output,
      exitCode,
    });
    if (captured) { this.onFailure(captured); }
  }

  // ── Store ───────────────────────────────────────────────────────────────────

  private record(input: Omit<CapturedError, 'id' | 'at'>): CapturedError | undefined {
    const text = extractErrorBlock(input.text, setting('errorAssist.maxOutputLines', 120));
    if (!text) { return undefined; }

    // The same failure often arrives twice — once on stderr, once as the
    // adapter's own description of it.
    const newest = this.captures[0];
    if (newest && newest.text === text) { return undefined; }

    const captured: CapturedError = { ...input, text, id: this.nextId++, at: Date.now() };
    this.captures.unshift(captured);
    if (this.captures.length > MAX_KEPT) { this.captures.length = MAX_KEPT; }
    return captured;
  }

  /** Newest first. */
  recent(limit = MAX_KEPT): CapturedError[] {
    return this.captures.slice(0, limit);
  }

  latest(source?: ErrorSource): CapturedError | undefined {
    return source ? this.captures.find(c => c.source === source) : this.captures[0];
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }
}
