import * as vscode from 'vscode';
import * as path from 'path';
import { chatStream, ChatMessage } from './llmProvider';
import { Attachment, ChatReference, parseChatInput, renderAttachments, searchTerms } from './chatReferences';
import { expandPromptVariables, loadPromptFiles, PromptFile } from './promptFiles';
import { getProjectIndex } from './projectIndex';
import { git, repositoryRoot } from './workflowCommands';
import { runAgent, AgentObserver } from './agentSession';
import { CommandDecision, OriginalContentProvider, WorkspaceAgentTools } from './agentTools';
import * as os from 'os';

const SYSTEM_PROMPT =
  'You are an expert programming assistant. Help with code, debugging, architecture, ' +
  'and best practices. Format code with markdown code blocks.';

/** Characters of any one attachment sent with a message. */
const ATTACHMENT_BUDGET = 24000;

/** Commands built in to the panel; prompt files from the repository join these. */
const BUILT_IN_COMMANDS: { name: string; description: string; prompt?: string }[] = [
  { name: 'explain', description: 'Explain how the selected code works',
    prompt: 'Explain how this code works, step by step, and point out anything surprising.' },
  { name: 'fix', description: 'Find and fix problems in the selected code',
    prompt: 'Find the problems in this code and fix them. Show the corrected code in full, then say briefly what was wrong.' },
  { name: 'tests', description: 'Write unit tests for the selected code',
    prompt: 'Write unit tests for this code using the framework the project already uses. Cover normal cases, edge cases and failures.' },
  { name: 'doc', description: 'Write documentation comments for the selected code',
    prompt: 'Add documentation comments to this code in the idiom of its language. Show the code with the comments in place.' },
  { name: 'optimize', description: 'Make the selected code faster or leaner',
    prompt: 'Improve the performance of this code without changing its behaviour. Show the new code and explain the gain.' },
  { name: 'new', description: 'Sketch the files for a new project or feature',
    prompt: 'Lay out the files needed for what follows. For each one give its path as a heading and its full contents in a fenced block.' },
  { name: 'agent', description: 'Hand a task to the agent: it reads, edits and runs commands until done' },
  { name: 'clear', description: 'Start a new conversation' },
  { name: 'help', description: 'List the commands and # references' },
];

const REFERENCES: { name: string; description: string }[] = [
  { name: '#file:', description: 'Attach a file — #file:src/app.ts' },
  { name: '#selection', description: 'Attach the editor selection' },
  { name: '#codebase', description: 'Search the project index for what the question is about' },
  { name: '#problems', description: 'Attach the problems in the active file' },
  { name: '#changes', description: 'Attach the uncommitted git changes' },
  { name: '#terminalLastCommand', description: 'Attach the last failure from the terminal or debugger' },
];

export interface LastFailure { origin: string; text: string }

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'llmCopilot.chatView';
  private _view?: vscode.WebviewView;
  private conversationHistory: ChatMessage[] = [];
  private running?: AbortController;
  private promptFiles: PromptFile[] = [];
  private mode: 'ask' | 'agent' = 'ask';
  /** Commands the user said to always run, for the rest of this window's life. */
  private readonly allowedCommands = new Set<string>();
  private readonly approvals = new Map<string, (decision: CommandDecision) => void>();
  /** Finished agent runs whose changes can still be diffed or undone. */
  private readonly agentRuns = new Map<string, WorkspaceAgentTools>();
  private nextId = 1;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly lastFailure: () => LastFailure | undefined = () => undefined,
    private readonly originals: OriginalContentProvider = new OriginalContentProvider()
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(this.handleMessage.bind(this));
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case 'chat':
        await this.handleChat(message.text, message.includeContext);
        break;
      case 'stop':
        this.running?.abort();
        break;
      case 'clearHistory':
        this.clear();
        break;
      case 'insertCode':
        this.insertCodeToEditor(message.code);
        break;
      case 'insertTerminal': {
        const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('LLM Copilot');
        terminal.show();
        terminal.sendText(message.code, false);
        break;
      }
      case 'newFile': {
        const doc = await vscode.workspace.openTextDocument({ content: message.code, language: message.language || undefined });
        await vscode.window.showTextDocument(doc);
        break;
      }
      case 'getContext':
        this.sendEditorContext();
        break;
      case 'listCommands':
        await this.sendCommandList();
        break;
      case 'setMode':
        this.mode = message.mode === 'agent' ? 'agent' : 'ask';
        break;
      case 'approve': {
        const resolve = this.approvals.get(message.id);
        this.approvals.delete(message.id);
        if (message.always && message.command) { this.allowedCommands.add(message.command); }
        resolve?.(message.decision === 'run' ? 'run' : 'skip');
        break;
      }
      case 'openDiff':
        await this.openDiff(message.runId, message.path);
        break;
      case 'undoRun':
        await this.undoRun(message.runId);
        break;
    }
  }

  private clear() {
    this.running?.abort();
    for (const resolve of this.approvals.values()) { resolve('skip'); }
    this.approvals.clear();
    this.running = undefined;
    this.conversationHistory = [];
    this._view?.webview.postMessage({ type: 'historyCleared' });
  }

  private async sendCommandList() {
    this.promptFiles = await loadPromptFiles();
    const builtIn = new Set(BUILT_IN_COMMANDS.map(c => c.name));
    this._view?.webview.postMessage({
      type: 'commands',
      commands: [
        ...BUILT_IN_COMMANDS.map(c => ({ name: `/${c.name}`, description: c.description })),
        ...this.promptFiles.filter(p => !builtIn.has(p.name))
          .map(p => ({ name: `/${p.name}`, description: `${p.description} — ${p.source}` })),
      ],
      references: REFERENCES,
    });
  }

  private async handleChat(userText: string, includeContext: boolean) {
    if (!userText.trim()) { return; }
    const parsed = parseChatInput(userText);
    const editor = vscode.window.activeTextEditor;
    const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';

    let question = parsed.text;
    let asAgent = this.mode === 'agent' && !parsed.command;
    if (parsed.command === 'agent') {
      if (!parsed.text) { this.post({ type: 'info', text: 'Give the agent a task: `/agent add input validation to the signup form`', done: true }); return; }
      asAgent = true;
    } else if (parsed.command) {
      if (parsed.command === 'clear') { this.clear(); return; }
      if (parsed.command === 'help') { this.post({ type: 'info', text: this.helpText(), done: true }); return; }

      const builtIn = BUILT_IN_COMMANDS.find(c => c.name === parsed.command);
      const promptFile = builtIn ? undefined
        : (this.promptFiles.length ? this.promptFiles : (this.promptFiles = await loadPromptFiles()))
            .find(p => p.name === parsed.command);

      if (builtIn?.prompt) {
        question = parsed.text ? `${builtIn.prompt}\n\n${parsed.text}` : builtIn.prompt;
      } else if (promptFile) {
        question = expandPromptVariables(promptFile.body, {
          selection,
          file: editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : '',
          workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
          input: parsed.text,
        });
      } else {
        this.post({ type: 'error', message: `Unknown command /${parsed.command}. Type /help for the list.` });
        return;
      }
    }

    const references = [...parsed.references];
    const wantsSelection = includeContext || parsed.command !== undefined;
    if (wantsSelection && selection && !references.some(r => r.kind === 'selection')) {
      references.unshift({ kind: 'selection' });
    }

    const attachments = await this.resolve(references, question);
    const body = renderAttachments(attachments);
    const finalText = body ? `${question}\n\n${body}` : question;

    if (asAgent) {
      await this.runAgentTask(finalText, attachments.map(a => a.label));
      return;
    }

    this.conversationHistory.push({ role: 'user', content: finalText });
    await this.respond(
      [{ role: 'system', content: SYSTEM_PROMPT }, ...this.conversationHistory],
      attachments.map(a => a.label)
    );
  }

  /** Streams one reply into the panel and records it in the conversation. */
  private async respond(messages: ChatMessage[], used: string[] = []): Promise<void> {
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    this.post({ type: 'streamStart', used });

    try {
      const reply = await chatStream(messages, text => {
        if (this.running === controller) { this.post({ type: 'streamDelta', text }); }
      }, controller.signal);
      // A conversation cleared while this was streaming has moved on without it.
      if (this.running !== controller) { return; }
      if (reply) { this.conversationHistory.push({ role: 'assistant', content: reply }); }
      this.post({ type: 'streamEnd', text: reply, stopped: controller.signal.aborted });
    } catch (err: any) {
      if (this.running === controller) { this.post({ type: 'error', message: err.message }); }
    } finally {
      if (this.running === controller) { this.running = undefined; }
    }
  }

  // ── Agent ──────────────────────────────────────────────────────────────────

  private environment(): string {
    const root = vscode.workspace.workspaceFolders?.[0];
    const editor = vscode.window.activeTextEditor;
    const lines = [
      `Operating system: ${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'} (${os.release()}).`,
      `Shell: ${vscode.env.shell || process.env.SHELL || 'default'}.`,
      `Workspace root: ${root?.uri.fsPath ?? '(none)'}. All paths are relative to it.`,
    ];
    if (editor && editor.document.uri.scheme === 'file') {
      lines.push(`The user has ${vscode.workspace.asRelativePath(editor.document.uri, false)} open` +
        (editor.selection.isEmpty ? '.' : `, lines ${editor.selection.start.line + 1}–${editor.selection.end.line + 1} selected.`));
    }
    const digest = getProjectIndex()?.renderDigest();
    if (digest) { lines.push('', digest); }
    return lines.join('\n');
  }

  private confirm(command: string): Promise<CommandDecision> {
    if (this.allowedCommands.has(command)) { return Promise.resolve('run'); }
    const id = `approval-${this.nextId++}`;
    this.post({ type: 'agentApproval', id, command });
    const signal = this.running?.signal;
    return new Promise(resolve => {
      this.approvals.set(id, resolve);
      // Stopping the run answers any question still waiting on the user.
      signal?.addEventListener('abort', () => {
        if (this.approvals.delete(id)) { resolve('skip'); }
      });
    });
  }

  private async runAgentTask(task: string, used: string[]): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { this.post({ type: 'error', message: 'The agent needs a folder open to work in.' }); return; }

    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    const cfg = vscode.workspace.getConfiguration('llmCopilot');
    const tools = new WorkspaceAgentTools(root, command => this.confirm(command), cfg.get('agent.commandTimeoutSeconds', 120) * 1000);
    const runId = `run-${this.nextId++}`;

    let toolId = 0;
    const observer: AgentObserver = {
      turnStarted: step => this.post({ type: 'agentTurn', step }),
      turnText: text => this.post({ type: 'agentText', text }),
      toolStarted: call => this.post({ type: 'agentTool', id: ++toolId, state: 'running', label: `${call.name} …` }),
      toolFinished: (_call, outcome) => this.post({ type: 'agentTool', id: toolId, state: outcome.ok ? 'ok' : 'failed', label: outcome.summary }),
    };

    this.post({ type: 'agentStart', used });
    const history = this.conversationHistory.slice(-6).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`).join('\n\n');
    const fullTask = history ? `Earlier in this conversation:\n${history}\n\nThe task:\n${task}` : task;

    const result = await runAgent(fullTask, {
      reply: (messages, onDelta, signal) => chatStream(messages, onDelta, signal, 4096),
    }, tools, observer, {
      maxSteps: cfg.get('agent.maxSteps', 25),
      historyBudget: 60000,
      environment: this.environment(),
    }, controller.signal);

    for (const resolve of this.approvals.values()) { resolve('skip'); }
    this.approvals.clear();
    if (this.running === controller) { this.running = undefined; }

    const changes = tools.changes();
    if (changes.length) {
      this.agentRuns.set(runId, tools);
      this.originals.remember(runId, new Map(changes.map(c => [c.path, c.original])));
    }
    const summary = result.status === 'error' ? `The run failed: ${result.summary}`
      : result.status === 'stopped' ? 'Stopped.' : result.summary;
    this.conversationHistory.push({ role: 'user', content: task });
    this.conversationHistory.push({ role: 'assistant', content: summary || '(no summary)' });
    this.post({
      type: 'agentDone', status: result.status, summary, steps: result.steps, runId,
      changes: changes.map(c => ({ path: c.path, created: c.original === null })),
    });
  }

  private async openDiff(runId: string, rel: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return; }
    const current = vscode.Uri.joinPath(root, rel);
    await vscode.commands.executeCommand('vscode.diff', this.originals.uriFor(runId, rel), current, `${rel} (agent changes)`);
  }

  private async undoRun(runId: string): Promise<void> {
    const tools = this.agentRuns.get(runId);
    if (!tools) { return; }
    const answer = await vscode.window.showWarningMessage(
      'Put every file this agent run changed back the way it was?', { modal: true }, 'Undo all');
    if (answer !== 'Undo all') { return; }
    const restored = await tools.undoAll();
    this.agentRuns.delete(runId);
    this.post({ type: 'agentUndone', runId, restored });
  }

  private helpText(): string {
    const commands = BUILT_IN_COMMANDS.map(c => `**/${c.name}** — ${c.description}`);
    const prompts = this.promptFiles.map(p => `**/${p.name}** — ${p.description}`);
    const refs = REFERENCES.map(r => `**${r.name}** — ${r.description}`);
    return [
      '**Commands**', ...commands,
      ...(prompts.length ? ['', '**From .github/prompts**', ...prompts] : []),
      '', '**References** (anywhere in a message)', ...refs,
    ].join('\n');
  }

  // ── References ─────────────────────────────────────────────────────────────

  private async resolve(references: ChatReference[], question: string): Promise<Attachment[]> {
    const out: Attachment[] = [];
    for (const ref of references) {
      try {
        const attachment = await this.resolveOne(ref, question);
        if (attachment) {
          if (attachment.content.length > ATTACHMENT_BUDGET) {
            attachment.content = attachment.content.slice(0, ATTACHMENT_BUDGET) + '\n… (truncated)';
          }
          out.push(attachment);
        }
      } catch (err: any) {
        this.post({ type: 'info', text: `Could not attach ${ref.kind}${ref.arg ? ` ${ref.arg}` : ''}: ${err.message}` });
      }
    }
    return out;
  }

  private async resolveOne(ref: ChatReference, question: string): Promise<Attachment | undefined> {
    const editor = vscode.window.activeTextEditor;
    switch (ref.kind) {
      case 'selection': {
        if (!editor || editor.selection.isEmpty) { return undefined; }
        const file = vscode.workspace.asRelativePath(editor.document.uri, false);
        const start = editor.selection.start.line + 1;
        const end = editor.selection.end.line + 1;
        return {
          label: `Selection — ${file}:${start}-${end}`,
          language: editor.document.languageId,
          content: editor.document.getText(editor.selection),
        };
      }
      case 'file': {
        const uri = await this.findFile(ref.arg ?? '');
        if (!uri) { throw new Error('no such file in the workspace'); }
        const doc = await vscode.workspace.openTextDocument(uri);
        return { label: `File — ${vscode.workspace.asRelativePath(uri, false)}`, language: doc.languageId, content: doc.getText() };
      }
      case 'codebase': {
        const index = getProjectIndex();
        if (!index || !index.isReady()) { throw new Error('the project index is not built yet'); }
        const found = index.renderSearch(searchTerms(question));
        const digest = index.renderDigest();
        return { label: 'Codebase — matching declarations', language: '', content: [digest, found].filter(Boolean).join('\n\n') };
      }
      case 'problems': {
        if (!editor) { return undefined; }
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        const lines = diagnostics.map(d => {
          const level = ['error', 'warning', 'info', 'hint'][d.severity] ?? 'info';
          return `line ${d.range.start.line + 1} ${level}: ${d.message}${d.source ? ` (${d.source})` : ''}` +
            `\n    ${editor.document.lineAt(d.range.start.line).text.trim()}`;
        });
        return {
          label: `Problems — ${vscode.workspace.asRelativePath(editor.document.uri, false)}`,
          language: 'text',
          content: lines.join('\n') || 'No problems reported.',
        };
      }
      case 'changes': {
        const root = await repositoryRoot();
        if (!root) { throw new Error('not inside a git repository'); }
        const diff = await git(root, ['diff', 'HEAD', '--no-color']).catch(() => git(root, ['diff', '--no-color']));
        return { label: 'Uncommitted changes', language: 'diff', content: diff || 'No uncommitted changes.' };
      }
      case 'terminalLastCommand': {
        const failure = this.lastFailure();
        if (!failure) { throw new Error('nothing has failed in the terminal or debugger yet'); }
        return { label: `Last failure — ${failure.origin}`, language: 'text', content: failure.text };
      }
    }
  }

  private async findFile(spec: string): Promise<vscode.Uri | undefined> {
    if (!spec) { return undefined; }
    if (path.isAbsolute(spec)) { return vscode.Uri.file(spec); }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const candidate = vscode.Uri.joinPath(folder.uri, spec);
      try { await vscode.workspace.fs.stat(candidate); return candidate; } catch { /* not in this folder */ }
    }
    const matches = await vscode.workspace.findFiles(`**/${spec.replace(/^\.?\//, '')}`, '**/node_modules/**', 1);
    return matches[0];
  }

  // ── Editor ─────────────────────────────────────────────────────────────────

  private insertCodeToEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit((editBuilder) => {
        editBuilder.replace(editor.selection, code);
      });
    }
  }

  private sendEditorContext() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      this._view?.webview.postMessage({
        type: 'editorContext',
        hasSelection: !selection.isEmpty,
        language: editor.document.languageId,
        selectedText: selectedText.substring(0, 500),
      });
    }
  }

  private post(message: unknown) {
    this._view?.webview.postMessage(message);
  }

  public sendMessage(text: string) {
    this._view?.webview.postMessage({ type: 'externalMessage', text });
  }

  /**
   * Starts a turn the user did not type. The error pane composes its own
   * question — the failure, the source around it, and the approach chosen — and
   * hands it over whole; `display` is the shorter version that appears in the
   * bubble, and the reply lands in the conversation like any other, so the user
   * can carry straight on asking about it.
   */
  public async ask(display: string, messages: ChatMessage[]): Promise<void> {
    await this.reveal();

    const question = [...messages].reverse().find(m => m.role === 'user');
    this.conversationHistory.push({ role: 'user', content: question?.content ?? display });

    this._view?.webview.postMessage({ type: 'seedUser', text: display });
    await this.respond(messages);
  }

  public show() {
    this._view?.show(true);
  }

  /**
   * Brings the panel up and waits for the webview to exist. A view that has
   * never been opened resolves only once the focus command has run, and posting
   * to it before that silently goes nowhere.
   */
  private async reveal(): Promise<void> {
    this.show();
    await vscode.commands.executeCommand('llmCopilot.chatView.focus');
    for (let waited = 0; !this._view && waited < 2000; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', file));
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLM Copilot Chat</title>
<link rel="stylesheet" href="${media('chat.css')}">
</head>
<body>

<div id="header">
  <h2>🤖 LLM Copilot</h2>
  <div class="header-actions">
    <button class="icon-btn" id="ctx-btn" title="Get editor selection">⊞</button>
    <button class="icon-btn" id="clear-btn" title="New conversation">🗑</button>
  </div>
</div>

<div id="messages"></div>

<div id="suggestions" hidden></div>

<div id="context-bar">
  <select id="mode" title="Ask answers questions; Agent reads, edits and runs commands to finish a task">
    <option value="ask">Ask</option>
    <option value="agent">Agent</option>
  </select>
  <label>
    <input type="checkbox" id="include-context" checked>
    Include selected code
  </label>
  <span class="hint">/ for commands · # for references</span>
</div>

<div id="input-area">
  <textarea id="user-input" placeholder="Ask about your code... (Shift+Enter for new line)" rows="2"></textarea>
  <button id="send-btn">Send</button>
</div>

<script nonce="${nonce}" src="${media('chat.js')}"></script>
</body>
</html>`;
  }
}
