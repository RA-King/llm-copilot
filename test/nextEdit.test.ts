import { buildNextEditPrompt, parseNextEdit, locateEdit, revertsLastEdit, trimEdit } from '../src/nextEdit';

describe('buildNextEditPrompt', () => {
  it('carries the recent edits and the numbered window', () => {
    const msgs = buildNextEditPrompt({
      language: 'typescript', file: 'src/a.ts', history: '@@ line 1\n- a\n+ b',
      window: 'const b = 1;\nuse(a);', windowStart: 10, cursorLine: 10,
    });
    expect(msgs[0].content).toContain('<<<<<<< SEARCH');
    expect(msgs[1].content).toContain('@@ line 1\n- a\n+ b');
    expect(msgs[1].content).toContain('11 | use(a);');
  });
});

describe('parseNextEdit', () => {
  it('reads a search/replace block', () => {
    expect(parseNextEdit('Sure.\n<<<<<<< SEARCH\nuse(a);\n=======\nuse(b);\n>>>>>>> REPLACE\n')).toEqual({
      search: 'use(a);', replace: 'use(b);',
    });
  });

  it('allows an empty replacement, which deletes', () => {
    expect(parseNextEdit('<<<<<<< SEARCH\nimport x;\n=======\n>>>>>>> REPLACE')).toEqual({ search: 'import x;', replace: '' });
  });

  it('strips line numbers quoted back from the prompt', () => {
    expect(parseNextEdit('<<<<<<< SEARCH\n11 | use(a);\n=======\n11 | use(b);\n>>>>>>> REPLACE')?.search).toBe('use(a);');
  });

  it('reads NONE, no-ops and noise as nothing', () => {
    expect(parseNextEdit('NONE')).toBeUndefined();
    expect(parseNextEdit('<<<<<<< SEARCH\nx\n=======\nx\n>>>>>>> REPLACE')).toBeUndefined();
    expect(parseNextEdit('use(b);')).toBeUndefined();
  });
});

describe('locateEdit', () => {
  const text = 'use(a);\nfoo();\nuse(a);\n';

  it('picks the occurrence nearest the cursor', () => {
    expect(locateEdit(text, { search: 'use(a);', replace: 'use(b);' }, text.length)?.start).toBe(15);
    expect(locateEdit(text, { search: 'use(a);', replace: 'use(b);' }, 0)?.start).toBe(0);
  });

  it('tolerates trailing whitespace the model dropped', () => {
    const located = locateEdit('a = 1;   \nb = 2;\n', { search: 'a = 1;\nb = 2;', replace: 'x' }, 0);
    expect(located).toEqual({ start: 0, end: 16, replace: 'x' });
  });

  it('finds nothing for text that is not there', () => {
    expect(locateEdit(text, { search: 'nope', replace: 'x' }, 0)).toBeUndefined();
  });
});

describe('revertsLastEdit', () => {
  const last = { startLine: 0, before: ['load(user)'], after: ['load(account)'] };

  it('catches a suggestion that undoes the last edit', () => {
    expect(revertsLastEdit({ search: 'load(account)', replace: 'load(user)' }, last)).toBe(true);
  });

  it('lets a follow-up edit through', () => {
    expect(revertsLastEdit({ search: 'save(user)', replace: 'save(account)' }, last)).toBe(false);
    expect(revertsLastEdit({ search: 'x', replace: 'y' }, undefined)).toBe(false);
  });
});

describe('trimEdit', () => {
  it('narrows the edit to the characters that change', () => {
    const text = 'save(user);';
    expect(trimEdit(text, { start: 0, end: text.length, replace: 'save(account);' }))
      .toEqual({ start: 5, end: 9, replace: 'account' });
  });
});
