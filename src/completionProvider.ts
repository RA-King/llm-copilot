import * as vscode from 'vscode';
import { getCompletion } from './llmProvider';
import { analyseCursorContext, shouldSuggest, CursorIntent } from './contextAnalyzer';
import { formatCompletion, detectIndentStyle, stripArtefacts } from './formatter';
import { extractKeywordTrigger } from './keywordTrigger';
import { guardAgainstDuplication } from './duplicationGuard';
import { gatherWorkspaceSignatures } from './workspaceContext';
import { getPendingDocComment, clearPendingDocComment } from './docTrigger';

export class LLMInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private cache = new Map<string, { text: string; timestamp: number }>();
  private readonly CACHE_SIZE = 100;
  private readonly CACHE_TTL_MS = 60_000;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    try {
      if (document.isClosed) { return null; }
      return await this._provide(document, position, context, token);
    } catch (err: any) {
      // Swallow expected errors silently — 405/404 during discovery, cancellation
      const msg = err.message || '';
      if (msg !== 'cancelled' && !/HTTP (405|404|501)/.test(msg) && !msg.includes('proxy not found')) {
        console.error('[LLM Copilot] provideInlineCompletionItems error:', msg);
      }
      return null;
    }
  }

  private async _provide(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    const cfg = vscode.workspace.getConfiguration('llmCopilot');
    if (!cfg.get('enabled', true)) { return null; }

    // ── Pending doc comment (user typed // or /**) ──────────────────────────
    // The DocTriggerWatcher generated a comment and stored it here. Return it
    // as a ghost-text InlineCompletionItem so the user Tab-accepts or Escapes.
    {
      const pending = getPendingDocComment();
      if (pending
          && pending.uri  === document.uri.toString()
          && pending.line === position.line
          && pending.line < document.lineCount) {   // guard: doc may have changed

        clearPendingDocComment(); // consume it — return exactly once

        // The item replaces the entire trigger line (// or /**) with the comment.
        const safePendingLine = Math.max(0, Math.min(pending.line, document.lineCount - 1));
        const triggerLine = document.lineAt(safePendingLine);
        const replaceRange = new vscode.Range(
          pending.line, 0,                   // start of trigger line
          pending.line, triggerLine.text.length  // end of trigger line
        );

        const item = new vscode.InlineCompletionItem(
          new vscode.SnippetString(escapeSnippet(pending.formatted) + '$0'),
          replaceRange
        );
        // Show a subtle hint so the user knows what to do
        item.command = {
          command: 'editor.action.inlineSuggest.showToolbar',
          title:   'Doc comment ready — Tab to accept, Escape to discard',
        };

        return new vscode.InlineCompletionList([item]);
      }
    }

    const langs: string[] = cfg.get('enabledLanguages', []);
    if (langs.length > 0 && !langs.includes(document.languageId)) { return null; }

    if (document.lineCount === 0) { return null; }

    // ── Clamp position ──────────────────────────────────────────────────────
    const safeLine = Math.max(0, Math.min(position.line, document.lineCount - 1));
    const lineText = document.lineAt(safeLine).text;
    const safeChar = Math.max(0, Math.min(position.character, lineText.length));
    const safePos  = new vscode.Position(safeLine, safeChar);

    // ── Context analysis ────────────────────────────────────────────────────
    const cursorCtx = analyseCursorContext(document, safePos);

    // Suppress ghost text on pure doc-comment trigger lines (DocTriggerWatcher handles those)
    const linePrefix = lineText.substring(0, safeChar);
    const isDocTrigger =
      /^\/\/\s*$/.test(linePrefix) ||
      /^\/\*\*?\s*(\*\/)?\s*$/.test(linePrefix) ||
      /^\/\/\/\s*$/.test(linePrefix) ||
      /^#\s*$/.test(linePrefix);
    if (isDocTrigger) { return null; }

    // Check for keyword trigger even when intent would normally be suppressed
    const keywordHit = extractKeywordTrigger(linePrefix, document.languageId);
    const intentAllows = shouldSuggest(cursorCtx.intent);

    if (!intentAllows && !keywordHit) { return null; }

    // ── Cache ───────────────────────────────────────────────────────────────
    const cacheKey = this.buildCacheKey(document, safePos);
    const cached   = this.getFromCache(cacheKey);
    if (cached) {
      return this.makeList(cached, safePos, document, lineText, safeChar);
    }

    // ── Context window check (5 lines up, 5 lines down from where last typed) ──
    // Ghost text is only relevant near where the user is actively editing.
    // If VS Code re-fires the provider for a position that is far from the
    // current cursor (e.g. after scrolling), suppress to avoid stale suggestions.
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document === document) {
      const cursorLine = activeEditor.selection.active.line;
      const lineDelta  = Math.abs(cursorLine - safeLine);
      if (lineDelta > 5) { return null; }
    }

    // Allow both Automatic and Invoke — the debouncer controls timing.
    // Automatic is fine here because the provider returns quickly (cache hits)
    // and the LLM path has its own debounce via the CompletionDebouncer.

    // ── Build LLM request ───────────────────────────────────────────────────
    const contextLines: number = cfg.get('contextLines', 50);
    const { prefix, suffix } = this.buildContext(document, safePos, contextLines);

    const intentMap: Record<CursorIntent, 'new-block' | 'new-statement' | 'completing-started'> = {
      'new-block':              'new-block',
      'new-statement':          'new-statement',
      'new-line-after-complete':'new-statement',
      'completing-started':     'completing-started',
      'inside-existing':        'new-statement',
      'refactor-candidate':     'new-statement',
      'ambiguous':              'new-statement',
    };

    // Keyword triggers behave like 'completing-started'
    const effectiveIntent = keywordHit
      ? 'completing-started'
      : intentMap[cursorCtx.intent];

    // Gather cross-file signatures concurrently (700ms budget)
    // Skip if already cancelled
    if (token.isCancellationRequested) { return null; }
    const workspaceSigs = await Promise.race([
      gatherWorkspaceSignatures(document.fileName, document.languageId, prefix, 700),
      new Promise<{context:string;sources:string[]}>(resolve =>
        token.onCancellationRequested(() => resolve({context:'',sources:[]}))
      ),
    ]);

    const raw = await Promise.race([
      getCompletion({
        prefix, suffix,
        language: document.languageId,
        filename: document.fileName,
        intent: effectiveIntent,
        keywordHint: keywordHit ?? undefined,
        nestingDepth: cursorCtx.nestingDepth,
        structure: cursorCtx.structure,
        workspaceContext: workspaceSigs.context || undefined,
      }),
      new Promise<string>((_, reject) =>
        token.onCancellationRequested(() => reject(new Error('cancelled')))
      ),
    ]);

    if (!raw?.trim()) { return null; }

    // ── Format ──────────────────────────────────────────────────────────────
    const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
    const indentStyle = editor
      ? detectIndentStyle(document, editor)
      : { useTabs: false, tabSize: 2, unit: '  ' };

    const formatted = formatCompletion(raw, document, safePos, indentStyle);
    if (!formatted) { return null; }

    // ── Duplication guard (three levels) ─────────────────────────────────
    // Removes/rejects any suggestion that already exists in the file.
    const typedOnLine = lineText.substring(0, safeChar);
    const { prefix: fullPrefix, suffix: fullSuffix } = this.buildContext(document, safePos, contextLines);
    const guarded = guardAgainstDuplication(formatted, fullPrefix, fullSuffix, typedOnLine);
    if (!guarded) { return null; }

    this.saveToCache(cacheKey, guarded);
    return this.makeList(guarded, safePos, document, lineText, safeChar);
  }

  /**
   * Build an InlineCompletionList whose item:
   *  - Replaces the remainder of the current line (so Tab inserts cleanly)
   *  - Uses SnippetString so the cursor lands at the end of the insertion
   *  - Is correctly indented for the first line (already handled by formatter)
   */
  private makeList(
    text: string,
    pos: vscode.Position,
    doc: vscode.TextDocument,
    lineText: string,
    safeChar: number
  ): vscode.InlineCompletionList {
    if (!text) { return new vscode.InlineCompletionList([]); }

    // The range to replace: from cursor to the end of the current line.
    // This ensures that Tab-accepting the suggestion doesn't leave dangling
    // text from the partial keyword that was already typed.
    const lineEnd = lineText.length;
    const replaceRange = new vscode.Range(
      pos.line, safeChar,
      pos.line, lineEnd
    );

    // The duplication guard has already stripped echoed prefixes upstream.
    // Just pass the text through directly here.
    const textToInsert = text;
    if (!textToInsert) { return new vscode.InlineCompletionList([]); }

    const item = new vscode.InlineCompletionItem(
      // Use SnippetString with $0 at end so cursor lands after insertion
      new vscode.SnippetString(escapeSnippet(textToInsert) + '$0'),
      replaceRange
    );

    return new vscode.InlineCompletionList([item]);
  }

  /**
   * If the LLM echoed back the already-typed line prefix, strip it from the
   * completion so the inserted text doesn't duplicate what's already there.
   */
  private stripEchoedPrefix(
    completion: string,
    lineText: string,
    safeChar: number
  ): string {
    const typedOnLine = lineText.substring(0, safeChar).trimStart();
    if (!typedOnLine) { return completion; }

    const lines = completion.split('\n');
    const firstLine = lines[0];

    // If the first line of the completion starts with what's already typed, remove it
    const firstTrimmed = firstLine.trimStart();
    if (firstTrimmed.startsWith(typedOnLine)) {
      lines[0] = firstLine.slice(firstLine.indexOf(typedOnLine) + typedOnLine.length);
    }

    // Remove now-empty first line if the rest follows
    if (lines[0].trim() === '' && lines.length > 1) {
      lines.shift();
    }

    return lines.join('\n');
  }

  // ─── Context / cache helpers ────────────────────────────────────────────

  private buildContext(doc: vscode.TextDocument, pos: vscode.Position, lines: number) {
    const start   = Math.max(0, pos.line - lines);
    const end     = Math.min(doc.lineCount - 1, pos.line + Math.floor(lines / 4));
    const lineLen = doc.lineAt(pos.line).text.length;
    const sc      = Math.min(pos.character, lineLen);
    return {
      prefix: doc.getText(new vscode.Range(start, 0, pos.line, sc)),
      suffix: doc.getText(new vscode.Range(pos.line, sc, end, doc.lineAt(end).text.length)),
    };
  }

  private buildCacheKey(doc: vscode.TextDocument, pos: vscode.Position): string {
    // Include the LINE number in the cache key so suggestions from a different
    // line are never served as ghost text for the current line.
    const start   = Math.max(0, pos.line - 10);
    const lineLen = doc.lineAt(pos.line).text.length;
    const sc      = Math.min(pos.character, lineLen);
    try {
      return `${doc.fileName}:L${pos.line}:${doc.getText(new vscode.Range(start, 0, pos.line, sc)).slice(-300)}`;
    } catch {
      return `${doc.fileName}:L${pos.line}:${sc}`;
    }
  }

  private getFromCache(key: string): string | null {
    const e = this.cache.get(key);
    if (!e) { return null; }
    if (Date.now() - e.timestamp > this.CACHE_TTL_MS) { this.cache.delete(key); return null; }
    return e.text;
  }

  private saveToCache(key: string, text: string) {
    if (this.cache.size >= this.CACHE_SIZE) {
      const k = this.cache.keys().next().value;
      if (k) { this.cache.delete(k); }
    }
    this.cache.set(key, { text, timestamp: Date.now() });
  }

  clearCache() { this.cache.clear(); }
}

// ─── Snippet escaping ─────────────────────────────────────────────────────────

/**
 * Escape special SnippetString characters in plain text.
 * VS Code snippet syntax uses $ and } as special chars.
 */
function escapeSnippet(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$')
    .replace(/}/g, '\\}');
}

// ─── Debouncer ────────────────────────────────────────────────────────────────

export class CompletionDebouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposable: vscode.Disposable;
  private lastTriggerLine = -1;   // line where we last fired a suggestion
  private cursorMoveDisposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeTextDocument(this.onChange.bind(this));

    // Track cursor movement: if user moves more than 5 lines from where ghost
    // text was triggered, dismiss the suggestion immediately.
    this.cursorMoveDisposable = vscode.window.onDidChangeTextEditorSelection(e => {
      if (this.lastTriggerLine < 0) { return; }
      const curLine = e.selections[0]?.active.line ?? -1;
      if (curLine < 0) { return; }
      if (Math.abs(curLine - this.lastTriggerLine) > 5) {
        // User moved too far — clear any in-flight timer so we don't show
        // a stale suggestion when the trigger fires
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.lastTriggerLine = -1;
        // VS Code auto-dismisses ghost text when the cursor moves to a position
        // outside the completion range, so no explicit dismiss call needed.
      }
    });
  }

  private onChange(event: vscode.TextDocumentChangeEvent) {
    const cfg = vscode.workspace.getConfiguration('llmCopilot');
    if (!cfg.get('enabled', true) || !cfg.get('autoTrigger', true)) { return; }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) { return; }
    if (!event.contentChanges.length) { return; }

    const change = event.contentChanges[0];
    if (change.text.length > 50) { return; } // paste

    if (editor.document.lineCount === 0) { return; }

    const pos      = editor.selection.active;
    const safeLine = Math.max(0, Math.min(pos.line, editor.document.lineCount - 1));
    let lineText   = '';
    try { lineText = editor.document.lineAt(safeLine).text; } catch { return; }

    const linePrefix = lineText.substring(0, Math.min(pos.character, lineText.length));
    const charsAfter = lineText.length - Math.min(pos.character, lineText.length);

    // ── Keyword trigger: fire quickly (reduced debounce) ─────────────────
    const keyword = extractKeywordTrigger(linePrefix, editor.document.languageId);
    if (keyword) {
      if (this.timer) { clearTimeout(this.timer); }
      // Shorter debounce for keywords (user likely just finished the word)
      const keywordDebounce = Math.min(cfg.get<number>('debounceMs', 600), 400);
      this.lastTriggerLine = safeLine;
      this.timer = setTimeout(() => this.fireTrigger(event.document), keywordDebounce);
      return;
    }

    // ── Suppress on pure comment-trigger lines ──────────────────────────
    // These are handled exclusively by DocTriggerWatcher, not ghost text.
    const trimmedPrefix = linePrefix.trim();
    const isDocTriggerLine =
      /^\/\/\s*$/.test(linePrefix) ||          // //
      /^\/\*\*?\s*(\*\/)?\s*$/.test(linePrefix) || // /** or /* */
      /^\/\/\/\s*$/.test(linePrefix) ||        // /// (Rust)
      /^#\s*$/.test(linePrefix);                // # (Python/Ruby)
    if (isDocTriggerLine) { return; }

    // ── Standard suppression rules ────────────────────────────────────────
    if (trimmedPrefix.length > 10 && charsAfter > 2) { return; }
    if (trimmedPrefix.length > 15 && charsAfter === 0 && change.text.length === 0) { return; }

    if (this.timer) { clearTimeout(this.timer); }
    const debounceMs: number = cfg.get('debounceMs', 600);
    this.timer = setTimeout(() => this.fireTrigger(event.document), debounceMs);
  }

  private async fireTrigger(document: vscode.TextDocument) {
    try {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document !== document) { return; }
      if (!vscode.workspace.getConfiguration('llmCopilot').get('enabled', true)) { return; }
      if (ed.document.lineCount === 0) { return; }

      const curPos  = ed.selection.active;
      const sl      = Math.max(0, Math.min(curPos.line, ed.document.lineCount - 1));
      const lineText = ed.document.lineAt(sl).text;
      const safePos  = new vscode.Position(sl, Math.min(curPos.character, lineText.length));

      // Re-check: keyword trigger OR intent-based trigger
      const linePrefix = lineText.substring(0, safePos.character);

      // Suppress ghost text on pure doc-comment trigger lines
      const isDocLine =
        /^\/\/\s*$/.test(linePrefix) ||
        /^\/\*\*?\s*(\*\/)?\s*$/.test(linePrefix) ||
        /^\/\/\/\s*$/.test(linePrefix) ||
        /^#\s*$/.test(linePrefix);
      if (isDocLine) { return; }

      const keyword = extractKeywordTrigger(linePrefix, ed.document.languageId);
      if (!keyword) {
        const { analyseCursorContext, shouldSuggest } = await import('./contextAnalyzer');
        const ctx = analyseCursorContext(ed.document, safePos);
        if (!shouldSuggest(ctx.intent)) { return; }
      }

      this.lastTriggerLine = safePos.line;
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    } catch (err: any) {
      console.error('[LLM Copilot] debounce timer error:', err.message);
    }
  }

  dispose() {
    if (this.timer) { clearTimeout(this.timer); }
    this.disposable.dispose();
    this.cursorMoveDisposable.dispose();
  }
}
