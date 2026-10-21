import {
  parseFrontMatter, splitGlobs, globToRegExp, appliesTo, composeInstructions, InstructionFile,
} from '../src/customInstructions';

describe('parseFrontMatter', () => {
  it('splits the header from the body', () => {
    const { fields, body } = parseFrontMatter('---\napplyTo: "**/*.ts"\ndescription: Types\n---\nUse strict types.\n');
    expect(fields).toEqual({ applyTo: '**/*.ts', description: 'Types' });
    expect(body).toBe('Use strict types.');
  });

  it('treats a file without a header as all body', () => {
    expect(parseFrontMatter('Just text\r\n').body).toBe('Just text');
  });
});

describe('globs', () => {
  it('splits a comma-separated applyTo', () => {
    expect(splitGlobs('"**/*.ts", src/**')).toEqual(['**/*.ts', 'src/**']);
    expect(splitGlobs(undefined)).toEqual([]);
  });

  it('matches across directories only with **', () => {
    expect(globToRegExp('**/*.ts').test('a/b/c.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('c.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('**/*.{js,jsx}').test('app/x.jsx')).toBe(true);
  });
});

describe('composeInstructions', () => {
  const files: InstructionFile[] = [
    { source: '.github/instructions/py.instructions.md', applyTo: ['**/*.py'], body: 'Use type hints.' },
    { source: '.github/copilot-instructions.md', applyTo: [], body: 'Prefer small functions.' },
  ];

  it('puts unconditional instructions first and keeps scoped ones to their files', () => {
    const forPython = composeInstructions(files, 'app/main.py');
    expect(forPython.indexOf('Prefer small functions.')).toBeLessThan(forPython.indexOf('Use type hints.'));
    expect(composeInstructions(files, 'app/main.ts')).not.toContain('type hints');
  });

  it('applies scoped instructions to nothing when there is no file', () => {
    expect(appliesTo(files[0], undefined)).toBe(false);
    expect(composeInstructions(files, undefined)).toContain('Prefer small functions.');
  });

  it('is empty when nothing applies', () => {
    expect(composeInstructions([], 'a.ts')).toBe('');
  });
});
