import {
  deduplicateLines,
  isBlockDuplicate,
  stripEchoes,
  guardAgainstDuplication,
} from '../src/duplicationGuard';

describe('deduplicateLines', () => {
  it('returns the completion unchanged when nothing is duplicated', () => {
    const result = deduplicateLines('const total = a + b;', 'function add(a, b) {', '}');
    expect(result).toBe('const total = a + b;');
  });

  it('rejects entirely when more than half the meaningful lines already exist', () => {
    const prefix = 'const x = 1;\nconst y = 2;\nconst z = 3;';
    const completion = 'const x = 1;\nconst y = 2;\nconst brandNew = 4;';
    // 2 of 3 non-trivial lines are duplicates → ratio > 0.5 → reject
    expect(deduplicateLines(completion, prefix, '')).toBeNull();
  });

  it('strips individual duplicate lines while keeping novel ones', () => {
    const prefix = 'const existing = 1;';
    const completion = 'const existing = 1;\nconst freshOne = 2;\nconst freshTwo = 3;';
    const result = deduplicateLines(completion, prefix, '');
    expect(result).toBe('const freshOne = 2;\nconst freshTwo = 3;');
  });

  it('ignores whitespace differences when comparing (normalisation)', () => {
    const prefix = 'const   value    =   1;';
    const completion = 'const value = 1;\nconst other = 2;';
    const result = deduplicateLines(completion, prefix, '');
    expect(result).toBe('const other = 2;');
  });

  it('returns null when the completion has no non-trivial lines', () => {
    expect(deduplicateLines('}\n;\n{', 'x', 'y')).toBeNull();
  });
});

describe('isBlockDuplicate', () => {
  it('detects a full block already present in the prefix', () => {
    const block = 'function greet() {\n  return "hello world";\n}';
    const prefix = `some code\n${block}\nmore code`;
    expect(isBlockDuplicate(block, prefix, '')).toBe(true);
  });

  it('detects a block already present in the suffix', () => {
    const block = 'const configuration = loadSettings();';
    expect(isBlockDuplicate(block, '', `preamble\n${block}`)).toBe(true);
  });

  it('returns false for genuinely new content', () => {
    expect(isBlockDuplicate('const somethingUnique = compute();', 'unrelated prefix', 'unrelated suffix')).toBe(false);
  });

  it('returns false for content too short to be meaningful', () => {
    expect(isBlockDuplicate('x=1', 'x=1', '')).toBe(false);
  });
});

describe('stripEchoes', () => {
  it('strips the echoed keyword from the current-line prefix', () => {
    // The typed text is trimmed to "const" before removal, so the space that
    // separated "const" from the rest inside the completion remains.
    const result = stripEchoes('const total = a + b;', '', 'const ');
    expect(result).toBe(' total = a + b;');
  });

  it('preserves the leading indentation of the completion when stripping the echo', () => {
    const result = stripEchoes('    const total = 1;', '', 'const ');
    expect(result).toBe('     total = 1;');
  });

  it('strips echoed trailing lines of the prefix', () => {
    const prefix = 'line one is here\nline two is here';
    const completion = 'line two is here\nbrand new content line';
    const result = stripEchoes(completion, prefix, '');
    expect(result).toBe('brand new content line');
  });

  it('leaves the completion untouched when there is no echo', () => {
    const result = stripEchoes('return computeResult();', 'function f() {', '');
    expect(result).toBe('return computeResult();');
  });
});

describe('guardAgainstDuplication', () => {
  it('returns null for empty completions', () => {
    expect(guardAgainstDuplication('   ', 'prefix', 'suffix', '')).toBeNull();
  });

  it('returns null when the whole block already exists in the file', () => {
    const block = 'function greet() {\n  return "hello world";\n}';
    expect(guardAgainstDuplication(block, `x\n${block}\n`, '', '')).toBeNull();
  });

  it('strips an echoed prefix and returns the remainder', () => {
    const result = guardAgainstDuplication('const total = a + b;', '', '', 'const ');
    expect(result).toBe('total = a + b;'); // guard trims the final result
  });

  it('passes through genuinely novel completions', () => {
    const result = guardAgainstDuplication(
      'const uniqueResult = doWork();',
      'function work() {',
      '}',
      ''
    );
    expect(result).toBe('const uniqueResult = doWork();');
  });
});
