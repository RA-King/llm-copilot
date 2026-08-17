import {
  stripArtefacts,
  detectIndentStyle,
  getBaseIndent,
  detectBlankLineContext,
  formatCompletion,
  IndentStyle,
} from '../src/formatter';
import { makeDocument, makeEditor, pos } from './helpers';

describe('stripArtefacts', () => {
  it('removes a fenced code block with a language tag', () => {
    expect(stripArtefacts('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('removes a fenced code block without a language tag', () => {
    expect(stripArtefacts('```\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('strips a conversational preamble', () => {
    expect(stripArtefacts("Here's the completion:\nconst a = 1;")).toBe('const a = 1;');
    expect(stripArtefacts('Completion:\nreturn 1;')).toBe('return 1;');
  });

  it('strips trailing commentary lines', () => {
    expect(stripArtefacts('const a = 1;\n// Note: this is a note')).toBe('const a = 1;');
  });

  it('leaves clean code untouched', () => {
    expect(stripArtefacts('const a = 1;')).toBe('const a = 1;');
  });
});

describe('detectIndentStyle', () => {
  it('detects 4-space indentation from document content', () => {
    const doc = makeDocument(
      ['function f() {', '    const a = 1;', '    const b = 2;', '    const c = 3;', '}'].join('\n')
    );
    const style = detectIndentStyle(doc as any, makeEditor() as any);
    expect(style.useTabs).toBe(false);
    expect(style.tabSize).toBe(4);
    expect(style.unit).toBe('    ');
  });

  it('detects tab indentation when tabs dominate', () => {
    const doc = makeDocument(['function f() {', '\tconst a = 1;', '\tconst b = 2;', '}'].join('\n'));
    const style = detectIndentStyle(doc as any, makeEditor() as any);
    expect(style.useTabs).toBe(true);
    expect(style.unit).toBe('\t');
  });

  it('honours the editor insertSpaces=false override', () => {
    const doc = makeDocument(['function f() {', '  a;', '  b;', '  c;', '}'].join('\n'));
    const style = detectIndentStyle(doc as any, makeEditor({ insertSpaces: false }) as any);
    expect(style.useTabs).toBe(true);
  });
});

describe('getBaseIndent', () => {
  it('returns the indentation of the cursor line', () => {
    const doc = makeDocument(['class C {', '    field = 1;'].join('\n'));
    expect(getBaseIndent(doc as any, pos(1, 10))).toBe('    ');
  });

  it('walks up to the previous non-blank line when the cursor line is blank', () => {
    const doc = makeDocument(['  const x = 1;', '', ''].join('\n'));
    expect(getBaseIndent(doc as any, pos(2, 0))).toBe('  ');
  });

  it('returns empty string at top of file with no indentation', () => {
    const doc = makeDocument('const x = 1;');
    expect(getBaseIndent(doc as any, pos(0, 0))).toBe('');
  });
});

describe('detectBlankLineContext', () => {
  it('reports a blank line immediately before the cursor', () => {
    const doc = makeDocument(['const a = 1;', '', 'const b = 2;'].join('\n'));
    const ctx = detectBlankLineContext(doc as any, pos(2, 0));
    expect(ctx.blankBefore).toBe(true);
    expect(ctx.blankAfter).toBe(false);
  });

  it('reports a blank line immediately after the cursor', () => {
    const doc = makeDocument(['const a = 1;', '', 'const b = 2;'].join('\n'));
    const ctx = detectBlankLineContext(doc as any, pos(0, 0));
    expect(ctx.blankAfter).toBe(true);
    expect(ctx.blankBefore).toBe(false);
  });
});

describe('formatCompletion', () => {
  const style: IndentStyle = { useTabs: false, tabSize: 2, unit: '  ' };

  it('strips fences and re-indents relative lines against the base indent', () => {
    const doc = makeDocument('  const base = 1;');
    const raw = '```ts\nif (x) {\n  doThing();\n}\n```';
    const result = formatCompletion(raw, doc as any, pos(0, 17), style);
    expect(result).toBe('if (x) {\n    doThing();\n  }');
  });

  it('returns an empty string for artefact-only input', () => {
    const doc = makeDocument('const x = 1;');
    expect(formatCompletion('```\n```', doc as any, pos(0, 0), style)).toBe('');
  });

  it('keeps the first line flush (no base indent added to it)', () => {
    const doc = makeDocument('    const base = 1;');
    const result = formatCompletion('return 42;', doc as any, pos(0, 4), style);
    expect(result).toBe('return 42;');
  });
});
