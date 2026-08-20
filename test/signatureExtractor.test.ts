import {
  extractSurroundingContext, parseParams, extractParamSource, extractReturnType,
  splitTopLevel, stripLiterals, buildScopeChain, renderContextForPrompt,
} from '../src/signatureExtractor';
import { makeDocument, pos } from './helpers';

const doc = (text: string, lang = 'typescript') => makeDocument(text, lang) as any;

describe('stripLiterals', () => {
  it('blanks out string contents but preserves length', () => {
    const line = 'const a = "he{llo}"; // }';
    const out = stripLiterals(line);
    expect(out.length).toBe(line.length);
    expect(out).not.toContain('{');
    expect(out).not.toContain('}');
  });

  it('keeps code outside the literal', () => {
    expect(stripLiterals('foo("bar") {').trim()).toBe('foo(     ) {');
  });

  it('treats # as a comment only in hash-comment languages', () => {
    expect(stripLiterals('a = b # }', 'python')).not.toContain('}');
    expect(stripLiterals('a = b # }', 'typescript')).toContain('}');
  });
});

describe('splitTopLevel', () => {
  it('ignores commas nested in generics and calls', () => {
    expect(splitTopLevel('a: Map<string, number>, b: Foo<A, B>, c')).toEqual([
      'a: Map<string, number>', 'b: Foo<A, B>', 'c',
    ]);
  });

  it('ignores commas inside strings and defaults', () => {
    expect(splitTopLevel('sep: string = ",", n: number')).toEqual([
      'sep: string = ","', 'n: number',
    ]);
  });
});

describe('extractParamSource', () => {
  it('skips a generics group before the parameter list', () => {
    expect(extractParamSource('function map<T, U>(items: T[], fn: (t: T) => U): U[] {'))
      .toBe('items: T[], fn: (t: T) => U');
  });
});

describe('parseParams', () => {
  it('parses TypeScript params with types, optionals and defaults', () => {
    const ps = parseParams('name: string, age?: number, tags: string[] = []', 'typescript');
    expect(ps.map(p => [p.name, p.type, p.optional])).toEqual([
      ['name', 'string', false],
      ['age', 'number', true],
      ['tags', 'string[]', true],
    ]);
    expect(ps[2].defaultValue).toBe('[]');
  });

  it('parses rest params', () => {
    const ps = parseParams('...items: number[]', 'typescript');
    expect(ps[0].rest).toBe(true);
    expect(ps[0].name).toBe('items');
    expect(ps[0].type).toBe('number[]');
  });

  it('parses Java prefix-typed params', () => {
    const ps = parseParams('final Map<String, Integer> counts, int limit', 'java');
    expect(ps.map(p => [p.type, p.name])).toEqual([
      ['Map<String, Integer>', 'counts'],
      ['int', 'limit'],
    ]);
  });

  it('parses Go grouped params', () => {
    const ps = parseParams('a, b int, name string', 'go');
    expect(ps.map(p => [p.name, p.type])).toEqual([
      ['a', 'int'], ['b', 'int'], ['name', 'string'],
    ]);
  });

  it('recognises Rust and Python receivers', () => {
    expect(parseParams('&mut self, x: i32', 'rust')[0].name).toBe('self');
    expect(parseParams('self, value: int', 'python')[0].name).toBe('self');
  });
});

describe('extractReturnType', () => {
  it('reads a TypeScript colon return type', () => {
    expect(extractReturnType('async function load(id: string): Promise<User> {', 'typescript'))
      .toBe('Promise<User>');
  });

  it('reads a Rust arrow return type', () => {
    expect(extractReturnType('fn parse(s: &str) -> Result<Config, Error> {', 'rust'))
      .toBe('Result<Config, Error>');
  });

  it('reads a Python arrow return type', () => {
    expect(extractReturnType('def load(self, id: str) -> Optional[User]:', 'python'))
      .toBe('Optional[User]');
  });

  it('reads a Java prefix return type past modifiers', () => {
    expect(extractReturnType('public static List<String> names(int n) {', 'java'))
      .toBe('List<String>');
  });

  it('reads a Go return type', () => {
    expect(extractReturnType('func Load(id string) (*User, error) {', 'go'))
      .toBe('(*User, error)');
  });
});

describe('buildScopeChain', () => {
  it('finds the enclosing method and class in a brace language', () => {
    const src = [
      'export class UserService {',
      '  private cache: Map<string, User> = new Map();',
      '',
      '  async findById(id: string): Promise<User | null> {',
      '    const hit = this.cache.get(id);',
      '    ',
      '  }',
      '}',
    ].join('\n');
    const chain = buildScopeChain(doc(src), pos(5, 4));
    expect(chain[0].kind).toBe('method');
    expect(chain[0].name).toBe('findById');
    expect(chain.some(f => f.kind === 'class' && f.name === 'UserService')).toBe(true);
  });

  it('finds the enclosing def and class in Python', () => {
    const src = [
      'class Repo:',
      '    def __init__(self, db: Database):',
      '        self.db = db',
      '',
      '    def find(self, id: str) -> Optional[User]:',
      '        ',
    ].join('\n');
    const chain = buildScopeChain(doc(src, 'python'), pos(5, 8));
    expect(chain[0].name).toBe('find');
    expect(chain.some(f => f.name === 'Repo')).toBe(true);
  });
});

describe('extractSurroundingContext', () => {
  it('captures the signature, fields, params and locals visible at the cursor', () => {
    const src = [
      'export class OrderService {',
      '  private readonly repo: OrderRepository;',
      '  private rate: number = 0.2;',
      '',
      '  async total(orderId: string, includeTax: boolean = true): Promise<number> {',
      '    const order = await this.repo.find(orderId);',
      '    let sum = 0;',
      '    ',
      '  }',
      '}',
    ].join('\n');
    const ctx = extractSurroundingContext(doc(src), pos(7, 4));

    expect(ctx.enclosing).not.toBeNull();
    expect(ctx.enclosing!.name).toBe('total');
    expect(ctx.enclosing!.isAsync).toBe(true);
    expect(ctx.enclosing!.returnType).toBe('Promise<number>');
    expect(ctx.enclosing!.params.map(p => p.name)).toEqual(['orderId', 'includeTax']);
    expect(ctx.enclosing!.params[0].type).toBe('string');

    expect(ctx.container!.name).toBe('OrderService');

    const names = ctx.bindings.map(b => b.name);
    expect(names).toEqual(expect.arrayContaining(['repo', 'rate', 'orderId', 'includeTax', 'order', 'sum']));

    const repo = ctx.bindings.find(b => b.name === 'repo')!;
    expect(repo.source).toBe('field');
    expect(repo.type).toBe('OrderRepository');

    expect(ctx.memberAccesses).toContain('repo');
  });

  it('reports existing return expressions when the type is not annotated', () => {
    const src = [
      'function classify(n) {',
      '  if (n < 0) return "negative";',
      '  ',
      '}',
    ].join('\n');
    const ctx = extractSurroundingContext(doc(src, 'javascript'), pos(2, 2));
    expect(ctx.returnExpressions[0]).toContain('negative');
  });

  it('never reports a call expression as a declared type', () => {
    const src = [
      'class A {',
      '  async run() {',
      '    const order = await this.repo.findById(id);',
      '    const money = new Money(0);',
      '    ',
      '  }',
      '}',
    ].join('\n');
    const ctx = extractSurroundingContext(doc(src), pos(4, 4));

    const order = ctx.bindings.find(b => b.name === 'order')!;
    expect(order.type).toBe('');                       // no type was declared
    expect(order.init).toContain('this.repo.findById'); // provenance is kept

    const money = ctx.bindings.find(b => b.name === 'money')!;
    expect(money.type).toBe('Money');                  // `new Money` names a real type
  });

  it('handles an empty document without throwing', () => {
    const ctx = extractSurroundingContext(doc(''), pos(0, 0));
    expect(ctx.enclosing).toBeNull();
    expect(ctx.bindings).toEqual([]);
  });

  it('handles a cursor past the end of the document', () => {
    const ctx = extractSurroundingContext(doc('const a = 1;'), pos(99, 99));
    expect(ctx.language).toBe('typescript');
  });
});

describe('renderContextForPrompt', () => {
  it('renders the enclosing signature and scope compactly', () => {
    const src = [
      'class A {',
      '  run(x: number, y: string): boolean {',
      '    const z = x + 1;',
      '    ',
      '  }',
      '}',
    ].join('\n');
    const out = renderContextForPrompt(extractSurroundingContext(doc(src), pos(3, 4)));
    expect(out).toContain('Enclosing class: A');
    expect(out).toContain('run(x: number, y: string) -> boolean');
    expect(out).toContain('In scope:');
    expect(out).toContain('z');
    expect(out).not.toMatch(/z:\s*x \+ 1/);   // an initialiser is never shown as a type
  });
});
