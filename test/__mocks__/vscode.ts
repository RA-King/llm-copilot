/**
 * Minimal mock of the `vscode` module for unit-testing pure logic that only
 * touches a small subset of the API (Position, Range, workspace.getConfiguration).
 *
 * Jest maps `import ... from 'vscode'` to this file via moduleNameMapper.
 */

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(start: Position, end: Position);
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

// ─── Configuration store ──────────────────────────────────────────────────────
// Tests can seed values with __setConfig() and clear them with __resetConfig().

const configStore: Record<string, Record<string, unknown>> = {};

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(key: string, defaultValue?: T): T {
        const bucket = configStore[section];
        if (bucket && key in bucket) {
          return bucket[key] as T;
        }
        return defaultValue as T;
      },
    };
  },
};

/** Test helper — set config values for a section (merges with existing). */
export function __setConfig(section: string, values: Record<string, unknown>): void {
  configStore[section] = { ...(configStore[section] ?? {}), ...values };
}

/** Test helper — wipe all seeded config. */
export function __resetConfig(): void {
  for (const key of Object.keys(configStore)) {
    delete configStore[key];
  }
}

// ─── Uri ──────────────────────────────────────────────────────────────────────

export class Uri {
  private constructor(public readonly fsPath: string) {}
  static file(p: string): Uri { return new Uri(p); }
  toString(): string { return `file://${this.fsPath}`; }
}

// ─── Command bridge ───────────────────────────────────────────────────────────
// `vscode.commands.executeCommand` is how the extension reaches the language
// server. Tests register handlers per command name to stand in for it.

type CommandHandler = (...args: unknown[]) => unknown;
const commandHandlers = new Map<string, CommandHandler>();

export const commands = {
  async executeCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
    const handler = commandHandlers.get(command);
    if (!handler) { return undefined; }
    return (await handler(...args)) as T;
  },
};

/** Test helper — register a stand-in for one `vscode.execute*Provider` command. */
export function __setCommand(command: string, handler: CommandHandler): void {
  commandHandlers.set(command, handler);
}

/** Test helper — remove all registered command handlers. */
export function __resetCommands(): void {
  commandHandlers.clear();
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }

let diagnostics: unknown[] = [];

export const languages = {
  getDiagnostics(_uri?: unknown): unknown[] { return diagnostics; },
};

/** Test helper — set the diagnostics `languages.getDiagnostics` will return. */
export function __setDiagnostics(items: unknown[]): void { diagnostics = items; }

// `workspace.asRelativePath` is used when naming resolved declaration files.
(workspace as unknown as Record<string, unknown>).asRelativePath =
  (uri: { fsPath?: string; toString(): string }) => uri.fsPath ?? uri.toString();

// `workspace.openTextDocument` is used to read a resolved declaration's file.
let openTextDocumentImpl: (uri: unknown) => unknown = () => { throw new Error('not stubbed'); };
(workspace as unknown as Record<string, unknown>).openTextDocument =
  async (uri: unknown) => openTextDocumentImpl(uri);

/** Test helper — control what `workspace.openTextDocument` returns. */
export function __setOpenTextDocument(fn: (uri: unknown) => unknown): void {
  openTextDocumentImpl = fn;
}
