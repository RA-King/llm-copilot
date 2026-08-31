import {
  splitIdentifier, classifyName, findOpenConstruct, decideShape,
  inferIntent, renderIntentForPrompt,
} from '../src/intentInference';
import { extractSurroundingContext } from '../src/signatureExtractor';
import { makeDocument, pos } from './helpers';

const doc = (text: string, lang = 'typescript') => makeDocument(text, lang) as any;

/** Infer at the cursor marked by `▮` in the source. */
function at(source: string, lang = 'typescript') {
  const lines = source.split('\n');
  const line = lines.findIndex(l => l.includes('▮'));
  if (line < 0) { throw new Error('no ▮ marker in source'); }
  const character = lines[line].indexOf('▮');
  lines[line] = lines[line].replace('▮', '');
  const d = doc(lines.join('\n'), lang);
  const p = pos(line, character);
  const linePrefix = lines[line].substring(0, character);
  return inferIntent(d, p, extractSurroundingContext(d, p), linePrefix);
}

describe('splitIdentifier', () => {
  it('splits camelCase', () => {
    expect(splitIdentifier('fetchUserOrders')).toEqual(['fetch', 'user', 'orders']);
  });

  it('splits snake_case and strips leading underscores', () => {
    expect(splitIdentifier('_load_config_file')).toEqual(['load', 'config', 'file']);
  });

  it('keeps acronyms together', () => {
    expect(splitIdentifier('parseHTTPResponse')).toEqual(['parse', 'http', 'response']);
  });
});

describe('classifyName', () => {
  it('reads a fetch verb', () => {
    const r = classifyName('fetchUserOrders');
    expect(r.kind).toBe('fetch');
    expect(r.goal).toBe('fetch user orders');
    expect(r.subject).toBe('user orders');
  });

  it('reads predicates from is/has/should', () => {
    expect(classifyName('isEligible').kind).toBe('predicate');
    expect(classifyName('hasPermission').kind).toBe('predicate');
  });

  it('recognises validators, builders and mutators', () => {
    expect(classifyName('validateEmail').kind).toBe('validate');
    expect(classifyName('buildRequest').kind).toBe('create');
    expect(classifyName('saveOrder').kind).toBe('mutate');
    expect(classifyName('parseConfig').kind).toBe('transform');
  });

  it('falls back to unknown for names with no verb it knows', () => {
    expect(classifyName('quux').kind).toBe('unknown');
  });
});

describe('findOpenConstruct', () => {
  it('finds the for-of loop the cursor sits in, with variable and iterable', () => {
    const src = [
      'function f(items: Item[]) {',
      '  for (const item of items) {',
      '    ',
      '  }',
      '}',
    ].join('\n');
    const d = doc(src);
    const oc = findOpenConstruct(d, pos(2, 4), 4, 0);
    expect(oc?.kind).toBe('loop');
    expect(oc?.binding).toBe('item');
    expect(oc?.iterable).toBe('items');
  });

  it('finds a catch and the error it binds', () => {
    const src = [
      'try {',
      '  risky();',
      '} catch (err) {',
      '  ',
      '}',
    ].join('\n');
    const oc = findOpenConstruct(doc(src), pos(3, 2), 2, 0);
    expect(oc?.kind).toBe('catch');
    expect(oc?.binding).toBe('err');
  });

  it('reads a python for loop', () => {
    const src = ['def f(rows):', '    for row in rows:', '        ', ''].join('\n');
    const oc = findOpenConstruct(doc(src, 'python'), pos(2, 8), 8, 0);
    expect(oc?.kind).toBe('loop');
    expect(oc?.binding).toBe('row');
    expect(oc?.iterable).toBe('rows');
  });

  it('keeps the condition of a branch', () => {
    const src = ['function f(n: number) {', '  if (n > 10) {', '    ', '  }', '}'].join('\n');
    const oc = findOpenConstruct(doc(src), pos(2, 4), 4, 0);
    expect(oc?.kind).toBe('branch');
    expect(oc?.condition).toBe('n > 10');
  });

  it('returns null when the line above is an ordinary statement', () => {
    const src = ['function f() {', '  const a = 1;', '  ', '}'].join('\n');
    expect(findOpenConstruct(doc(src), pos(2, 2), 2, 0)).toBeNull();
  });
});

describe('decideShape', () => {
  it('asks for an expression after an assignment or operator', () => {
    expect(decideShape('  const total = ', null, 3)).toBe('expression');
    expect(decideShape('  return ', null, 3)).toBe('expression');
    expect(decideShape('  foo(a, ', null, 3)).toBe('expression');
  });

  it('asks for a block right after the brace that opened one', () => {
    const oc = { kind: 'loop' as const, header: '', line: 2, binding: '', iterable: '', condition: '' };
    expect(decideShape('    ', oc, 3)).toBe('block');
  });

  it('asks for a statement on an empty line inside a body', () => {
    const oc = { kind: 'loop' as const, header: '', line: 1, binding: '', iterable: '', condition: '' };
    expect(decideShape('    ', oc, 5)).toBe('statement');
  });
});

describe('inferIntent', () => {
  it('reports parameters the body has not touched yet', () => {
    const intent = at([
      'function applyDiscount(order: Order, rate: number): Order {',
      '  const subtotal = order.total;',
      '  ▮',
      '}',
    ].join('\n'));
    expect(intent.unusedParams).toEqual(['rate']);
  });

  it('flags a local that was declared and never read', () => {
    const intent = at([
      'function summarise(rows: Row[]): string {',
      '  const parts: string[] = [];',
      '  ▮',
      '}',
    ].join('\n'));
    expect(intent.unusedLocals.map(b => b.name)).toContain('parts');
  });

  it('spots the accumulator being filled by the loop the cursor is in', () => {
    const intent = at([
      'function collectNames(users: User[]): string[] {',
      '  const names: string[] = [];',
      '  for (const user of users) {',
      '    ▮',
      '  }',
      '  return names;',
      '}',
    ].join('\n'));
    expect(intent.accumulator?.name).toBe('names');
    expect(intent.openConstruct?.kind).toBe('loop');
    expect(intent.nextSteps[0]).toContain('names');
  });

  it('counts the guard clauses already written', () => {
    const intent = at([
      'function divide(a: number, b: number): number {',
      '  if (b === 0) { throw new Error("divide by zero"); }',
      '  ▮',
      '}',
    ].join('\n'));
    expect(intent.guardCount).toBe(1);
  });

  it('reads the goal from the function name', () => {
    const intent = at([
      'async function fetchUserOrders(userId: string): Promise<Order[]> {',
      '  ▮',
      '}',
    ].join('\n'));
    expect(intent.goalKind).toBe('fetch');
    expect(intent.goal).toBe('fetch user orders');
    expect(intent.nextSteps.join(' ')).toMatch(/await/);
  });

  it('suggests handling the bound error inside a catch', () => {
    const intent = at([
      'async function loadConfig(path: string): Promise<Config> {',
      '  try {',
      '    return parse(await read(path));',
      '  } catch (err) {',
      '    ▮',
      '  }',
      '}',
    ].join('\n'));
    expect(intent.openConstruct?.kind).toBe('catch');
    expect(intent.nextSteps.join(' ')).toContain('err');
  });

  it('works in python', () => {
    const intent = at([
      'def build_report(rows, title):',
      '    lines = []',
      '    for row in rows:',
      '        ▮',
      '',
    ].join('\n'), 'python');
    expect(intent.goalKind).toBe('create');
    expect(intent.openConstruct?.binding).toBe('row');
    expect(intent.accumulator?.name).toBe('lines');
  });

  it('stays quiet at the top level of a file', () => {
    const intent = at('▮\n');
    expect(intent.goalKind).toBe('unknown');
    expect(intent.nextSteps).toEqual([]);
  });
});

describe('renderIntentForPrompt', () => {
  it('renders the goal, the loop, the accumulator and a next step', () => {
    const out = renderIntentForPrompt(at([
      'function collectNames(users: User[]): string[] {',
      '  const names: string[] = [];',
      '  for (const user of users) {',
      '    ▮',
      '  }',
      '  return names;',
      '}',
    ].join('\n')));
    expect(out).toContain('collect names');
    expect(out).toContain('inside a loop');
    expect(out).toContain('`names`');
    expect(out).toContain('Most likely next:');
  });

  it('returns empty when there is nothing worth saying', () => {
    expect(renderIntentForPrompt(at('▮\n'))).toBe('');
  });
});
