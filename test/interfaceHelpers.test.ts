import {
  extractMethodSignatures,
  buildSingleMethodImplPrompt,
} from '../src/interfaceHelpers';

describe('extractMethodSignatures', () => {
  it('extracts TypeScript interface method signatures', () => {
    const code = `interface Repository {
  findById(id: string): User;
  save(user: User): void;
  readonly count: number;
  deleteAll(): Promise<void>;
}`;
    const sigs = extractMethodSignatures(code, 'typescript');
    const names = sigs.map(s => s.name);
    expect(names).toContain('findById');
    expect(names).toContain('save');
    expect(names).toContain('deleteAll');
  });

  it('extracts Python abstract method names', () => {
    const code = `class Shape(ABC):
    @abstractmethod
    def area(self) -> float:
        ...
    @abstractmethod
    def perimeter(self):
        ...`;
    const names = extractMethodSignatures(code, 'python').map(s => s.name);
    expect(names).toEqual(['area', 'perimeter']);
  });

  it('extracts Java interface methods', () => {
    const code = `public interface Animal {
    String makeSound();
    void move(int distance);
}`;
    const names = extractMethodSignatures(code, 'java').map(s => s.name);
    expect(names).toContain('makeSound');
    expect(names).toContain('move');
  });

  it('does not return the same method name twice', () => {
    const code = `interface I {
  foo(): void;
  foo(): void;
}`;
    const sigs = extractMethodSignatures(code, 'typescript');
    expect(sigs.filter(s => s.name === 'foo')).toHaveLength(1);
  });

  it('skips structural keywords like class / interface / if', () => {
    const code = `interface Thing {
  doWork(): void;
}`;
    const names = extractMethodSignatures(code, 'typescript').map(s => s.name);
    expect(names).not.toContain('interface');
    expect(names).not.toContain('class');
  });

  it('returns an empty array when there are no method signatures', () => {
    expect(extractMethodSignatures('const x = 1;', 'typescript')).toEqual([]);
  });

  it('captures the trimmed signature text alongside the name', () => {
    const sigs = extractMethodSignatures('interface I {\n  save(user: User): void;\n}', 'typescript');
    const save = sigs.find(s => s.name === 'save');
    expect(save?.signature).toBe('save(user: User): void;');
  });
});

describe('buildSingleMethodImplPrompt', () => {
  it('produces a system + user message pair', () => {
    const msgs = buildSingleMethodImplPrompt('area(): number;', 'class Circle {}', 'typescript');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('embeds the language, signature and class context in the prompt', () => {
    const msgs = buildSingleMethodImplPrompt('area(): number;', 'class Circle { r = 1; }', 'typescript');
    expect(msgs[0].content).toContain('typescript');
    expect(msgs[1].content).toContain('area(): number;');
    expect(msgs[1].content).toContain('class Circle { r = 1; }');
  });

  it('instructs the model to output only ONE method', () => {
    const msgs = buildSingleMethodImplPrompt('foo(): void;', 'ctx', 'typescript');
    expect(msgs[0].content).toMatch(/ONE method/i);
  });
});
