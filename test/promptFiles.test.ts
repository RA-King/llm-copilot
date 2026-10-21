import { parsePromptFile, expandPromptVariables } from '../src/promptFiles';

describe('parsePromptFile', () => {
  it('names the command after the file and reads the description', () => {
    const prompt = parsePromptFile('/repo/.github/prompts/Add Endpoint.prompt.md',
      '---\ndescription: Scaffold a REST endpoint\nmode: agent\n---\nCreate an endpoint for ${input:resource}.');
    expect(prompt.name).toBe('add-endpoint');
    expect(prompt.description).toBe('Scaffold a REST endpoint');
    expect(prompt.body).toBe('Create an endpoint for ${input:resource}.');
  });

  it('falls back to the first line for a description', () => {
    expect(parsePromptFile('x.prompt.md', '# Review security\nCheck for injection.').description).toBe('Review security');
  });
});

describe('expandPromptVariables', () => {
  const vars = { selection: 'let a = 1;', file: 'src\\app\\main.ts', workspaceFolder: '/repo', input: 'orders' };

  it('fills Copilot-style variables', () => {
    const out = expandPromptVariables('${fileBasename} in ${fileDirname}: ${selection} for ${input:name:thing}', vars);
    expect(out).toBe('main.ts in src/app: let a = 1; for orders');
  });

  it('uses the input hint when nothing was typed', () => {
    expect(expandPromptVariables('Do ${input:what:the default}', { ...vars, input: '' })).toBe('Do the default');
  });

  it('appends typed text when the prompt has no input variable', () => {
    expect(expandPromptVariables('Review ${file}', vars)).toBe('Review src/app/main.ts\n\norders');
  });

  it('leaves unknown variables alone', () => {
    expect(expandPromptVariables('${nope}', { ...vars, input: '' })).toBe('${nope}');
  });
});
