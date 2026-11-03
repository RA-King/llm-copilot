import {
  buildAgentSystemPrompt, parseAgentReply, visibleText, truncate, compactHistory, findUnique, safeRelativePath,
  stringArg, numberArg, AGENT_TOOLS,
} from '../src/agentProtocol';
import { ChatMessage } from '../src/llmProvider';

describe('buildAgentSystemPrompt', () => {
  it('lists every tool with its arguments and states the call format', () => {
    const prompt = buildAgentSystemPrompt('Workspace root: /repo');
    for (const tool of AGENT_TOOLS) { expect(prompt).toContain(`- ${tool.name}:`); }
    expect(prompt).toContain('start_line?: first line');
    expect(prompt).toContain('<tool name="TOOL_NAME">');
    expect(prompt).toContain('Workspace root: /repo');
  });
});

describe('parseAgentReply', () => {
  it('reads a tagged call and the text before it', () => {
    const reply = 'Reading the config.\n<tool name="read_file">\n{"path": "src/config.ts", "start_line": 10}\n</tool>';
    expect(parseAgentReply(reply)).toEqual({
      text: 'Reading the config.',
      call: { name: 'read_file', args: { path: 'src/config.ts', start_line: 10 } },
    });
  });

  it('accepts a call whose closing tag never arrived, or whose JSON is fenced', () => {
    expect(parseAgentReply('<tool name="list_files">\n{}')?.call).toEqual({ name: 'list_files', args: {} });
    expect(parseAgentReply('<tool name="get_problems">\n```json\n{"path": "a.ts"}\n```\n</tool>')?.call?.args).toEqual({ path: 'a.ts' });
  });

  it('reports arguments that are not a JSON object', () => {
    expect(parseAgentReply('<tool name="read_file">{path: a.ts}</tool>').error).toMatch(/not valid JSON/);
    expect(parseAgentReply('<tool name="read_file">[1]</tool>').error).toMatch(/JSON object/);
  });

  it('falls back to a fenced tool object', () => {
    const reply = 'Searching.\n```json\n{"tool": "search_text", "args": {"query": "retry"}}\n```';
    expect(parseAgentReply(reply).call).toEqual({ name: 'search_text', args: { query: 'retry' } });
  });

  it('treats a reply with no call as the final answer', () => {
    expect(parseAgentReply('  Done: added the check.  ')).toEqual({ text: 'Done: added the check.' });
  });
});

describe('visibleText', () => {
  it('drops the call block, even half-streamed', () => {
    expect(visibleText('Looking.\n<tool name="read_fi')).toBe('Looking.\n<tool name="read_fi'.slice(0, 8));
    expect(visibleText('Looking.\n<tool name="read_file">{"pa')).toBe('Looking.');
  });
});

describe('arguments', () => {
  const call = { name: 'read_file', args: { path: 'a.ts', start_line: '12', bad: 'x' } };

  it('reads strings and numbers, and names what is missing', () => {
    expect(stringArg(call, 'path')).toBe('a.ts');
    expect(numberArg(call, 'start_line')).toBe(12);
    expect(numberArg(call, 'end_line')).toBeUndefined();
    expect(stringArg(call, 'other', false)).toBeUndefined();
    expect(() => stringArg(call, 'other')).toThrow('read_file needs "other"');
    expect(() => numberArg(call, 'bad')).toThrow('must be a number');
  });
});

describe('truncate', () => {
  it('keeps the head and the tail', () => {
    const text = 'a'.repeat(100) + 'b'.repeat(100);
    const out = truncate(text, 50);
    expect(out.startsWith('a'.repeat(30))).toBe(true);
    expect(out.endsWith('b'.repeat(20))).toBe(true);
    expect(out).toContain('150 characters omitted');
    expect(truncate('short', 50)).toBe('short');
  });
});

describe('compactHistory', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'reading' },
    { role: 'user', content: 'Result of read_file:\n' + 'x'.repeat(1000) },
    { role: 'assistant', content: 'reading more' },
    { role: 'user', content: 'Result of read_file:\n' + 'y'.repeat(1000) },
  ];

  it('blanks the oldest tool results first and never the latest', () => {
    const out = compactHistory(messages, 1500);
    expect(out[3].content).toMatch(/^Result of read_file:\n\(earlier result omitted/);
    expect(out[5].content).toBe(messages[5].content);
    expect(out[2].content).toBe('reading');
  });

  it('leaves a conversation inside the budget alone', () => {
    expect(compactHistory(messages, 10000)).toEqual(messages);
  });
});

describe('findUnique', () => {
  const text = 'const a = 1;\nconst b = 2;\nconst a = 1;\n';

  it('finds a passage that occurs once', () => {
    expect(findUnique(text, 'const b = 2;')).toEqual({ start: 13, end: 25 });
  });

  it('refuses a passage that occurs more than once', () => {
    expect(findUnique(text, 'const a = 1;')).toMatch(/matches 2 places/);
  });

  it('tolerates trailing whitespace and CRLF but nothing else', () => {
    expect(findUnique('x = 1;  \r\ny = 2;\r\n', 'x = 1;\ny = 2;')).toEqual({ start: 0, end: 16 });
    expect(findUnique(text, 'const c = 3;')).toMatch(/not found/);
    expect(findUnique(text, '')).toBe('search is empty');
  });
});

describe('safeRelativePath', () => {
  it('normalises paths inside the workspace', () => {
    expect(safeRelativePath('./src//a/../b.ts')).toEqual({ path: 'src/b.ts' });
    expect(safeRelativePath('/repo/src/a.ts', '/repo')).toEqual({ path: 'src/a.ts' });
    expect(safeRelativePath('src\\win\\a.ts')).toEqual({ path: 'src/win/a.ts' });
  });

  it('refuses anything outside it', () => {
    expect(safeRelativePath('../secrets')).toHaveProperty('error');
    expect(safeRelativePath('/etc/passwd', '/repo')).toHaveProperty('error');
    expect(safeRelativePath('C:/Windows/x')).toHaveProperty('error');
    expect(safeRelativePath('.')).toHaveProperty('error');
  });
});
