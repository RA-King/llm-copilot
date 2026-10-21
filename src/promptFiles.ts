import * as vscode from 'vscode';
import { parseFrontMatter } from './customInstructions';

/**
 * Reusable prompts kept in the repository as `.github/prompts/<name>.prompt.md`,
 * the layout GitHub Copilot uses. Each one becomes a slash command in the chat
 * panel: `/<name> anything else` sends the file's body with its variables
 * filled in.
 *
 * Variables follow Copilot's spelling:
 *   ${selection} ${selectedText}   the editor selection
 *   ${file} ${fileBasename}        the active file, relative path / name
 *   ${fileDirname}                 its directory
 *   ${workspaceFolder}             the first workspace folder's path
 *   ${input:name} ${input:name:hint}
 *                                  whatever was typed after the command
 */

export interface PromptFile {
  name: string;
  description: string;
  body: string;
  source: string;
}

export interface PromptVariables {
  selection: string;
  file: string;
  workspaceFolder: string;
  input: string;
}

export function parsePromptFile(fileName: string, text: string, source = fileName): PromptFile {
  const { fields, body } = parseFrontMatter(text);
  const name = fileName.replace(/^.*[\\/]/, '').replace(/\.prompt\.md$/i, '').replace(/\.md$/i, '');
  return {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    description: fields['description'] ?? firstLine(body),
    body,
    source,
  };
}

function firstLine(body: string): string {
  const line = body.split('\n').find(l => l.trim())?.trim() ?? '';
  return line.replace(/^#+\s*/, '').slice(0, 80);
}

export function expandPromptVariables(body: string, vars: PromptVariables): string {
  const file = vars.file.replace(/\\/g, '/');
  const slash = file.lastIndexOf('/');
  const values: Record<string, string> = {
    selection: vars.selection,
    selectedText: vars.selection,
    file,
    fileBasename: slash >= 0 ? file.slice(slash + 1) : file,
    fileDirname: slash >= 0 ? file.slice(0, slash) : '.',
    workspaceFolder: vars.workspaceFolder,
  };

  let usedInput = false;
  const expanded = body.replace(/\$\{(input:[^}]*|\w+)\}/g, (whole, key: string) => {
    if (key.startsWith('input:')) {
      usedInput = true;
      return vars.input || key.split(':')[2] || '';
    }
    return key in values ? values[key] : whole;
  });

  // Text typed after the command still matters when the prompt has nowhere
  // to put it; it reads as a further instruction.
  return !usedInput && vars.input.trim() ? `${expanded}\n\n${vars.input.trim()}` : expanded;
}

export async function loadPromptFiles(): Promise<PromptFile[]> {
  const found = new Map<string, PromptFile>();
  try {
    const uris = await vscode.workspace.findFiles('.github/prompts/**/*.prompt.md', undefined, 100);
    for (const uri of uris) {
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const prompt = parsePromptFile(uri.path, text, vscode.workspace.asRelativePath(uri, false));
        if (prompt.body && !found.has(prompt.name)) { found.set(prompt.name, prompt); }
      } catch { /* unreadable file, skip it */ }
    }
  } catch { /* no workspace */ }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
