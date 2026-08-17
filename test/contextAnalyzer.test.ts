import {
  shouldSuggest,
  isRefactorCandidate,
  analyseCursorContext,
} from '../src/contextAnalyzer';
import { makeDocument, pos } from './helpers';

describe('shouldSuggest', () => {
  it('is true for productive intents', () => {
    expect(shouldSuggest('new-block')).toBe(true);
    expect(shouldSuggest('new-statement')).toBe(true);
    expect(shouldSuggest('completing-started')).toBe(true);
  });

  it('is false for intents where we should stay quiet', () => {
    expect(shouldSuggest('inside-existing')).toBe(false);
    expect(shouldSuggest('ambiguous')).toBe(false);
    expect(shouldSuggest('refactor-candidate')).toBe(false);
  });
});

describe('isRefactorCandidate', () => {
  it('is true for refactor-candidate and inside-existing', () => {
    expect(isRefactorCandidate('refactor-candidate')).toBe(true);
    expect(isRefactorCandidate('inside-existing')).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isRefactorCandidate('new-block')).toBe(false);
  });
});

describe('analyseCursorContext', () => {
  it('classifies a blank line inside a function body as new-statement', () => {
    const doc = makeDocument(['function f() {', '  ', '}'].join('\n'));
    const ctx = analyseCursorContext(doc as any, pos(1, 2));
    expect(ctx.intent).toBe('new-statement');
    expect(ctx.isNewLine).toBe(true);
    expect(ctx.nestingDepth).toBe(1);
  });

  it('classifies a fresh top-level line after a complete statement as new-block', () => {
    const doc = makeDocument(['const a = 1;', ''].join('\n'));
    const ctx = analyseCursorContext(doc as any, pos(1, 0));
    expect(ctx.intent).toBe('new-block');
    expect(ctx.nestingDepth).toBe(0);
  });

  it('classifies a cursor in the middle of existing code as inside-existing', () => {
    const doc = makeDocument('const value = computeSomething();');
    const ctx = analyseCursorContext(doc as any, pos(0, 6));
    expect(ctx.intent).toBe('inside-existing');
    expect(ctx.charsAfterCursor).toBeGreaterThan(2);
  });

  it('handles an out-of-range position gracefully by clamping', () => {
    const doc = makeDocument('const a = 1;');
    const ctx = analyseCursorContext(doc as any, pos(99, 99));
    expect(ctx).toBeDefined();
    expect(ctx.currentLinePrefix).toBe('const a = 1;');
  });
});
