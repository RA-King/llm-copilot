import * as vscode from 'vscode';
import { chat } from './llmProvider';
import { EditHistory } from './editHistory';
import {
  buildNextEditPrompt, parseNextEdit, locateEdit, revertsLastEdit, trimEdit, LocatedEdit,
} from './nextEdit';

/**
 * Next edit suggestions in the editor. After an edit and a pause, the recent
 * edits are sent off and the predicted follow-up is drawn where it belongs:
 * the text it replaces struck through, the new text beside it. Tab jumps to a
 * suggestion elsewhere in the file and a second Tab applies it; Escape drops
 * it. Applying one is itself an edit, so a rename walks through the file one
 * Tab at a time.
 */

/** Lines either side of the cursor shown to the model. */
const WINDOW_LINES = 60;
/** Files larger than this are not worth the round trip. */
const MAX_FILE_CHARS = 400_000;

interface Suggestion {
  uri: string;
  version: number;
  edit: LocatedEdit;
  range: vscode.Range;
}

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('llmCopilot').get<T>(key, fallback);
}

export class NextEditController implements vscode.Disposable {
  private readonly histories = new Map<string, EditHistory>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private current: Suggestion | undefined;

  private readonly removed = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    textDecoration: 'line-through',
  });
  private readonly inserted = vscode.window.createTextEditorDecorationType({});
  private readonly hint = vscode.window.createTextEditorDecorationType({});

  register(): void {
    for (const editor of vscode.window.visibleTextEditors) { this.track(editor.document); }
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => this.track(doc)),
      vscode.workspace.onDidCloseTextDocument(doc => this.histories.delete(doc.uri.toString())),
      vscode.workspace.onDidChangeTextDocument(e => this.onChange(e)),
      vscode.window.onDidChangeActiveTextEditor(() => this.clear()),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (this.current && e.textEditor.document.uri.toString() === this.current.uri) { this.render(e.textEditor); }
      }),
    );
  }

  private track(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') { return; }
    const key = doc.uri.toString();
    if (!this.histories.has(key)) {
      const history = new EditHistory();
      history.reset(doc.getText());
      this.histories.set(key, history);
    }
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const key = e.document.uri.toString();
    const history = this.histories.get(key);
    if (!history || e.contentChanges.length === 0) { return; }

    history.apply(e.contentChanges);
    if (history.current !== e.document.getText()) {
      // Missed an event somewhere; start again from what the document says.
      history.reset(e.document.getText());
    }

    if (this.current?.uri === key) { this.clear(); }
    if (e.reason !== undefined) { return; }   // undo or redo: nothing to predict from

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== e.document) { return; }
    this.schedule(editor, history);
  }

  private schedule(editor: vscode.TextEditor, history: EditHistory): void {
    if (this.timer) { clearTimeout(this.timer); }
    if (!setting('enabled', true) || !setting('nextEdit.enabled', true)) { return; }
    const generation = ++this.generation;
    this.timer = setTimeout(() => { void this.predict(editor, history, generation); }, setting('nextEdit.debounceMs', 800));
  }

  private async predict(editor: vscode.TextEditor, history: EditHistory, generation: number): Promise<void> {
    const doc = editor.document;
    const text = doc.getText();
    if (history.edits().length === 0 || text.length > MAX_FILE_CHARS) { return; }

    const version = doc.version;
    const cursor = editor.selection.active;
    const first = Math.max(0, cursor.line - WINDOW_LINES);
    const last = Math.min(doc.lineCount - 1, cursor.line + WINDOW_LINES);
    const window = doc.getText(new vscode.Range(first, 0, last, doc.lineAt(last).text.length));

    let reply: string;
    try {
      reply = await chat(buildNextEditPrompt({
        language: doc.languageId,
        file: vscode.workspace.asRelativePath(doc.uri, false),
        history: history.render(),
        window,
        windowStart: first + 1,
        cursorLine: cursor.line + 1,
      }));
    } catch {
      return;   // a failed prediction is simply no prediction
    }

    if (generation !== this.generation || doc.version !== version || vscode.window.activeTextEditor !== editor) { return; }

    const parsed = parseNextEdit(reply);
    if (!parsed || revertsLastEdit(parsed, history.last())) { return; }
    // The model was shown the window, so the quote is looked for there first;
    // the whole file is the fallback for an edit just outside it.
    const windowOffset = doc.offsetAt(new vscode.Position(first, 0));
    const inWindow = locateEdit(window, parsed, doc.offsetAt(cursor) - windowOffset);
    const located = inWindow
      ? { ...inWindow, start: inWindow.start + windowOffset, end: inWindow.end + windowOffset }
      : locateEdit(text, parsed, doc.offsetAt(cursor));
    if (!located) { return; }
    const edit = trimEdit(text, located);

    this.current = {
      uri: doc.uri.toString(),
      version,
      edit,
      range: new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)),
    };
    void vscode.commands.executeCommand('setContext', 'llmCopilot.nextEditVisible', true);
    this.render(editor);
  }

  private render(editor: vscode.TextEditor): void {
    const s = this.current;
    if (!s || editor.document.uri.toString() !== s.uri) { return; }

    const lines = s.edit.replace.split('\n');
    const shown = lines[0] + (lines.length > 1 ? `  … +${lines.length - 1} line${lines.length > 2 ? 's' : ''}` : '');
    const hover = new vscode.MarkdownString();
    hover.appendMarkdown('**Next edit** — Tab to accept, Esc to dismiss\n');
    hover.appendCodeblock(
      [...editor.document.getText(s.range).split('\n').map(l => `- ${l}`), ...lines.map(l => `+ ${l}`)].join('\n'),
      'diff');

    editor.setDecorations(this.removed, s.range.isEmpty ? [] : [{ range: s.range, hoverMessage: hover }]);
    editor.setDecorations(this.inserted, s.edit.replace ? [{
      range: new vscode.Range(s.range.end, s.range.end),
      hoverMessage: hover,
      renderOptions: {
        after: {
          contentText: shown,
          color: new vscode.ThemeColor('editorGhostText.foreground'),
          backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
          fontStyle: 'italic',
        },
      },
    }] : []);

    const cursorLine = editor.selection.active.line;
    const far = cursorLine < s.range.start.line - 1 || cursorLine > s.range.end.line + 1;
    editor.setDecorations(this.hint, far ? [{
      range: new vscode.Range(cursorLine, Number.MAX_SAFE_INTEGER, cursorLine, Number.MAX_SAFE_INTEGER),
      renderOptions: {
        after: {
          contentText: `   ⇥ Tab: next edit at line ${s.range.start.line + 1}`,
          color: new vscode.ThemeColor('editorGhostText.foreground'),
          fontStyle: 'italic',
        },
      },
    }] : []);
  }

  /** Tab: go to the suggestion if it is elsewhere, apply it if the cursor is already there. */
  async acceptOrJump(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const s = this.current;
    if (!editor || !s || editor.document.uri.toString() !== s.uri || editor.document.version !== s.version) {
      this.clear();
      return;
    }

    const cursorLine = editor.selection.active.line;
    if (cursorLine < s.range.start.line - 1 || cursorLine > s.range.end.line + 1) {
      editor.selection = new vscode.Selection(s.range.start, s.range.start);
      editor.revealRange(s.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.render(editor);
      return;
    }

    this.clear();
    const start = s.range.start;
    const applied = await editor.edit(eb => eb.replace(s.range, s.edit.replace));
    if (applied) {
      const end = editor.document.positionAt(editor.document.offsetAt(start) + s.edit.replace.length);
      editor.selection = new vscode.Selection(end, end);
    }
  }

  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.generation++;
    if (!this.current) { return; }
    this.current = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.removed, []);
      editor.setDecorations(this.inserted, []);
      editor.setDecorations(this.hint, []);
    }
    void vscode.commands.executeCommand('setContext', 'llmCopilot.nextEditVisible', false);
  }

  dispose(): void {
    this.clear();
    this.disposables.forEach(d => d.dispose());
    this.removed.dispose();
    this.inserted.dispose();
    this.hint.dispose();
  }
}
