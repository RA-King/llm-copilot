import {
  describeError, extractErrorBlock, looksLikeError, parseError, rankFrames, stripAnsi,
} from '../src/errorParser';

const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  it('drops colour codes', () => {
    expect(stripAnsi(`${ESC}[31mError${ESC}[0m: boom`)).toBe('Error: boom');
  });

  it('drops the OSC sequence a shell uses to set the window title', () => {
    const bell = String.fromCharCode(7);
    expect(stripAnsi(`${ESC}]0;~/app${bell}npm test`)).toBe('npm test');
  });

  it('leaves plain output alone', () => {
    expect(stripAnsi('TypeError: x is not a function')).toBe('TypeError: x is not a function');
  });
});

describe('looksLikeError', () => {
  it.each([
    ['a thrown exception', 'TypeError: undefined is not a function'],
    ['a compiler diagnostic', 'src/order.ts(42,15): error TS2345: Argument of type ...'],
    ['a missing file', 'cat: config.yml: No such file or directory'],
    ['a go panic', 'panic: runtime error: index out of range [3] with length 2'],
  ])('recognises %s', (_label, text) => {
    expect(looksLikeError(text)).toBe(true);
  });

  it.each([
    ['a clean build', 'Compiled successfully in 2.1s'],
    ['a zero count', 'Found 0 errors. Watching for file changes.'],
    ['a file whose name contains the word', 'created src/error-handling.ts'],
  ])('does not fire on %s', (_label, text) => {
    expect(looksLikeError(text)).toBe(false);
  });
});

describe('extractErrorBlock', () => {
  it('keeps the failure and drops the output that scrolled before it', () => {
    const output = [
      ...Array.from({ length: 200 }, (_, i) => `  ok test ${i}`),
      'FAIL src/order.test.ts',
      '  ● totals an empty basket',
      '    expect(received).toBe(expected)',
    ].join('\n');

    const block = extractErrorBlock(output, 20);
    expect(block).toContain('FAIL src/order.test.ts');
    expect(block).toContain('expect(received).toBe(expected)');
    expect(block.split('\n').length).toBeLessThanOrEqual(20);
  });

  it('trims trailing blank lines', () => {
    expect(extractErrorBlock('Error: boom\n\n\n')).toBe('Error: boom');
  });

  it('returns nothing for empty output', () => {
    expect(extractErrorBlock('   \n\n')).toBe('');
  });
});

describe('parseError', () => {
  it('reads a node stack trace', () => {
    const raw = [
      '/app/src/order.ts:42',
      '    return basket.items.map(i => i.price);',
      '                        ^',
      '',
      "TypeError: Cannot read properties of undefined (reading 'map')",
      '    at total (/app/src/order.ts:42:25)',
      '    at Object.<anonymous> (/app/src/index.ts:8:1)',
      '    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
    ].join('\n');

    const parsed = parseError(raw, 'terminal')!;
    expect(parsed.origin).toBe('node');
    expect(parsed.type).toBe('TypeError');
    expect(parsed.message).toContain("Cannot read properties of undefined");
    expect(parsed.frames[0]).toEqual({
      file: '/app/src/order.ts', line: 42, column: 25, symbol: 'total',
    });
  });

  it('reads a python traceback, whose exception comes last', () => {
    const raw = [
      'Traceback (most recent call last):',
      '  File "/app/orders.py", line 12, in <module>',
      '    print(total(basket))',
      '  File "/app/orders.py", line 8, in total',
      '    return sum(i.price for i in basket.items)',
      "AttributeError: 'NoneType' object has no attribute 'items'",
    ].join('\n');

    const parsed = parseError(raw, 'debug')!;
    expect(parsed.origin).toBe('python');
    expect(parsed.type).toBe('AttributeError');
    expect(parsed.message).toBe("'NoneType' object has no attribute 'items'");
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[1]).toEqual({ file: '/app/orders.py', line: 8, symbol: 'total' });
  });

  it('reads a java exception', () => {
    const raw = [
      'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "Item.price()"',
      '\tat com.acme.Order.total(Order.java:42)',
      '\tat com.acme.Main.main(Main.java:11)',
    ].join('\n');

    const parsed = parseError(raw, 'debug')!;
    expect(parsed.origin).toBe('java');
    expect(parsed.type).toBe('java.lang.NullPointerException');
    expect(parsed.frames[0]).toEqual({
      file: 'Order.java', line: 42, symbol: 'com.acme.Order.total',
    });
  });

  it('reads a typescript compiler diagnostic as both message and location', () => {
    const parsed = parseError(
      "src/order.ts(42,15): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      'terminal'
    )!;
    expect(parsed.origin).toBe('compiler');
    expect(parsed.type).toBe('TS2345');
    expect(parsed.message).toContain("not assignable");
    expect(parsed.frames[0]).toEqual({ file: 'src/order.ts', line: 42, column: 15 });
  });

  it('reads a gcc diagnostic', () => {
    const parsed = parseError("src/main.c:12:5: error: 'total' undeclared (first use in this function)", 'terminal')!;
    expect(parsed.frames[0]).toEqual({ file: 'src/main.c', line: 12, column: 5 });
    expect(parsed.message).toContain("'total' undeclared");
  });

  it('reads a go panic', () => {
    const raw = [
      'panic: runtime error: index out of range [3] with length 2',
      '',
      'goroutine 1 [running]:',
      'main.total(...)',
      '\t/app/order.go:42 +0x1d',
      'main.main()',
      '\t/app/main.go:11 +0x25',
    ].join('\n');

    const parsed = parseError(raw, 'terminal')!;
    expect(parsed.origin).toBe('go');
    expect(parsed.message).toBe('runtime error: index out of range [3] with length 2');
    expect(parsed.frames[0]).toEqual({ file: '/app/order.go', line: 42 });
  });

  it('reads a rust panic', () => {
    const raw = [
      "thread 'main' panicked at src/main.rs:42:9:",
      'index out of bounds: the len is 2 but the index is 3',
      'note: run with `RUST_BACKTRACE=1` to display a backtrace',
    ].join('\n');

    const parsed = parseError(raw, 'terminal')!;
    expect(parsed.origin).toBe('rust');
    expect(parsed.frames[0]).toEqual({ file: 'src/main.rs', line: 42, column: 9 });
  });

  it('reads a .NET exception', () => {
    const raw = [
      'Unhandled exception. System.NullReferenceException: Object reference not set to an instance of an object.',
      '   at Acme.Order.Total() in /app/Order.cs:line 42',
    ].join('\n');

    const parsed = parseError(raw, 'debug')!;
    expect(parsed.origin).toBe('dotnet');
    expect(parsed.type).toBe('System.NullReferenceException');
    expect(parsed.frames[0]).toEqual({
      file: '/app/Order.cs', line: 42, symbol: 'Acme.Order.Total()',
    });
  });

  it('reads a ruby error', () => {
    const raw = [
      "/app/order.rb:42:in `total': undefined method `price' for nil (NoMethodError)",
      "\tfrom /app/main.rb:11:in `<main>'",
    ].join('\n');

    const parsed = parseError(raw, 'terminal')!;
    expect(parsed.origin).toBe('ruby');
    expect(parsed.type).toBe('NoMethodError');
    expect(parsed.frames[0].file).toBe('/app/order.rb');
    expect(parsed.frames[0].line).toBe(42);
  });

  it('reads a php fatal error', () => {
    const raw = [
      'PHP Fatal error:  Uncaught TypeError: Unsupported operand types: string + int in /app/Order.php:42',
      'Stack trace:',
      '#0 /app/index.php(11): total()',
    ].join('\n');

    const parsed = parseError(raw, 'terminal')!;
    expect(parsed.origin).toBe('php');
    expect(parsed.type).toBe('TypeError');
    expect(parsed.frames.some(f => f.file === '/app/index.php' && f.line === 11)).toBe(true);
  });

  it('reads an npm failure with no trace at all', () => {
    const raw = [
      'npm ERR! code ENOENT',
      'npm ERR! syscall open',
      "npm ERR! enoent ENOENT: no such file or directory, open '/app/package.json'",
    ].join('\n');

    const parsed = parseError(raw, 'terminal')!;
    expect(parsed.origin).toBe('package-manager');
    expect(parsed.message).toContain('no such file or directory');
  });

  it('strips colour codes before reading', () => {
    const parsed = parseError(`${ESC}[31mTypeError${ESC}[0m: boom`, 'terminal')!;
    expect(parsed.headline).toBe('TypeError: boom');
  });

  it('returns null when nothing failed', () => {
    expect(parseError('Compiled successfully in 2.1s\nWatching for file changes.', 'terminal')).toBeNull();
    expect(parseError('   ', 'terminal')).toBeNull();
  });
});

describe('rankFrames', () => {
  it('puts the user\'s own files ahead of dependencies and runtimes', () => {
    const ranked = rankFrames([
      { file: 'node:internal/modules/cjs/loader', line: 1105 },
      { file: '/app/node_modules/express/lib/router.js', line: 47 },
      { file: '/app/src/order.ts', line: 42 },
    ]);
    expect(ranked[0].file).toBe('/app/src/order.ts');
  });

  it('keeps the printed order within each group', () => {
    const ranked = rankFrames([
      { file: '/app/src/a.ts', line: 1 },
      { file: '/app/src/b.ts', line: 2 },
    ]);
    expect(ranked.map(f => f.file)).toEqual(['/app/src/a.ts', '/app/src/b.ts']);
  });
});

describe('describeError', () => {
  it('names the file the failure came from', () => {
    const parsed = parseError(
      ['TypeError: boom', '    at total (/app/src/order.ts:42:25)'].join('\n'),
      'terminal'
    )!;
    expect(describeError(parsed)).toBe('TypeError: boom — order.ts:42');
  });

  it('falls back to the headline when no frame named a file', () => {
    const parsed = parseError('npm ERR! network request failed', 'terminal')!;
    expect(describeError(parsed)).toContain('network request failed');
  });
});
