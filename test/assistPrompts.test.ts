import {
  buildDiagnosticFixPrompt, extractCodeBlock, buildTerminalCommandPrompt, parseTerminalSuggestion, buildPullRequestPrompt,
} from '../src/assistPrompts';

describe('buildDiagnosticFixPrompt', () => {
  it('names the line range to return and numbers the code', () => {
    const msgs = buildDiagnosticFixPrompt({
      language: 'typescript', file: 'src/a.ts', problems: ['line 5: Cannot find name x'],
      firstLine: 4, code: 'const a = 1;\nreturn x;', declarations: '// Declarations found elsewhere',
    });
    expect(msgs[0].content).toContain('lines 4–5');
    expect(msgs[1].content).toContain('5 | return x;');
    expect(msgs[1].content).toContain('Cannot find name x');
    expect(msgs[1].content).toContain('Declarations found elsewhere');
  });
});

describe('extractCodeBlock', () => {
  it('takes the first fenced block', () => {
    expect(extractCodeBlock('Here:\n```ts\nconst a = 1;\n```\nmore')).toBe('const a = 1;');
  });

  it('takes the whole reply when there is no fence', () => {
    expect(extractCodeBlock('const a = 1;\n\n')).toBe('const a = 1;');
  });
});

describe('terminal suggestions', () => {
  it('states the shell and platform', () => {
    const msgs = buildTerminalCommandPrompt('list ports', 'zsh', 'macOS', '/repo');
    expect(msgs[0].content).toContain('zsh command for macOS');
    expect(msgs[0].content).toContain('/repo');
  });

  it('reads a fenced command and its explanation', () => {
    expect(parseTerminalSuggestion('```bash\n$ lsof -i :3000\n```\nShows what listens on port 3000.')).toEqual({
      command: 'lsof -i :3000', explanation: 'Shows what listens on port 3000.',
    });
  });

  it('falls back to the first line', () => {
    expect(parseTerminalSuggestion('du -sh * | sort -h\nSizes, smallest first.').command).toBe('du -sh * | sort -h');
  });
});

describe('buildPullRequestPrompt', () => {
  it('includes the commits and truncates a long diff', () => {
    const msgs = buildPullRequestPrompt(
      { branch: 'feature', base: 'origin/main', log: 'Add retry', stat: ' a.ts | 2 +-', diff: 'x'.repeat(50) }, 10);
    expect(msgs[1].content).toContain('Branch feature into origin/main');
    expect(msgs[1].content).toContain('Add retry');
    expect(msgs[1].content).toContain('(diff truncated)');
  });
});
