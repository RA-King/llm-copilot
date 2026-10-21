// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('user-input'));
  const sendBtn = document.getElementById('send-btn');
  const includeContextEl = /** @type {HTMLInputElement} */ (document.getElementById('include-context'));
  const suggestionsEl = document.getElementById('suggestions');

  let busy = false;
  let thinkingEl = null;
  /** The reply being streamed: its element and the text so far. */
  let live = null;
  let renderQueued = false;
  /** Code from rendered blocks, by the id on their buttons. */
  const codeBlocks = [];
  let commands = [];
  let references = [];
  let suggestions = [];
  let activeSuggestion = 0;

  const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'ps1', 'pwsh', 'cmd', 'fish']);

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inline(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  }

  function renderProse(text) {
    const out = [];
    let list = null;
    for (const line of text.split('\n')) {
      const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (item) {
        if (!list) { list = []; }
        list.push('<li>' + inline(item[1]) + '</li>');
        continue;
      }
      if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) { out.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>'); }
      else if (line.trim()) { out.push('<p>' + inline(line) + '</p>'); }
    }
    if (list) { out.push('<ul>' + list.join('') + '</ul>'); }
    return out.join('');
  }

  function renderCode(lang, code) {
    const id = codeBlocks.push({ code, lang }) - 1;
    const actions = [
      '<button class="insert-btn" data-action="insert" data-id="' + id + '">Insert into editor</button>',
      '<button class="insert-btn" data-action="newFile" data-id="' + id + '">New file</button>',
    ];
    if (SHELL_LANGS.has(lang.toLowerCase())) {
      actions.push('<button class="insert-btn" data-action="terminal" data-id="' + id + '">Insert into terminal</button>');
    }
    return '<pre><code>' + escapeHtml(code) + '</code>' +
      '<button class="copy-btn" data-action="copy" data-id="' + id + '">Copy</button></pre>' +
      '<div class="code-actions">' + actions.join('') + '</div>';
  }

  /** Markdown, tolerant of a reply cut off mid-stream inside a fence. */
  function renderMarkdown(text) {
    const parts = [];
    const fence = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(```|$)/g;
    let last = 0;
    let m;
    while ((m = fence.exec(text)) !== null) {
      parts.push(renderProse(text.slice(last, m.index)));
      parts.push(renderCode(m[1] || '', m[2].replace(/\s+$/, '')));
      last = fence.lastIndex;
      if (m[0].length === 0) { break; }
    }
    parts.push(renderProse(text.slice(last)));
    return parts.join('');
  }

  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'msg msg-' + role;
    const label = role === 'user' ? 'You' : '🤖 Assistant';
    div.innerHTML = '<div class="msg-label">' + label + '</div><div class="msg-content">' +
      (role === 'user' ? renderProse(text) : renderMarkdown(text)) + '</div>';
    messagesEl.appendChild(div);
    scrollDown();
    return div;
  }

  function addNote(className, text) {
    const div = document.createElement('div');
    div.className = className;
    div.innerHTML = renderProse(text);
    messagesEl.appendChild(div);
    scrollDown();
  }

  function showThinking() {
    hideThinking();
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    thinkingEl.innerHTML = '<span>Thinking</span><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
    messagesEl.appendChild(thinkingEl);
    scrollDown();
  }

  function hideThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  function setBusy(value) {
    busy = value;
    sendBtn.textContent = value ? 'Stop' : 'Send';
    sendBtn.classList.toggle('stop', value);
  }

  function renderLive() {
    renderQueued = false;
    if (!live) { return; }
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    codeBlocks.length = live.firstBlock;
    live.content.innerHTML = renderMarkdown(live.text);
    if (nearBottom) { scrollDown(); }
  }

  function sendMessage() {
    if (busy) { vscode.postMessage({ type: 'stop' }); return; }
    const text = inputEl.value.trim();
    if (!text) { return; }
    hideSuggestions();
    addMessage('user', text);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    setBusy(true);
    showThinking();
    vscode.postMessage({ type: 'chat', text, includeContext: includeContextEl.checked });
  }

  // ── Suggestions for / and # ───────────────────────────────────────────────

  /** The word being typed at the caret, and where it starts. */
  function tokenAtCaret() {
    const caret = inputEl.selectionStart;
    const before = inputEl.value.slice(0, caret);
    const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1;
    return { word: before.slice(start), start, end: caret };
  }

  function updateSuggestions() {
    const { word, start } = tokenAtCaret();
    let pool = [];
    if (word.startsWith('/') && start === 0) { pool = commands; }
    else if (word.startsWith('#')) { pool = references; }
    const needle = word.toLowerCase();
    suggestions = word ? pool.filter(s => s.name.toLowerCase().startsWith(needle) && s.name !== word) : [];
    if (suggestions.length === 0) { hideSuggestions(); return; }
    activeSuggestion = Math.min(activeSuggestion, suggestions.length - 1);
    suggestionsEl.innerHTML = suggestions.map((s, i) =>
      '<div class="suggestion' + (i === activeSuggestion ? ' active' : '') + '" data-index="' + i + '">' +
      '<span class="name">' + escapeHtml(s.name) + '</span><span class="desc">' + escapeHtml(s.description) + '</span></div>'
    ).join('');
    suggestionsEl.hidden = false;
  }

  function hideSuggestions() {
    suggestions = [];
    activeSuggestion = 0;
    suggestionsEl.hidden = true;
  }

  function acceptSuggestion(index) {
    const chosen = suggestions[index];
    if (!chosen) { return; }
    const { start, end } = tokenAtCaret();
    const insert = chosen.name.endsWith(':') ? chosen.name : chosen.name + ' ';
    inputEl.value = inputEl.value.slice(0, start) + insert + inputEl.value.slice(end);
    const caret = start + insert.length;
    inputEl.setSelectionRange(caret, caret);
    hideSuggestions();
    inputEl.focus();
  }

  suggestionsEl.addEventListener('mousedown', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('.suggestion');
    if (row) { e.preventDefault(); acceptSuggestion(Number(row.getAttribute('data-index'))); }
  });

  // ── Events ────────────────────────────────────────────────────────────────

  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', (e) => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        activeSuggestion = (activeSuggestion + step + suggestions.length) % suggestions.length;
        updateSuggestions();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        acceptSuggestion(activeSuggestion);
        return;
      }
      if (e.key === 'Escape') { hideSuggestions(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
    updateSuggestions();
  });

  inputEl.addEventListener('focus', () => vscode.postMessage({ type: 'listCommands' }));
  inputEl.addEventListener('blur', () => setTimeout(hideSuggestions, 100));

  messagesEl.addEventListener('click', (e) => {
    const button = /** @type {HTMLElement} */ (e.target).closest('button[data-action]');
    if (!button) { return; }
    const block = codeBlocks[Number(button.getAttribute('data-id'))];
    if (!block) { return; }
    switch (button.getAttribute('data-action')) {
      case 'copy': navigator.clipboard.writeText(block.code).catch(() => {}); break;
      case 'insert': vscode.postMessage({ type: 'insertCode', code: block.code }); break;
      case 'terminal': vscode.postMessage({ type: 'insertTerminal', code: block.code }); break;
      case 'newFile': vscode.postMessage({ type: 'newFile', code: block.code, language: block.lang }); break;
    }
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'clearHistory' });
  });

  document.getElementById('ctx-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'getContext' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'streamStart': {
        hideThinking();
        setBusy(true);
        const div = addMessage('assistant', '');
        if (msg.used && msg.used.length) {
          const used = document.createElement('div');
          used.className = 'used';
          used.textContent = 'Used ' + msg.used.length + ' reference' + (msg.used.length === 1 ? '' : 's') + ': ' + msg.used.join(' · ');
          div.insertBefore(used, div.querySelector('.msg-content'));
        }
        live = { content: div.querySelector('.msg-content'), text: '', firstBlock: codeBlocks.length };
        break;
      }
      case 'streamDelta':
        if (live) {
          live.text += msg.text;
          if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderLive); }
        }
        break;
      case 'streamEnd':
        if (live) {
          live.text = msg.text || live.text;
          renderLive();
          if (msg.stopped) {
            const note = document.createElement('div');
            note.className = 'stopped';
            note.textContent = 'Stopped.';
            live.content.appendChild(note);
          }
        }
        live = null;
        setBusy(false);
        break;
      case 'response':
        hideThinking();
        setBusy(false);
        addMessage('assistant', msg.text);
        break;
      case 'error':
        hideThinking();
        live = null;
        setBusy(false);
        addNote('error-msg', '⚠️ ' + msg.message);
        break;
      case 'info':
        if (msg.done) { hideThinking(); setBusy(false); }
        addNote('info-msg', msg.text);
        break;
      case 'commands':
        commands = msg.commands;
        references = msg.references;
        break;
      case 'historyCleared':
        messagesEl.innerHTML = '';
        codeBlocks.length = 0;
        hideThinking();
        live = null;
        setBusy(false);
        break;
      case 'editorContext':
        if (msg.hasSelection) {
          inputEl.value = '';
          inputEl.focus();
        }
        break;
      case 'seedUser':
        addMessage('user', msg.text);
        setBusy(true);
        showThinking();
        break;
      case 'externalMessage':
        inputEl.value = msg.text;
        inputEl.focus();
        break;
    }
  });

  vscode.postMessage({ type: 'listCommands' });
})();
