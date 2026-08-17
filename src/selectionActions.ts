import * as vscode from 'vscode';
import {
  chat,
  buildExplainPrompt, buildFixPrompt, buildRefactorPrompt,
  buildTestPrompt, buildDocstringPrompt, buildInlineChatPrompt,
  buildImplementationPrompt, ChatMessage,
} from './llmProvider';
import { analyseStructure } from './structureAnalyzer';

/**
 * selectionActions.ts
 *
 * When the user selects a non-trivial code snippet, show an inline
 * context action bar (CodeLens-style quick-pick) offering AI actions.
 *
 * Triggers when:
 *   - Selection is 2+ non-blank lines, OR
 *   - Selection is 1 line of 10+ characters
 *   - Selection has been stable for 600ms (debounced to avoid flicker)
 */

export class SelectionActionProvider {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly chatProvider: { sendMessage(t: string): void; show(): void },
    private readonly statusBar: { setLoading(m: string): void; setIdle(): void; setError(m: string): void }
  ) {
    // No automatic listener — triggered only by explicit Ctrl+Space on a selection
  }

  /**
   * Called by the registered command (Ctrl+Space with selection).
   * Validates the selection then shows the action quick-pick immediately.
   */
  async triggerForActiveSelection(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('llmCopilot');
    if (!cfg.get('enabled', true)) { return; }

    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const sel = editor.selection;
    if (sel.isEmpty) {
      vscode.window.showInformationMessage('LLM Copilot: Select some code first, then press Ctrl+Space.');
      return;
    }

    const selectedText = editor.document.getText(sel);
    if (!selectedText.trim()) { return; }

    await this.showActionPicker(editor, sel, selectedText);
  }

  private async showActionPicker(
    editor: vscode.TextEditor,
    sel: vscode.Selection,
    selectedText: string
  ) {
    const doc = editor.document;
    const lang = doc.languageId;
    const lineCount = sel.end.line - sel.start.line + 1;

    // Detect structural context for smarter labels
    const structure = analyseStructure(doc, sel.start);
    const inClass = structure.structureKind === 'class-body' || structure.structureKind === 'impl-body';

    // Build action items
    interface ActionItem extends vscode.QuickPickItem {
      id: string;
    }

    const items: ActionItem[] = [
      {
        id: 'explain',
        label: '$(info) Explain',
        description: 'Explain what this code does',
      },
      {
        id: 'fix',
        label: '$(wrench) Fix bugs',
        description: 'Detect and fix bugs in selection',
      },
      {
        id: 'refactor',
        label: '$(edit) Refactor…',
        description: 'Refactor with custom instruction',
      },
      {
        id: 'tests',
        label: '$(beaker) Generate tests',
        description: 'Write unit tests for this code',
      },
      {
        id: 'docstring',
        label: '$(comment) Add doc comment',
        description: 'Generate documentation comment',
      },
      {
        id: 'chat',
        label: '$(comment-discussion) Ask in chat…',
        description: 'Open AI chat with this snippet',
      },
    ];

    // Add class-specific actions when inside a class
    if (inClass) {
      items.splice(4, 0, {
        id: 'constructor',
        label: '$(symbol-constructor) Generate constructor',
        description: `For ${structure.containerName}`,
      });
      items.splice(5, 0, {
        id: 'getters',
        label: '$(symbol-property) Generate getters/setters',
        description: `For ${structure.containerName}`,
      });
    }

    // Add "simplify" for longer selections
    if (lineCount >= 5) {
      items.splice(2, 0, {
        id: 'simplify',
        label: '$(fold) Simplify',
        description: 'Reduce complexity',
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `LLM Copilot — ${lineCount} line${lineCount > 1 ? 's' : ''} selected (${lang})`,
      matchOnDescription: true,
    });

    if (!picked) { return; }

    await this.executeAction(picked.id, editor, sel, selectedText, lang, structure);
  }

  private async executeAction(
    id: string,
    editor: vscode.TextEditor,
    sel: vscode.Selection,
    code: string,
    lang: string,
    structure: ReturnType<typeof analyseStructure>
  ) {
    const cleanCode = (r: string) =>
      r.replace(/^```[\w]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();

    const applyOrChat = async (result: string, label: string) => {
      const choice = await vscode.window.showInformationMessage(
        `${label} ready — apply to selection?`,
        'Apply', 'Show in Chat', 'Cancel'
      );
      if (choice === 'Apply') {
        await editor.edit(eb => eb.replace(sel, cleanCode(result)));
      } else if (choice === 'Show in Chat') {
        this.chatProvider.show();
        this.chatProvider.sendMessage(
          `${label}:\n\`\`\`${lang}\n${cleanCode(result)}\n\`\`\``
        );
      }
    };

    try {
      switch (id) {
        case 'explain': {
          this.statusBar.setLoading('Explaining…');
          const r = await chat(buildExplainPrompt(code, lang));
          this.statusBar.setIdle();
          this.chatProvider.show();
          this.chatProvider.sendMessage(
            `**Explain:**\n\`\`\`${lang}\n${code}\n\`\`\`\n\n${r}`
          );
          break;
        }

        case 'fix': {
          this.statusBar.setLoading('Finding bugs…');
          const r = await chat(buildFixPrompt(code, lang));
          this.statusBar.setIdle();
          await applyOrChat(r, 'Fixed code');
          break;
        }

        case 'simplify': {
          this.statusBar.setLoading('Simplifying…');
          const msgs = buildRefactorPrompt(code, lang, 'Simplify this code — reduce complexity and improve readability without changing behaviour');
          const r = await chat(msgs);
          this.statusBar.setIdle();
          await applyOrChat(r, 'Simplified code');
          break;
        }

        case 'refactor': {
          const instruction = await vscode.window.showInputBox({
            prompt: 'Refactor instruction',
            placeHolder: 'e.g. extract to function, add error handling…',
            ignoreFocusOut: true,
          });
          if (!instruction?.trim()) { return; }
          this.statusBar.setLoading('Refactoring…');
          const r = await chat(buildRefactorPrompt(code, lang, instruction));
          this.statusBar.setIdle();
          await applyOrChat(r, `Refactored "${instruction.slice(0, 30)}"`);
          break;
        }

        case 'tests': {
          const fw = await vscode.window.showInputBox({
            prompt: 'Testing framework? (leave blank for auto)',
            placeHolder: 'jest, pytest, JUnit, go test…',
            ignoreFocusOut: true,
          });
          this.statusBar.setLoading('Generating tests…');
          const r = await chat(buildTestPrompt(code, lang, fw || undefined));
          this.statusBar.setIdle();
          const choice = await vscode.window.showInformationMessage(
            'Tests ready', 'Insert Below', 'New File', 'Show in Chat', 'Cancel'
          );
          if (choice === 'Insert Below') {
            const insertLine = Math.min(sel.end.line + 1, editor.document.lineCount);
            await editor.edit(eb =>
              eb.insert(new vscode.Position(insertLine, 0), '\n' + cleanCode(r) + '\n')
            );
          } else if (choice === 'New File') {
            const doc = await vscode.workspace.openTextDocument({ content: cleanCode(r), language: lang });
            await vscode.window.showTextDocument(doc);
          } else if (choice === 'Show in Chat') {
            this.chatProvider.show();
            this.chatProvider.sendMessage(`Tests:\n\`\`\`${lang}\n${cleanCode(r)}\n\`\`\``);
          }
          break;
        }

        case 'docstring': {
          this.statusBar.setLoading('Generating doc comment…');
          const r = await chat(buildDocstringPrompt(code, lang));
          this.statusBar.setIdle();
          const comment = cleanCode(r);
          const insertPos = new vscode.Position(sel.start.line, 0);
          await editor.edit(eb => eb.insert(insertPos, comment + '\n'));
          break;
        }

        case 'constructor': {
          this.statusBar.setLoading(`Generating constructor for ${structure.containerName}…`);
          const r = await chat(buildImplementationPrompt(code, lang, 'constructor'));
          this.statusBar.setIdle();
          await applyOrChat(r, 'Constructor');
          break;
        }

        case 'getters': {
          this.statusBar.setLoading(`Generating getters/setters for ${structure.containerName}…`);
          const r = await chat(buildImplementationPrompt(code, lang, 'getters-setters'));
          this.statusBar.setIdle();
          await applyOrChat(r, 'Getters/setters');
          break;
        }

        case 'chat': {
          const question = await vscode.window.showInputBox({
            prompt: 'Ask about this code',
            placeHolder: 'What would you like to know?',
            ignoreFocusOut: true,
          });
          if (!question?.trim()) { return; }
          this.chatProvider.show();
          this.chatProvider.sendMessage(
            `${question}\n\n\`\`\`${lang}\n${code}\n\`\`\``
          );
          break;
        }
      }
    } catch (err: any) {
      this.statusBar.setError('Error');
      vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`);
    }
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
