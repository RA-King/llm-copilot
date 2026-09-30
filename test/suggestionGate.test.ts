import {
  AdaptiveDebounce, ContinuationCache, DismissalMemory, DEFAULT_LIMITS,
  GateInput, TypingTracker, evaluateGate, inStringOrComment, opensBlock,
  trailingIdentifier, trimToBudget,
} from '../src/suggestionGate';

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    language: 'typescript',
    linePrefix: '    const total = ',
    lineSuffix: '',
    previousLine: '  function total(items: Item[]) {',
    shape: 'statement',
    singleEmptyCursor: true,
    typingForward: true,
    recentlyDismissed: false,
    limits: DEFAULT_LIMITS,
    ...over,
  };
}

describe('evaluateGate', () => {
  it('allows a suggestion at the end of a line being typed', () => {
    expect(evaluateGate(input())).toEqual({ show: true, shape: 'statement', maxLines: 3 });
  });

  it('refuses to write over code that follows the cursor', () => {
    const verdict = evaluateGate(input({ lineSuffix: '.filter(Boolean)' }));
    expect(verdict.show).toBe(false);
  });

  it('allows closing delimiters after the cursor', () => {
    // Finishing an argument list from inside its own brackets is the normal
    // case, not an intrusion.
    expect(evaluateGate(input({ linePrefix: '    total(', lineSuffix: ');' })).show).toBe(true);
  });

  it('stays quiet while the author is deleting', () => {
    expect(evaluateGate(input({ typingForward: false })).show).toBe(false);
  });

  it('stays quiet with a selection active', () => {
    expect(evaluateGate(input({ singleEmptyCursor: false })).show).toBe(false);
  });

  it('stays quiet inside a string', () => {
    expect(evaluateGate(input({ linePrefix: '    const msg = "hello ' })).show).toBe(false);
  });

  it('stays quiet inside a comment', () => {
    expect(evaluateGate(input({ linePrefix: '    // work out the ' })).show).toBe(false);
  });

  it('stays quiet after a dismissal', () => {
    expect(evaluateGate(input({ recentlyDismissed: true })).show).toBe(false);
  });

  it('leaves a bare member access to the editor’s own completion list', () => {
    expect(evaluateGate(input({ linePrefix: '    order.' })).show).toBe(false);
    expect(evaluateGate(input({ linePrefix: '    order.f' })).show).toBe(false);
    expect(evaluateGate(input({ linePrefix: '    order.fin' })).show).toBe(true);
  });

  it('gives an expression one line', () => {
    const verdict = evaluateGate(input({ shape: 'expression' }));
    expect(verdict).toEqual({ show: true, shape: 'expression', maxLines: 1 });
  });

  it('demotes a block to a statement unless a block was just opened', () => {
    const notOpened = evaluateGate(input({ shape: 'block', previousLine: '  const a = 1;' }));
    expect(notOpened).toEqual({ show: true, shape: 'statement', maxLines: 3 });

    const opened = evaluateGate(input({ shape: 'block', linePrefix: '    ' }));
    expect(opened).toEqual({ show: true, shape: 'block', maxLines: 12 });
  });

  it('honours the configured ceilings', () => {
    const verdict = evaluateGate(input({
      shape: 'block', linePrefix: '    ',
      limits: { ...DEFAULT_LIMITS, blockLines: 4 },
    }));
    expect(verdict).toEqual({ show: true, shape: 'block', maxLines: 4 });
  });
});

describe('inStringOrComment', () => {
  it('sees an open quote', () => {
    expect(inStringOrComment('const a = "abc', 'typescript')).toBe(true);
  });

  it('sees a closed quote as closed', () => {
    expect(inStringOrComment('const a = "abc";', 'typescript')).toBe(false);
  });

  it('ignores an escaped quote', () => {
    expect(inStringOrComment('const a = "say \\"hi\\"";', 'typescript')).toBe(false);
  });

  it('reads the language’s own comment marker', () => {
    expect(inStringOrComment('x = 1  # set ', 'python')).toBe(true);
    expect(inStringOrComment('x = 1  # set ', 'typescript')).toBe(false);
  });

  it('sees an unterminated block comment', () => {
    expect(inStringOrComment('/* note ', 'typescript')).toBe(true);
    expect(inStringOrComment('/* note */ const a', 'typescript')).toBe(false);
  });

  it('does not treat a URL in a string as a comment', () => {
    expect(inStringOrComment('const u = "https://example.com";', 'typescript')).toBe(false);
  });
});

describe('trailingIdentifier', () => {
  it('reads the word being typed', () => {
    expect(trailingIdentifier('  const fet')).toEqual({ identifier: 'fet', afterMemberAccess: false });
  });

  it('notices a member access', () => {
    expect(trailingIdentifier('  repo.fin')).toEqual({ identifier: 'fin', afterMemberAccess: true });
    expect(trailingIdentifier('  repo::fin')).toEqual({ identifier: 'fin', afterMemberAccess: true });
    expect(trailingIdentifier('  repo->fin')).toEqual({ identifier: 'fin', afterMemberAccess: true });
  });

  it('reports an empty identifier after punctuation', () => {
    expect(trailingIdentifier('  repo.')).toEqual({ identifier: '', afterMemberAccess: true });
  });
});

describe('opensBlock', () => {
  it('reads a brace', () => {
    expect(opensBlock('function f() {', 'typescript')).toBe(true);
    expect(opensBlock('const a = 1;', 'typescript')).toBe(false);
  });

  it('reads a colon in Python', () => {
    expect(opensBlock('def f():', 'python')).toBe(true);
    expect(opensBlock('a = 1', 'python')).toBe(false);
  });
});

describe('trimToBudget', () => {
  it('leaves a short suggestion alone', () => {
    expect(trimToBudget('a\nb', 3)).toBe('a\nb');
  });

  it('cuts at the last balanced line', () => {
    const text = 'const a = 1;\nconst b = 2;\nif (a) {\n  b();\n}';
    expect(trimToBudget(text, 3)).toBe('const a = 1;\nconst b = 2;');
  });

  it('refuses when nothing inside the budget is balanced', () => {
    expect(trimToBudget('if (a) {\n  b();\n  c();\n}', 2)).toBeNull();
  });

  it('ignores braces inside strings', () => {
    const text = 'const a = "{";\nconst b = 2;\nconst c = 3;';
    expect(trimToBudget(text, 2)).toBe('const a = "{";\nconst b = 2;');
  });
});

describe('DismissalMemory', () => {
  it('holds a dismissal until the author types past it', () => {
    const memory = new DismissalMemory(30_000, 4);
    memory.record('file://a.ts', 3, '  const t');

    expect(memory.isDismissed('file://a.ts', 3, '  const t')).toBe(true);
    expect(memory.isDismissed('file://a.ts', 3, '  const to')).toBe(true);
    expect(memory.isDismissed('file://a.ts', 3, '  const total')).toBe(false);
  });

  it('releases when the line is rewritten rather than extended', () => {
    const memory = new DismissalMemory();
    memory.record('file://a.ts', 3, '  const t');
    expect(memory.isDismissed('file://a.ts', 3, '  let x')).toBe(false);
  });

  it('is scoped to the line and the file', () => {
    const memory = new DismissalMemory();
    memory.record('file://a.ts', 3, '  const t');
    expect(memory.isDismissed('file://a.ts', 4, '  const t')).toBe(false);
    expect(memory.isDismissed('file://b.ts', 3, '  const t')).toBe(false);
  });

  it('expires', () => {
    const memory = new DismissalMemory(0);
    memory.record('file://a.ts', 3, '  const t');
    expect(memory.isDismissed('file://a.ts', 3, '  const t')).toBe(false);
  });
});

describe('TypingTracker', () => {
  it('is forward while inserting', () => {
    const tracker = new TypingTracker();
    tracker.note({ insertedLength: 1, removedLength: 0 });
    expect(tracker.isTypingForward()).toBe(true);
  });

  it('is not forward while deleting', () => {
    const tracker = new TypingTracker();
    tracker.note({ insertedLength: 1, removedLength: 0 });
    tracker.note({ insertedLength: 0, removedLength: 1 });
    expect(tracker.isTypingForward()).toBe(false);
  });

  it('is not forward on a replacement', () => {
    const tracker = new TypingTracker();
    tracker.note({ insertedLength: 4, removedLength: 9 });
    expect(tracker.isTypingForward()).toBe(false);
  });

  it('treats an explicit invoke as intent', () => {
    const tracker = new TypingTracker();
    tracker.note({ insertedLength: 0, removedLength: 1 });
    tracker.noteExplicitInvoke();
    expect(tracker.isTypingForward()).toBe(true);
  });
});

describe('AdaptiveDebounce', () => {
  it('waits the full ceiling before it has measured anything', () => {
    const pacing = new AdaptiveDebounce(150, 600);
    expect(pacing.currentMs()).toBe(600);
  });

  it('drops to the floor for a fast model', () => {
    const pacing = new AdaptiveDebounce(150, 600);
    for (const ms of [90, 110, 100, 95]) { pacing.observe(ms); }
    expect(pacing.currentMs()).toBe(150);
  });

  it('stays near the ceiling for a slow one', () => {
    const pacing = new AdaptiveDebounce(150, 600);
    for (const ms of [1800, 2000, 1900, 2100]) { pacing.observe(ms); }
    expect(pacing.currentMs()).toBe(600);
  });

  it('sits in between for a middling one', () => {
    const pacing = new AdaptiveDebounce(150, 600);
    for (const ms of [300, 320, 310, 305]) { pacing.observe(ms); }
    const wait = pacing.currentMs();
    expect(wait).toBeGreaterThan(150);
    expect(wait).toBeLessThan(600);
  });

  it('ignores nonsense measurements', () => {
    const pacing = new AdaptiveDebounce(150, 600);
    pacing.observe(-1);
    pacing.observe(NaN);
    expect(pacing.medianMs()).toBe(0);
  });
});

describe('ContinuationCache', () => {
  it('returns the remainder when the author types through a suggestion', () => {
    const cache = new ContinuationCache();
    cache.remember('file://a.ts', 2, '  const t', 'otal = items.length;');

    expect(cache.continuation('file://a.ts', 2, '  const to')).toBe('tal = items.length;');
    expect(cache.continuation('file://a.ts', 2, '  const total')).toBe(' = items.length;');
  });

  it('gives the whole suggestion back when nothing has been typed since', () => {
    const cache = new ContinuationCache();
    cache.remember('file://a.ts', 2, '  const t', 'otal = 0;');
    expect(cache.continuation('file://a.ts', 2, '  const t')).toBe('otal = 0;');
  });

  it('forgets the moment the author diverges', () => {
    const cache = new ContinuationCache();
    cache.remember('file://a.ts', 2, '  const t', 'otal = 0;');
    expect(cache.continuation('file://a.ts', 2, '  const x')).toBeNull();
    expect(cache.continuation('file://a.ts', 2, '  const to')).toBeNull();
  });

  it('does not answer for another line or another file', () => {
    const cache = new ContinuationCache();
    cache.remember('file://a.ts', 2, '  const t', 'otal = 0;');
    expect(cache.continuation('file://a.ts', 3, '  const t')).toBeNull();
    expect(cache.continuation('file://b.ts', 2, '  const t')).toBeNull();
  });

  it('stops once the suggestion has been typed out in full', () => {
    const cache = new ContinuationCache();
    cache.remember('file://a.ts', 2, '  const t', 'otal');
    expect(cache.continuation('file://a.ts', 2, '  const total')).toBeNull();
  });
});
