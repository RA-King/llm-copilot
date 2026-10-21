import { numberLines, annotateDiff, parseReviewFindings } from '../src/codeReview';

describe('numberLines', () => {
  it('numbers from the given line, padded', () => {
    expect(numberLines('a\nb', 9)).toBe(' 9 | a\n10 | b');
  });
});

describe('annotateDiff', () => {
  it('gives every surviving line its new number', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,3 +10,3 @@ function f() {',
      ' keep',
      '-old',
      '+new',
      ' tail',
    ].join('\n');
    expect(annotateDiff(diff)).toBe([
      '=== src/a.ts',
      '   …',
      '   10   keep',
      '      - old',
      '   11 + new',
      '   12   tail',
    ].join('\n'));
  });

  it('leaves out deleted files', () => {
    const diff = 'diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone';
    expect(annotateDiff(diff)).toBe('   …\n      - gone');
  });
});

describe('parseReviewFindings', () => {
  it('reads the requested format and its common variations', () => {
    const findings = parseReviewFindings([
      'src/a.ts:12: error: Promise is not awaited.',
      '- `src/b.py:3: warning: Bare except hides errors.`',
      '40: suggestion: Name this constant.',
      '[src/c.go:7] - info - Consider a context timeout.',
      'Overall the change looks fine.',
    ].join('\n'));
    expect(findings).toEqual([
      { file: 'src/a.ts', line: 12, severity: 'error', message: 'Promise is not awaited.' },
      { file: 'src/b.py', line: 3, severity: 'warning', message: 'Bare except hides errors.' },
      { file: undefined, line: 40, severity: 'info', message: 'Name this constant.' },
      { file: 'src/c.go', line: 7, severity: 'info', message: 'Consider a context timeout.' },
    ]);
  });

  it('finds nothing in NO ISSUES', () => {
    expect(parseReviewFindings('NO ISSUES')).toEqual([]);
  });
});
