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
