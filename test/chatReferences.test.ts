import { parseChatInput, renderAttachments, searchTerms } from '../src/chatReferences';

describe('parseChatInput', () => {
  it('reads a leading slash command', () => {
    const parsed = parseChatInput('/Fix the null check');
    expect(parsed.command).toBe('fix');
    expect(parsed.text).toBe('the null check');
  });

  it('leaves a slash later in the message alone', () => {
    expect(parseChatInput('what does a/b mean').command).toBeUndefined();
  });

  it('pulls out file references, keeping the path in the sentence', () => {
    const parsed = parseChatInput('compare #file:src/a.ts with #file:"docs/my notes.md".');
    expect(parsed.references).toEqual([
      { kind: 'file', arg: 'src/a.ts' },
      { kind: 'file', arg: 'docs/my notes.md' },
    ]);
    expect(parsed.text).toBe('compare src/a.ts with docs/my notes.md.');
  });

  it('reads the named references and drops them from the text', () => {
    const parsed = parseChatInput('#codebase where is retry handled? #problems #terminal');
    expect(parsed.references.map(r => r.kind)).toEqual(['codebase', 'problems', 'terminalLastCommand']);
    expect(parsed.text).toBe('where is retry handled?');
  });

  it('ignores unknown hashes and repeats', () => {
    const parsed = parseChatInput('issue #42 #changes #changes');
    expect(parsed.references).toEqual([{ kind: 'changes' }]);
    expect(parsed.text).toBe('issue #42');
  });
});

describe('renderAttachments', () => {
  it('fences code and leaves prose bare', () => {
    const out = renderAttachments([
      { label: 'File — a.ts', language: 'typescript', content: 'const a = 1;\n\n' },
      { label: 'Codebase', language: '', content: 'src/a.ts' },
      { label: 'Empty', language: 'text', content: '  ' },
    ]);
    expect(out).toBe('### File — a.ts\n```typescript\nconst a = 1;\n```\n\n### Codebase\nsrc/a.ts');
  });
});

describe('searchTerms', () => {
  it('keeps identifiers and splits compound names', () => {
    const terms = searchTerms('where is the RetryPolicy and max_attempts used?');
    expect(terms).toEqual(expect.arrayContaining(['RetryPolicy', 'retry', 'policy', 'max_attempts', 'attempts']));
    expect(terms).not.toContain('where');
    expect(terms).not.toContain('used');
  });
});
