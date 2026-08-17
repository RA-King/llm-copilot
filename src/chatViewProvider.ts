import * as vscode from 'vscode';
import { chat, ChatMessage } from './llmProvider';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'llmCopilot.chatView';
  private _view?: vscode.WebviewView;
  private conversationHistory: ChatMessage[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this.getHtmlContent();
    webviewView.webview.onDidReceiveMessage(this.handleMessage.bind(this));
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case 'chat':
        await this.handleChat(message.text, message.includeContext);
        break;
      case 'clearHistory':
        this.conversationHistory = [];
        this._view?.webview.postMessage({ type: 'historyCleared' });
        break;
      case 'insertCode':
        this.insertCodeToEditor(message.code);
        break;
      case 'getContext':
        this.sendEditorContext();
        break;
    }
  }

  private async handleChat(userText: string, includeContext: boolean) {
    if (!userText.trim()) { return; }

    // Optionally include editor context
    let finalText = userText;
    if (includeContext) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        if (selectedText) {
          finalText = `Given this ${editor.document.languageId} code:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\`\n\n${userText}`;
        }
      }
    }

    this.conversationHistory.push({ role: 'user', content: finalText });

    // Build messages with system prompt
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are an expert programming assistant. Help with code, debugging, architecture, and best practices. Format code with markdown code blocks.'
      },
      ...this.conversationHistory
    ];

    this._view?.webview.postMessage({ type: 'thinking' });

    try {
      const response = await chat(messages);
      this.conversationHistory.push({ role: 'assistant', content: response });
      this._view?.webview.postMessage({
        type: 'response',
        text: response,
        userText: userText,
      });
    } catch (err: any) {
      this._view?.webview.postMessage({
        type: 'error',
        message: err.message,
      });
    }
  }

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

  public sendMessage(text: string) {
    this._view?.webview.postMessage({ type: 'externalMessage', text });
  }

  public show() {
    this._view?.show(true);
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLM Copilot Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  #header {
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--vscode-sideBarSectionHeader-background);
    flex-shrink: 0;
  }

  #header h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }

  .header-actions { display: flex; gap: 4px; }

  .icon-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 14px;
    opacity: 0.7;
    transition: opacity 0.15s, background 0.15s;
  }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    scroll-behavior: smooth;
  }

  #messages:empty::after {
    content: "Ask anything about your code...";
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 12px;
    text-align: center;
    margin-top: 20px;
  }

  .msg {
    max-width: 100%;
    animation: fadeIn 0.2s ease;
  }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

  .msg-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 3px;
    opacity: 0.6;
  }

  .msg-user .msg-label { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .msg-assistant .msg-label { color: var(--vscode-gitDecoration-modifiedResourceForeground); }

  .msg-content {
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.5;
    word-break: break-word;
  }

  .msg-user .msg-content {
    background: var(--vscode-inputOption-activeBackground);
    border: 1px solid var(--vscode-inputOption-activeBorder);
  }

  .msg-assistant .msg-content {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
  }

  pre {
    background: var(--vscode-editor-background) !important;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px;
    overflow-x: auto;
    margin: 6px 0;
    position: relative;
  }

  code {
    font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
    font-size: 11px;
  }

  p code {
    background: var(--vscode-textBlockQuote-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }

  .copy-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 10px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  pre:hover .copy-btn { opacity: 1; }
  .copy-btn:hover { background: var(--vscode-button-background); }

  .insert-btn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 10px;
    cursor: pointer;
    margin-top: 4px;
    transition: background 0.15s;
  }
  .insert-btn:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

  .thinking {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    opacity: 0.6;
    padding: 6px 10px;
    font-style: italic;
  }

  .dots { display: flex; gap: 3px; }
  .dot {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: var(--vscode-foreground);
    animation: bounce 1.2s infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }

  .error-msg {
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 11px;
  }

  #context-bar {
    padding: 4px 8px;
    background: var(--vscode-sideBarSectionHeader-background);
    border-top: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  #context-bar label {
    font-size: 10px;
    opacity: 0.7;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  #input-area {
    padding: 8px;
    border-top: 1px solid var(--vscode-panel-border);
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    background: var(--vscode-sideBar-background);
  }

  #user-input {
    flex: 1;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-input-foreground);
    border-radius: 4px;
    padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    resize: none;
    min-height: 60px;
    max-height: 150px;
    outline: none;
    transition: border-color 0.15s;
  }
  #user-input:focus { border-color: var(--vscode-focusBorder); }
  #user-input::placeholder { opacity: 0.5; }

  #send-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 12px;
    align-self: flex-end;
    transition: background 0.15s;
    white-space: nowrap;
  }
  #send-btn:hover { background: var(--vscode-button-hoverBackground); }
  #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  p { margin: 4px 0; }
  ul, ol { padding-left: 16px; margin: 4px 0; }
  h1, h2, h3 { font-size: 13px; margin: 6px 0 4px; }
  strong { font-weight: 600; }
</style>
</head>
<body>

<div id="header">
  <h2>🤖 LLM Copilot</h2>
  <div class="header-actions">
    <button class="icon-btn" id="ctx-btn" title="Get editor selection">⊞</button>
    <button class="icon-btn" id="clear-btn" title="Clear conversation">🗑</button>
  </div>
</div>

<div id="messages"></div>

<div id="context-bar">
  <label>
    <input type="checkbox" id="include-context" checked>
    Include selected code
  </label>
</div>

<div id="input-area">
  <textarea id="user-input" placeholder="Ask about your code... (Shift+Enter for new line)" rows="2"></textarea>
  <button id="send-btn">Send</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn');
  const includeContextEl = document.getElementById('include-context');
  let isThinking = false;
  let thinkingEl = null;

  function escapeHtml(text) {
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderMarkdown(text) {
    // Code blocks
    text = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
      const id = 'code_' + Math.random().toString(36).slice(2);
      return \`<pre id="\${id}"><code>\${escapeHtml(code.trimEnd())}</code><button class="copy-btn" onclick="copyCode('\${id}')">Copy</button><button class="insert-btn" onclick="insertCode('\${id}')">Insert into editor</button></pre>\`;
    });
    // Inline code
    text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    // Bold
    text = text.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\\*(.*?)\\*/g, '<em>$1</em>');
    // Lines
    text = text.split('\\n').map(line => {
      if (line.startsWith('# ')) return '<h1>' + line.slice(2) + '</h1>';
      if (line.startsWith('## ')) return '<h2>' + line.slice(3) + '</h2>';
      if (line.startsWith('### ')) return '<h3>' + line.slice(4) + '</h3>';
      if (line.startsWith('- ') || line.startsWith('* ')) return '<li>' + line.slice(2) + '</li>';
      if (line.trim() === '') return '<br>';
      return '<p>' + line + '</p>';
    }).join('');
    return text;
  }

  function copyCode(id) {
    const pre = document.getElementById(id);
    const code = pre.querySelector('code').textContent;
    navigator.clipboard.writeText(code).catch(() => {});
  }

  function insertCode(id) {
    const pre = document.getElementById(id);
    const code = pre.querySelector('code').textContent;
    vscode.postMessage({ type: 'insertCode', code });
  }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'msg msg-' + role;
    const label = role === 'user' ? 'You' : '🤖 Assistant';
    div.innerHTML = \`<div class="msg-label">\${label}</div><div class="msg-content">\${renderMarkdown(text)}</div>\`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showThinking() {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    thinkingEl.innerHTML = '<span>Thinking</span><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
    messagesEl.appendChild(thinkingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideThinking() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isThinking) { return; }
    addMessage('user', text);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    isThinking = true;
    sendBtn.disabled = true;
    showThinking();
    vscode.postMessage({
      type: 'chat',
      text,
      includeContext: includeContextEl.checked
    });
  }

  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    messagesEl.innerHTML = '';
    vscode.postMessage({ type: 'clearHistory' });
  });

  document.getElementById('ctx-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'getContext' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'thinking':
        // already shown
        break;
      case 'response':
        hideThinking();
        isThinking = false;
        sendBtn.disabled = false;
        addMessage('assistant', msg.text);
        break;
      case 'error':
        hideThinking();
        isThinking = false;
        sendBtn.disabled = false;
        const errDiv = document.createElement('div');
        errDiv.className = 'error-msg';
        errDiv.textContent = '⚠️ ' + msg.message;
        messagesEl.appendChild(errDiv);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      case 'historyCleared':
        break;
      case 'editorContext':
        if (msg.hasSelection) {
          inputEl.value = '';
          inputEl.focus();
        }
        break;
      case 'externalMessage':
        inputEl.value = msg.text;
        inputEl.focus();
        break;
    }
  });
</script>
</body>
</html>`;
  }
}
