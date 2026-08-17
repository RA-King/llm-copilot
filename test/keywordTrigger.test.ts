import { isKeywordTrigger, extractKeywordTrigger } from '../src/keywordTrigger';

describe('isKeywordTrigger', () => {
  it('recognises declaration keywords for a supported language', () => {
    expect(isKeywordTrigger('function', 'typescript')).toBe(true);
    expect(isKeywordTrigger('class', 'typescript')).toBe(true);
    expect(isKeywordTrigger('def', 'python')).toBe(true);
    expect(isKeywordTrigger('fn', 'rust')).toBe(true);
  });

  it('returns false for non-keyword tokens', () => {
    expect(isKeywordTrigger('banana', 'typescript')).toBe(false);
    expect(isKeywordTrigger('def', 'typescript')).toBe(false); // python-only keyword
  });

  it('returns false for an unknown language', () => {
    expect(isKeywordTrigger('function', 'cobol')).toBe(false);
  });

  it('trims trailing whitespace before matching', () => {
    expect(isKeywordTrigger('function ', 'typescript')).toBe(true);
    expect(isKeywordTrigger('class\t', 'typescript')).toBe(true);
  });

  it('supports single-char triggers (decorators / annotations / preprocessor)', () => {
    expect(isKeywordTrigger('@', 'python')).toBe(true);
    expect(isKeywordTrigger('@', 'java')).toBe(true);
    expect(isKeywordTrigger('#', 'rust')).toBe(true);
    expect(isKeywordTrigger('[', 'csharp')).toBe(true);
  });

  it('resolves react language aliases to their base language', () => {
    expect(isKeywordTrigger('const', 'typescriptreact')).toBe(true);
    expect(isKeywordTrigger('function', 'javascriptreact')).toBe(true);
  });
});

describe('extractKeywordTrigger', () => {
  it('returns the keyword when the line is just the keyword', () => {
    expect(extractKeywordTrigger('function', 'typescript')).toBe('function');
    expect(extractKeywordTrigger('class', 'typescript')).toBe('class');
  });

  it('honours a single trailing space or tab (user just finished the keyword)', () => {
    expect(extractKeywordTrigger('function ', 'typescript')).toBe('function');
    expect(extractKeywordTrigger('class\t', 'typescript')).toBe('class');
  });

  it('preserves leading indentation', () => {
    expect(extractKeywordTrigger('    async', 'typescript')).toBe('async');
    expect(extractKeywordTrigger('\t\tif', 'typescript')).toBe('if');
  });

  it('returns null once the user has started typing the name', () => {
    expect(extractKeywordTrigger('function foo', 'typescript')).toBeNull();
    expect(extractKeywordTrigger('class MyThing', 'typescript')).toBeNull();
  });

  it('returns null for an empty or whitespace-only line', () => {
    expect(extractKeywordTrigger('', 'typescript')).toBeNull();
    expect(extractKeywordTrigger('    ', 'typescript')).toBeNull();
  });

  it('returns null for a non-keyword first token', () => {
    expect(extractKeywordTrigger('myVariable', 'typescript')).toBeNull();
  });

  it('extracts single-char decorator triggers', () => {
    expect(extractKeywordTrigger('@', 'python')).toBe('@');
    expect(extractKeywordTrigger('  #', 'rust')).toBe('#');
  });

  it('returns null for an unknown language even with a keyword-shaped token', () => {
    expect(extractKeywordTrigger('function', 'cobol')).toBeNull();
  });
});
