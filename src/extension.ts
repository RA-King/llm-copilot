import * as vscode from 'vscode';
import { LLMInlineCompletionProvider, CompletionDebouncer } from './completionProvider';
import { ChatViewProvider } from './chatViewProvider';
import { StatusBarManager } from './statusBar';
import {
  testConnection, chat, listClaudeCodeModels, diagnoseClaudeCode,
  buildExplainPrompt, buildFixPrompt, buildDocstringPrompt,
  buildRefactorPrompt, buildImplementationPrompt, buildTestPrompt,
  buildInlineChatPrompt, buildCommitMessagePrompt,
} from './llmProvider';
import { DocTriggerWatcher, detectDeclaration, buildSmartDocPrompt, formatDocComment, getCommentStyleForLang } from './docTrigger';
import { analyseStructure } from './structureAnalyzer';
import { SelectionActionProvider } from './selectionActions';
import { extractMethodSignatures, buildSingleMethodImplPrompt } from './interfaceHelpers';

let statusBar: StatusBarManager;
let completionProvider: LLMInlineCompletionProvider;
let outputChannel: vscode.OutputChannel;


export function activate(context: vscode.ExtensionContext) {
  console.log('[LLM Copilot] Activating...');

  outputChannel = vscode.window.createOutputChannel('LLM Copilot');
  statusBar = new StatusBarManager();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });
  context.subscriptions.push(outputChannel);

  completionProvider = new LLMInlineCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider)
  );

  const debouncer = new CompletionDebouncer();
  context.subscriptions.push({ dispose: () => debouncer.dispose() });

  const docTrigger = new DocTriggerWatcher(statusBar);
  context.subscriptions.push({ dispose: () => docTrigger.dispose() });

  const chatProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Selection context action provider — triggered by Ctrl+Space when code is selected
  const selectionActions = new SelectionActionProvider(chatProvider, statusBar);
  context.subscriptions.push({ dispose: () => selectionActions.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.showSelectionActions', () =>
      selectionActions.triggerForActiveSelection()
    )
  );

  // ─── Helper ───────────────────────────────────────────────────────────────

  function getEditor() { return vscode.window.activeTextEditor; }

  function getSelectedCode(editor: vscode.TextEditor): string {
    return editor.document.getText(editor.selection);
  }

  function getSurroundingContext(editor: vscode.TextEditor, lines = 30): string {
    const pos = editor.selection.active;
    const start = Math.max(0, pos.line - lines);
    return editor.document.getText(new vscode.Range(start, 0, pos.line, pos.character));
  }

  function cleanCode(response: string): string {
    return response.replace(/^```[\w]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();
  }

  // ─── Inline Chat (Ctrl+I) ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.inlineChat', async () => {
      const editor = getEditor();
      if (!editor) { return; }

      const selected = getSelectedCode(editor);
      const surrounding = getSurroundingContext(editor);
      const lang = editor.document.languageId;

      const instruction = await vscode.window.showInputBox({
        prompt: 'Ask LLM Copilot (inline)',
        placeHolder: 'e.g. add error handling, explain this, convert to async…',
        ignoreFocusOut: true,
      });
      if (!instruction?.trim()) { return; }

      statusBar.setLoading('Thinking...');
      try {
        const messages = buildInlineChatPrompt(instruction, selected || null, surrounding, lang);
        const response = await chat(messages);
        statusBar.setIdle();

        const cleaned = cleanCode(response);

        if (selected) {
          const choice = await vscode.window.showInformationMessage(
            `Inline response ready — apply to selection?`,
            'Apply', 'Show in Chat', 'Cancel'
          );
          if (choice === 'Apply') {
            await editor.edit(eb => eb.replace(editor.selection, cleaned));
          } else if (choice === 'Show in Chat') {
            chatProvider.show();
            await vscode.commands.executeCommand('llmCopilot.chatView.focus');
            chatProvider.sendMessage(`${instruction}\n\`\`\`${lang}\n${cleaned}\n\`\`\``);
          }
        } else {
          // No selection — show in chat
          chatProvider.show();
          await vscode.commands.executeCommand('llmCopilot.chatView.focus');
          chatProvider.sendMessage(`${instruction}\n\n${response}`);
        }
      } catch (err: any) {
        statusBar.setError('Error');
        vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`);
      }
    })
  );

  // ─── Generate Constructor ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.generateConstructor', async () => {
      const editor = getEditor();
      if (!editor) { return; }
      const pos = editor.selection.active;
      const structure = analyseStructure(editor.document, pos);

      if (structure.structureKind !== 'class-body' && structure.structureKind !== 'impl-body') {
        vscode.window.showWarningMessage('LLM Copilot: Place cursor inside a class or struct body.');
        return;
      }

      statusBar.setLoading(`Generating constructor for ${structure.containerName}…`);
      try {
        const msgs = buildImplementationPrompt(structure.surroundingContext, editor.document.languageId, 'constructor');
        const response = await chat(msgs);
        statusBar.setIdle();
        const code = cleanCode(response);
        await editor.edit(eb => eb.insert(pos, '\n' + code + '\n'));
        vscode.window.showInformationMessage(`✅ Constructor generated for ${structure.containerName}`);
      } catch (err: any) { statusBar.setError('Error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
    })
  );

  // ─── Generate Getters/Setters ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.generateGettersSetters', async () => {
      const editor = getEditor();
      if (!editor) { return; }

      const pos = editor.selection.active;
      const structure = analyseStructure(editor.document, pos);

      if (structure.structureKind !== 'class-body' && structure.structureKind !== 'impl-body') {
        vscode.window.showWarningMessage('LLM Copilot: Place cursor inside a class or struct body.');
        return;
      }

      // Find all fields that still need accessors
      const fieldsNeedingAccessors = structure.fields.filter(f => !f.hasGetter && !f.hasSetter);

      if (fieldsNeedingAccessors.length === 0) {
        vscode.window.showInformationMessage(`LLM Copilot: All fields in "${structure.containerName}" already have accessors.`);
        return;
      }

      const lang = editor.document.languageId;
      let insertPos = editor.selection.active;
      let generated = 0;

      // Generate ONE accessor pair at a time, ask to continue after each
      for (const field of fieldsNeedingAccessors) {
        statusBar.setLoading(`Generating getter/setter for "${field.name}" (${generated + 1}/${fieldsNeedingAccessors.length})…`);
        try {
          const msgs = buildImplementationPrompt(
            structure.surroundingContext, lang, 'getters-setters',
            undefined, field   // ← single field target
          );
          const response = await chat(msgs);
          statusBar.setIdle();
          const code = cleanCode(response);

          // Insert after current position
          await editor.edit(eb => {
            eb.insert(insertPos, '\n' + code + '\n');
          });
          generated++;

          // Advance insert position — re-read document state after edit
          const insertedLines = code.split('\n').length + 1;
          const newLine = insertPos.line + insertedLines;
          const docLineCount = editor.document.lineCount;
          insertPos = new vscode.Position(Math.min(newLine, docLineCount - 1), 0);

          // If more fields remain, ask whether to continue
          if (generated < fieldsNeedingAccessors.length) {
            const remaining = fieldsNeedingAccessors.length - generated;
            const next = fieldsNeedingAccessors[generated];
            const choice = await vscode.window.showInformationMessage(
              `✅ getter/setter for "${field.name}" inserted. Generate next field "${next.name}"? (${remaining} remaining)`,
              'Yes, next field', 'Stop here'
            );
            if (choice !== 'Yes, next field') { break; }
          }
        } catch (err: any) {
          statusBar.setError('Error');
          vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`);
          break;
        }
      }

      if (generated > 0) {
        vscode.window.showInformationMessage(
          `✅ Generated accessors for ${generated} field${generated > 1 ? 's' : ''} in "${structure.containerName}".`
        );
      }
    })
  );

  // ─── Implement Interface / Abstract Methods (one method at a time) ────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.implementInterface', async () => {
      const editor = getEditor();
      if (!editor) { return; }
      const selected = getSelectedCode(editor);
      const pos = editor.selection.active;
      const structure = analyseStructure(editor.document, pos);
      const lang = editor.document.languageId;

      // Get the interface code — from selection or user input
      let interfaceCode = selected || undefined;
      if (!interfaceCode) {
        interfaceCode = await vscode.window.showInputBox({
          prompt: 'Paste the interface/abstract class declaration (or select it in the editor first)',
          placeHolder: 'interface MyInterface { methodA(): void; methodB(x: number): string; }',
          ignoreFocusOut: true,
        }) || undefined;
      }
      if (!interfaceCode?.trim()) { return; }

      // Extract individual method signatures from the interface
      const methodSigs = extractMethodSignatures(interfaceCode, lang);

      if (methodSigs.length === 0) {
        // Fallback: implement all at once if we cannot parse individual signatures
        statusBar.setLoading(`Implementing interface for ${structure.containerName}…`);
        try {
          const msgs = buildImplementationPrompt(structure.surroundingContext, lang, 'interface-impl', interfaceCode);
          const response = await chat(msgs);
          statusBar.setIdle();
          await editor.edit(eb => eb.insert(pos, '\n' + cleanCode(response) + '\n'));
          vscode.window.showInformationMessage('✅ Interface implementation generated');
        } catch (err: any) { statusBar.setError('Error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
        return;
      }

      let insertPos = pos;
      let generated = 0;

      for (const sig of methodSigs) {
        statusBar.setLoading(`Implementing "${sig.name}" (${generated + 1}/${methodSigs.length})…`);
        try {
          // Build a targeted prompt for a single method
          const singleMethodPrompt = buildSingleMethodImplPrompt(
            sig.signature, structure.surroundingContext, lang
          );
          const response = await chat(singleMethodPrompt);
          statusBar.setIdle();
          const code = cleanCode(response);

          await editor.edit(eb => {
            eb.insert(insertPos, '\n' + code + '\n');
          });
          generated++;

          const insertedLines = code.split('\n').length + 1;
          insertPos = new vscode.Position(insertPos.line + insertedLines, 0);

          if (generated < methodSigs.length) {
            const remaining = methodSigs.length - generated;
            const next = methodSigs[generated];
            const choice = await vscode.window.showInformationMessage(
              `✅ "${sig.name}" implemented. Implement "${next.name}" next? (${remaining} remaining)`,
              'Yes, next method', 'Stop here'
            );
            if (choice !== 'Yes, next method') { break; }
          }
        } catch (err: any) {
          statusBar.setError('Error');
          vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`);
          break;
        }
      }

      if (generated > 0) {
        vscode.window.showInformationMessage(
          `✅ Implemented ${generated} method${generated > 1 ? 's' : ''} in "${structure.containerName}".`
        );
      }
    })
  );

  // ─── Generate All Members (full scaffold) ────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.generateAllMembers', async () => {
      const editor = getEditor();
      if (!editor) { return; }
      const pos = editor.selection.active;
      const structure = analyseStructure(editor.document, pos);

      if (!['class-body','impl-body','interface-body'].includes(structure.structureKind)) {
        vscode.window.showWarningMessage('LLM Copilot: Place cursor inside a class, struct, or interface body.');
        return;
      }

      const what = structure.structureKind === 'interface-body' ? 'interface members' : 'all class members (constructor, getters/setters, utility methods)';
      statusBar.setLoading(`Generating ${what}…`);
      try {
        const kind = structure.structureKind === 'interface-body' ? 'interface-impl' : 'all-members';
        const msgs = buildImplementationPrompt(structure.surroundingContext, editor.document.languageId, kind as any);
        const response = await chat(msgs);
        statusBar.setIdle();
        await editor.edit(eb => eb.insert(pos, '\n' + cleanCode(response) + '\n'));
        vscode.window.showInformationMessage(`✅ Members generated for ${structure.containerName}`);
      } catch (err: any) { statusBar.setError('Error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
    })
  );

  // ─── Generate Tests ───────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.generateTests', async () => {
      const editor = getEditor();
      if (!editor) { return; }
      const selected = getSelectedCode(editor);
      if (!selected.trim()) {
        vscode.window.showWarningMessage('LLM Copilot: Select the code you want tests for.');
        return;
      }

      const framework = await vscode.window.showInputBox({
        prompt: 'Testing framework? (leave blank for auto-detect)',
        placeHolder: 'jest, pytest, JUnit, xUnit, go test…',
        ignoreFocusOut: true,
      });

      statusBar.setLoading('Generating tests…');
      try {
        const msgs = buildTestPrompt(selected, editor.document.languageId, framework || undefined);
        const response = await chat(msgs);
        statusBar.setIdle();
        const tests = cleanCode(response);

        const choice = await vscode.window.showInformationMessage(
          'Tests ready — where to put them?', 'Insert Below', 'New File', 'Show in Chat', 'Cancel'
        );
        if (choice === 'Insert Below') {
          const endPos = editor.selection.end;
          const safeInsertLine = Math.min(endPos.line + 1, editor.document.lineCount);
          await editor.edit(eb => eb.insert(new vscode.Position(safeInsertLine, 0), '\n' + tests + '\n'));
        } else if (choice === 'New File') {
          const doc = await vscode.workspace.openTextDocument({ content: tests, language: editor.document.languageId });
          await vscode.window.showTextDocument(doc);
        } else if (choice === 'Show in Chat') {
          chatProvider.show();
          await vscode.commands.executeCommand('llmCopilot.chatView.focus');
          chatProvider.sendMessage(`Generated tests:\n\`\`\`${editor.document.languageId}\n${tests}\n\`\`\``);
        }
      } catch (err: any) { statusBar.setError('Error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
    })
  );

  // ─── Generate Commit Message ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.generateCommitMessage', async () => {
      // Get git diff from source control
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      const api = gitExtension?.getAPI(1);
      const repo = api?.repositories?.[0];

      let diff = '';
      if (repo) {
        try {
          diff = await repo.diff(true); // staged diff
          if (!diff) { diff = await repo.diff(); } // unstaged diff
        } catch { diff = ''; }
      }

      if (!diff) {
        // Fall back to asking user to paste diff
        const pasted = await vscode.window.showInputBox({
          prompt: 'Paste your git diff (or open a Git repository for auto-detection)',
          placeHolder: 'diff --git a/file.ts b/file.ts…',
          ignoreFocusOut: true,
        });
        if (!pasted?.trim()) { return; }
        diff = pasted;
      }

      statusBar.setLoading('Generating commit message…');
      try {
        const msgs = buildCommitMessagePrompt(diff);
        const response = await chat(msgs);
        statusBar.setIdle();
        const msg = response.trim();

        // Put it in the clipboard and show it
        await vscode.env.clipboard.writeText(msg);
        const choice = await vscode.window.showInformationMessage(
          `Commit message: "${msg.slice(0, 60)}…" (copied to clipboard)`,
          'Use in SCM', 'OK'
        );
        if (choice === 'Use in SCM' && repo) {
          repo.inputBox.value = msg;
          await vscode.commands.executeCommand('workbench.view.scm');
        }
      } catch (err: any) { statusBar.setError('Error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
    })
  );

  // ─── Explain Code ─────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.explainCode', async () => {
      const editor = getEditor();
      if (!editor) { return; }
      const code = getSelectedCode(editor);
      if (!code.trim()) { vscode.window.showWarningMessage('Select code to explain.'); return; }
      statusBar.setLoading('Explaining…');
      try {
        const msgs = buildExplainPrompt(code, editor.document.languageId);
        const response = await chat(msgs);
        statusBar.setIdle();
        chatProvider.show();
        await vscode.commands.executeCommand('llmCopilot.chatView.focus');
        chatProvider.sendMessage(`**Explain:**\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\`\n\n${response}`);
      } catch (err: any) { statusBar.setError('Error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
    })
  );

  // ─── Fix Code ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.fixCode', async () => {
      const editor = getEditor();
      if (!editor) { return; }
      const code = getSelectedCode(editor);
      if (!code.trim()) { vscode.window.showWarningMessage('Select code to fix.'); return; }
      statusBar.setLoading('Fixing…');
      try {
        const msgs = buildFixPrompt(code, editor.document.languageId);
        const response = await chat(msgs);
        statusBar.setIdle();
        const fixed = cleanCode(response);
        const choice = await vscode.window.showInformationMessage('Fixed code ready.', 'Replace', 'Show in Chat', 'Cancel');
        if (choice === 'Replace') {
          await editor.edit(eb => eb.replace(editor.selection, fixed));
        } else if (choice === 'Show in Chat') {
          chatProvider.show();
          await vscode.commands.executeCommand('llmCopilot.chatView.focus');
          chatProvider.sendMessage(`Fixed code:\n\`\`\`${editor.document.languageId}\n${fixed}\n\`\`\``);
        }
      } catch (err: any) { statusBar.setError('Error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
    })
  );

  // ─── Refactor Code ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.refactorCode', async () => {
      const editor = getEditor();
      if (!editor) { return; }
      const code = getSelectedCode(editor);
      if (!code.trim()) { vscode.window.showWarningMessage('Select code to refactor.'); return; }
      const instruction = await vscode.window.showInputBox({
        prompt: `Refactor instruction for ${editor.document.languageId} code`,
        placeHolder: 'e.g. extract to function, add error handling, simplify…',
        ignoreFocusOut: true,
      });
      if (!instruction?.trim()) { return; }
      statusBar.setLoading('Refactoring…');
      try {
        const msgs = buildRefactorPrompt(code, editor.document.languageId, instruction);
        const response = await chat(msgs);
        statusBar.setIdle();
        const refactored = cleanCode(response);
        if (!refactored) { vscode.window.showWarningMessage('No output returned.'); return; }
        const label = instruction.length > 40 ? instruction.slice(0, 40) + '…' : instruction;
        const choice = await vscode.window.showInformationMessage(`Refactor: "${label}" ready`, 'Apply', 'Preview in Chat', 'Cancel');
        if (choice === 'Apply') {
          await editor.edit(eb => eb.replace(editor.selection, refactored));
          vscode.window.showInformationMessage('✅ Refactoring applied.');
        } else if (choice === 'Preview in Chat') {
          chatProvider.show();
          await vscode.commands.executeCommand('llmCopilot.chatView.focus');
          chatProvider.sendMessage(`Refactored "${instruction}":\n\`\`\`${editor.document.languageId}\n${refactored}\n\`\`\``);
        }
      } catch (err: any) { statusBar.setError('Refactor error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
    })
  );

  // ─── Generate Docstring ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.generateDocstring', async () => {
      const editor = getEditor();
      if (!editor) { return; }
      const position = editor.selection.active;
      const doc = editor.document;
      let declLine: number | null = null;
      for (let i = position.line; i < Math.min(position.line + 3, doc.lineCount); i++) {
        const t = doc.lineAt(i).text.trim();
        if (t && !/^\/\/|^\/\*|^#|^\*/.test(t)) { declLine = i; break; }
      }
      if (declLine === null) { declLine = position.line; }
      const decl = detectDeclaration(doc, declLine);
      if (!decl) { vscode.window.showWarningMessage('Could not detect a declaration at cursor.'); return; }
      statusBar.setLoading(`Documenting ${decl.kind} "${decl.name}"…`);
      try {
        const msgs = buildSmartDocPrompt(decl);
        const response = await chat(msgs);
        statusBar.setIdle();
        const formatted = formatDocComment(response, getCommentStyleForLang(decl.language), decl.indentPrefix, decl.kind);
        await editor.edit(eb => eb.insert(new vscode.Position(declLine!, 0), formatted + '\n'));
        vscode.window.showInformationMessage(`✅ Doc comment generated for ${decl.kind} "${decl.name}"`);
      } catch (err: any) { statusBar.setError('Error'); vscode.window.showErrorMessage(`LLM Copilot: ${err.message}`); }
    })
  );

  // ─── Trigger completion / Toggle / Settings / Connection ─────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.triggerCompletion', () =>
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.openChat', async () => {
      chatProvider.show();
      await vscode.commands.executeCommand('llmCopilot.chatView.focus');
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'llmCopilot'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.testConnection', async () => {
      statusBar.setLoading('Testing…');
      const result = await testConnection();
      if (result.success) { statusBar.setSuccess(); vscode.window.showInformationMessage(`✅ ${result.message}`); }
      else { statusBar.setError('Failed'); vscode.window.showErrorMessage(`❌ ${result.message}`); }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('llmCopilot.toggleEnabled', async () => {
      const cfg = vscode.workspace.getConfiguration('llmCopilot');
      const current = cfg.get('enabled', true);
      await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
      statusBar.setIdle(); completionProvider.clearCache();
      vscode.window.showInformationMessage(`LLM Copilot ${!current ? 'enabled' : 'disabled'}`);
    })
  );

  // ─── Workspace file changes ───────────────────────────────────────────────
  // The cross-file caches key on the workspace's file list; adding, deleting or
  // renaming a file makes that list stale.
  context.subscriptions.push(
    vscode.workspace.onDidCreateFiles(() => completionProvider.clearCache()),
    vscode.workspace.onDidDeleteFiles(() => completionProvider.clearCache()),
    vscode.workspace.onDidRenameFiles(() => completionProvider.clearCache()),
  );

  // ─── Config changes ───────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('llmCopilot')) {
        const cfg = vscode.workspace.getConfiguration('llmCopilot');

        // When switching to claudecode, auto-set baseUrl to the dedicated claudeCode URL
        if (e.affectsConfiguration('llmCopilot.provider')) {
          const provider = cfg.get<string>('provider', 'ollama');
          if (provider === 'claudecode') {
            const claudeUrl = cfg.get<string>('claudeCodeBaseUrl', 'http://localhost:3000');
            const currentBase = cfg.get<string>('baseUrl', '');
            if (currentBase !== claudeUrl) {
              await cfg.update('baseUrl', claudeUrl, vscode.ConfigurationTarget.Global);
            }
          } else if (provider === 'ollama') {
            const currentBase = cfg.get<string>('baseUrl', '');
            if (currentBase === 'http://localhost:3000' || currentBase === 'http://localhost:1234') {
              await cfg.update('baseUrl', 'http://localhost:11434', vscode.ConfigurationTarget.Global);
            }
          }
        }

        statusBar.setIdle(); statusBar.updateVisibility();
        completionProvider.clearCache(); // always clear on any config change
      }
    })
  );

  // ─── Welcome ──────────────────────────────────────────────────────────────
  if (!context.globalState.get('llmCopilot.welcomeShown', false)) {
    context.globalState.update('llmCopilot.welcomeShown', true);
    vscode.window.showInformationMessage(
      '🤖 LLM Copilot installed! Configure your provider to get started.',
      'Open Settings', 'Test Connection', 'Open Chat'
    ).then(choice => {
      if (choice === 'Open Settings') { vscode.commands.executeCommand('llmCopilot.openSettings'); }
      else if (choice === 'Test Connection') { vscode.commands.executeCommand('llmCopilot.testConnection'); }
      else if (choice === 'Open Chat') { vscode.commands.executeCommand('llmCopilot.openChat'); }
    });
  }

  console.log('[LLM Copilot] Activated.');
}

export function deactivate() { console.log('[LLM Copilot] Deactivated.'); }
