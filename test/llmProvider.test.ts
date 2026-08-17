import {
  buildImplementationPrompt,
  buildTestPrompt,
  buildRefactorPrompt,
  buildExplainPrompt,
  buildFixPrompt,
  buildDocstringPrompt,
  buildInlineChatPrompt,
  buildCommitMessagePrompt,
  ChatMessage,
} from '../src/llmProvider';

function roles(msgs: ChatMessage[]): string[] {
  return msgs.map(m => m.role);
}

describe('buildImplementationPrompt', () => {
  it('builds a constructor prompt embedding the class code and language', () => {
    const msgs = buildImplementationPrompt('class C { x = 1; }', 'typescript', 'constructor');
    expect(roles(msgs)).toEqual(['system', 'user']);
    expect(msgs[1].content).toContain('class C { x = 1; }');
    expect(msgs[0].content).toContain('typescript');
  });

  it('targets a single field for getters-setters when singleField is given', () => {
    const msgs = buildImplementationPrompt(
      'class C {}', 'java', 'getters-setters', undefined, { name: 'age', type: 'int' }
    );
    expect(msgs[1].content).toContain('age');
    expect(msgs[1].content).toContain('int');
    expect(msgs[1].content).toMatch(/ONE field only/i);
  });

  it('includes the interface code block when provided', () => {
    const msgs = buildImplementationPrompt(
      'class C {}', 'typescript', 'interface-impl', 'interface I { foo(): void; }'
    );
    expect(msgs[1].content).toContain('interface I { foo(): void; }');
  });
});

describe('single-shot prompt builders', () => {
  it('buildTestPrompt names the framework when supplied', () => {
    const msgs = buildTestPrompt('function add(a,b){return a+b;}', 'typescript', 'jest');
    expect(msgs[0].content).toContain('jest');
    expect(msgs[1].content).toContain('function add(a,b){return a+b;}');
  });

  it('buildTestPrompt falls back to a generic instruction without a framework', () => {
    const msgs = buildTestPrompt('code', 'python');
    expect(msgs[0].content).toMatch(/most common testing framework/i);
  });

  it('buildRefactorPrompt embeds the instruction and code', () => {
    const msgs = buildRefactorPrompt('let x = 1', 'javascript', 'use const');
    expect(msgs[1].content).toContain('use const');
    expect(msgs[1].content).toContain('let x = 1');
  });

  it('buildExplainPrompt wraps the code in a fenced block for the language', () => {
    const msgs = buildExplainPrompt('print(1)', 'python');
    expect(msgs[1].content).toContain('```python');
    expect(msgs[1].content).toContain('print(1)');
  });

  it('buildFixPrompt asks to fix bugs', () => {
    const msgs = buildFixPrompt('const x =', 'typescript');
    expect(msgs[1].content).toMatch(/Fix bugs/i);
  });

  it('buildDocstringPrompt requests a docstring', () => {
    const msgs = buildDocstringPrompt('def f(): pass', 'python');
    expect(msgs[1].content).toMatch(/docstring/i);
  });
});

describe('buildInlineChatPrompt', () => {
  it('includes selected code and context sections when provided', () => {
    const msgs = buildInlineChatPrompt('make it faster', 'const a = slow()', 'surrounding', 'typescript');
    expect(msgs[1].content).toContain('make it faster');
    expect(msgs[1].content).toContain('const a = slow()');
    expect(msgs[1].content).toContain('surrounding');
  });

  it('omits the code section when no selection is given', () => {
    const msgs = buildInlineChatPrompt('explain', null, '', 'typescript');
    expect(msgs[1].content).toBe('explain');
  });
});

describe('buildCommitMessagePrompt', () => {
  it('requests conventional commit format', () => {
    const msgs = buildCommitMessagePrompt('diff --git a/x b/x');
    expect(msgs[0].content).toMatch(/Conventional Commits/i);
    expect(msgs[1].content).toContain('diff --git a/x b/x');
  });

  it('truncates very long diffs to 3000 characters', () => {
    const bigDiff = 'x'.repeat(5000);
    const msgs = buildCommitMessagePrompt(bigDiff);
    // 3000 chars of diff + the fixed preamble text
    expect(msgs[1].content).toContain('x'.repeat(3000));
    expect(msgs[1].content).not.toContain('x'.repeat(3001));
  });
});
