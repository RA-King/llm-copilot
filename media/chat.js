// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('user-input'));
  const sendBtn = document.getElementById('send-btn');
  const includeContextEl = /** @type {HTMLInputElement} */ (document.getElementById('include-context'));
  const suggestionsEl = document.getElementById('suggestions');
  const modeEl = /** @type {HTMLSelectElement} */ (document.getElementById('mode'));

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
  /** The agent run being shown: its bubble, the current turn's text, and its step lines by id. */
  let agent = null;

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
    const action = button.getAttribute('data-action');
    if (action === 'approve') {
      const card = button.closest('.approval');
      const decision = button.getAttribute('data-decision');
      vscode.postMessage({
        type: 'approve', id: card.getAttribute('data-id'), command: card.getAttribute('data-command'),
        decision: decision === 'skip' ? 'skip' : 'run', always: decision === 'always',
      });
      card.querySelector('.approval-buttons').textContent = decision === 'skip' ? 'Skipped.' : 'Approved.';
      return;
    }
    if (action === 'diff') {
      vscode.postMessage({ type: 'openDiff', runId: button.getAttribute('data-run'), path: button.getAttribute('data-path') });
      return;
    }
    if (action === 'undo') {
      vscode.postMessage({ type: 'undoRun', runId: button.getAttribute('data-run') });
      return;
    }
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
        agent = null;
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
        agent = null;
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

  // ── Mode ──────────────────────────────────────────────────────────────────

  function setMode(mode) {
    modeEl.value = mode;
    inputEl.placeholder = mode === 'agent'
      ? 'Describe a task — the agent reads, edits and runs commands to finish it'
      : 'Ask about your code... (Shift+Enter for new line)';
    vscode.postMessage({ type: 'setMode', mode });
    try { vscode.setState({ ...(vscode.getState() || {}), mode }); } catch { /* no state store */ }
  }

  modeEl.addEventListener('change', () => setMode(modeEl.value));
  setMode((vscode.getState() || {}).mode === 'agent' ? 'agent' : 'ask');

  // ── Agent runs ────────────────────────────────────────────────────────────

  function agentEvent(msg) {
    switch (msg.type) {
      case 'agentStart': {
        hideThinking();
        setBusy(true);
        const div = addMessage('assistant', '');
        div.classList.add('agent-run');
        const content = div.querySelector('.msg-content');
        if (msg.used && msg.used.length) {
          const used = document.createElement('div');
          used.className = 'used';
          used.textContent = 'Used ' + msg.used.join(' · ');
          content.appendChild(used);
        }
        agent = { content, text: null, steps: {} };
        break;
      }
      case 'agentTurn': {
        if (!agent) { return; }
        if (agent.text && !agent.text.textContent.trim()) { agent.text.remove(); }
        agent.text = document.createElement('div');
        agent.text.className = 'agent-text';
        agent.content.appendChild(agent.text);
        break;
      }
      case 'agentText':
        if (agent && agent.text) { agent.text.innerHTML = renderMarkdown(msg.text); }
        break;
      case 'agentTool': {
        if (!agent) { return; }
        let line = agent.steps[msg.id];
        if (!line) {
          line = document.createElement('div');
          agent.content.appendChild(line);
          agent.steps[msg.id] = line;
        }
        line.className = 'agent-step ' + msg.state;
        line.textContent = (msg.state === 'running' ? '⋯ ' : msg.state === 'ok' ? '✓ ' : '✗ ') + msg.label;
        break;
      }
      case 'agentApproval': {
        if (!agent) { return; }
        const card = document.createElement('div');
        card.className = 'approval';
        card.setAttribute('data-id', msg.id);
        card.setAttribute('data-command', msg.command);
        card.innerHTML = '<div>Run this command?</div><pre><code>' + escapeHtml(msg.command) + '</code></pre>' +
          '<div class="approval-buttons">' +
          '<button class="insert-btn primary" data-action="approve" data-decision="run">Run</button>' +
          '<button class="insert-btn" data-action="approve" data-decision="always">Always run this</button>' +
          '<button class="insert-btn" data-action="approve" data-decision="skip">Skip</button></div>';
        agent.content.appendChild(card);
        break;
      }
      case 'agentDone': {
        if (!agent) { setBusy(false); return; }
        if (agent.text && !agent.text.textContent.trim()) { agent.text.remove(); }
        if (msg.status !== 'done' && msg.summary) {
          const note = document.createElement('div');
          note.className = msg.status === 'error' ? 'error-msg' : 'stopped';
          note.textContent = msg.summary;
          agent.content.appendChild(note);
        }
        if (msg.changes && msg.changes.length) {
          const card = document.createElement('div');
          card.className = 'changes';
          card.setAttribute('data-run', msg.runId);
          card.innerHTML = '<div class="changes-title">' + msg.changes.length + ' file' + (msg.changes.length === 1 ? '' : 's') + ' changed</div>' +
            msg.changes.map(c => '<div class="change"><span>' + escapeHtml(c.path) + (c.created ? ' (new)' : '') + '</span>' +
              '<button class="insert-btn" data-action="diff" data-run="' + msg.runId + '" data-path="' + escapeHtml(c.path) + '">Diff</button></div>').join('') +
            '<div class="changes-actions"><button class="insert-btn" data-action="undo" data-run="' + msg.runId + '">Undo all</button></div>';
          agent.content.appendChild(card);
        }
        const steps = document.createElement('div');
        steps.className = 'used';
        steps.textContent = msg.steps + ' step' + (msg.steps === 1 ? '' : 's');
        agent.content.appendChild(steps);
        agent = null;
        setBusy(false);
        scrollDown();
        break;
      }
      case 'agentUndone': {
        const card = messagesEl.querySelector('.changes[data-run="' + msg.runId + '"]');
        if (card) {
          card.querySelectorAll('button').forEach(b => { b.disabled = true; });
          card.querySelector('.changes-actions').textContent = 'Undone — ' + msg.restored + ' file' + (msg.restored === 1 ? '' : 's') + ' restored.';
        }
        break;
      }
    }
    scrollDown();
  }

  window.addEventListener('message', (event) => {
    if (typeof event.data.type === 'string' && event.data.type.startsWith('agent')) { agentEvent(event.data); }
  });

  vscode.postMessage({ type: 'listCommands' });
})();
