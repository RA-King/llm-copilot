import {
  validateStructure, validateWithInterpreter, looksLikeProse, scan,
  __resetValidatorCaches,
} from '../src/snippetValidator';

beforeEach(() => __resetValidatorCaches());

describe('scan', () => {
  it('ignores delimiters inside strings and comments', () => {
    const st = scan('const a = "{{{"; // }}}\n', 'typescript');
    expect(st.curly).toBe(0);
  });

  it('tracks unterminated strings', () => {
    expect(scan('const a = "oops', 'typescript').inString).toBe('"');
  });

  it('handles python triple-quoted strings', () => {
    const st = scan('x = """a { b """\n', 'python');
    expect(st.inString).toBeNull();
    expect(st.curly).toBe(0);
  });

  it('handles escaped quotes', () => {
    expect(scan('const s = "a\\"b";', 'typescript').inString).toBeNull();
  });
});

describe('looksLikeProse', () => {
  it('flags an English sentence with no code punctuation', () => {
    expect(looksLikeProse('This method returns the total price', 'typescript')).toBe(true);
  });

  it('does not flag code', () => {
    expect(looksLikeProse('const total = items.length', 'typescript')).toBe(false);
    expect(looksLikeProse('return sum', 'typescript')).toBe(false);
    expect(looksLikeProse('pass', 'python')).toBe(false);
  });

  it('does not flag comments', () => {
    expect(looksLikeProse('// this method returns the total price', 'typescript')).toBe(false);
  });
});

describe('validateStructure', () => {
  const prefix = 'class A {\n  run() {\n    ';
  const suffix = '\n  }\n}\n';

  it('accepts a well-formed snippet', () => {
    const r = validateStructure('const x = 1;\n    return x;', prefix, suffix, 'typescript');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
  });

  it('repairs a snippet that closes the enclosing block', () => {
    // The model helpfully closed run() and class A for us — both must go.
    const r = validateStructure('return 1;\n  }\n}', prefix, suffix, 'typescript');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(r.snippet.trim()).toBe('return 1;');
    expect(r.reason).toMatch(/over-closing/);
  });

  it('rejects a snippet that leaves a string unterminated', () => {
    const r = validateStructure('const s = "oops;', prefix, suffix, 'typescript');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unterminated/);
  });

  it('rejects a snippet that leaves brackets unclosed', () => {
    const r = validateStructure('foo(bar, baz', prefix, suffix, 'typescript');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unclosed/);
  });

  it('accepts an opened brace when the snippet closes it itself', () => {
    const r = validateStructure('if (x) {\n      doThing();\n    }', prefix, suffix, 'typescript');
    expect(r.ok).toBe(true);
  });

  it('rejects pure prose', () => {
    const r = validateStructure('Here we compute the running total', prefix, suffix, 'typescript');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/prose|explanation/);
  });

  it('trims trailing prose but keeps the code above it', () => {
    const r = validateStructure('return 1;\nThis returns the identity value', prefix, suffix, 'typescript');
    expect(r.ok).toBe(true);
    expect(r.snippet).toBe('return 1;');
    expect(r.repaired).toBe(true);
  });

  it('rejects a leftover code fence', () => {
    const r = validateStructure('```ts\nreturn 1;', prefix, suffix, 'typescript');
    expect(r.ok).toBe(false);
  });

  it('refuses to suggest while the cursor sits inside a string', () => {
    const r = validateStructure('foo();', 'const msg = "hello ', '";', 'typescript');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/inside a string/);
  });

  it('rejects a python block opened with no body', () => {
    const r = validateStructure('if x > 0:', 'def f(x):\n    ', '\n', 'python');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no body/);
  });

  it('accepts a properly indented python block', () => {
    const r = validateStructure('if x > 0:\n        return x', 'def f(x):\n    ', '\n', 'python');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty snippet', () => {
    expect(validateStructure('   ', prefix, suffix, 'typescript').ok).toBe(false);
  });
});

describe('validateWithInterpreter', () => {
  it('accepts valid python via the real parser', async () => {
    const r = await validateWithInterpreter('def f(x):\n    return x + 1\n', 'python');
    // 'skipped' when no python is installed on this machine — never a failure.
    expect(['valid', 'skipped']).toContain(r.status);
    if (r.status === 'valid') { expect(r.message).toBe(''); }
  }, 15000);

  it('rejects invalid python via the real parser', async () => {
    const r = await validateWithInterpreter('def f(x):\nreturn x + 1\n', 'python');
    expect(['invalid', 'skipped']).toContain(r.status);
    if (r.status === 'invalid') { expect(r.message.length).toBeGreaterThan(0); }
  }, 15000);

  it('accepts valid javascript via node --check', async () => {
    const r = await validateWithInterpreter('function f(a) { return a * 2; }\n', 'javascript');
    expect(['valid', 'skipped']).toContain(r.status);
  }, 15000);

  it('rejects invalid javascript via node --check', async () => {
    const r = await validateWithInterpreter('function f(a) { return a * ; }\n', 'javascript');
    expect(['invalid', 'skipped']).toContain(r.status);
  }, 15000);

  it('parses TypeScript in-process, ignoring unresolved imports', async () => {
    // A temp file cannot resolve './x' — a project-wide tsc would reject this,
    // the syntax-only parser must not.
    const r = await validateWithInterpreter(
      'import { X } from "./x";\nfunction f(b: X): number { return 1; }\n',
      'typescript',
      { cwd: process.cwd() }
    );
    expect(r.status).toBe('valid');
  });

  it('rejects invalid TypeScript in-process', async () => {
    const r = await validateWithInterpreter('const a: number = ;\n', 'typescript', { cwd: process.cwd() });
    expect(r.status).toBe('invalid');
    expect(r.message).toMatch(/Expression expected/);
  });

  it('parses TSX', async () => {
    const r = await validateWithInterpreter(
      'const A = () => <div className="x">hi</div>;\n',
      'typescriptreact',
      { cwd: process.cwd() }
    );
    expect(r.status).toBe('valid');
  });

  it('skips — never rejects — when the checker cannot be launched', async () => {
    // A 1ms budget guarantees the subprocess is killed before it answers.
    const r = await validateWithInterpreter('def f():\n    pass\n', 'python', { timeoutMs: 1 });
    expect(r.status).toBe('skipped');
  }, 15000);

  it('skips languages with no configured checker', async () => {
    const r = await validateWithInterpreter('whatever', 'brainfuck');
    expect(r.status).toBe('skipped');
  });

  it('caches repeat verdicts', async () => {
    const src = 'function g() { return 1; }\n';
    const a = await validateWithInterpreter(src, 'javascript');
    const started = Date.now();
    const b = await validateWithInterpreter(src, 'javascript');
    expect(b.status).toBe(a.status);
    expect(Date.now() - started).toBeLessThan(50);   // served from cache
  }, 20000);
});
