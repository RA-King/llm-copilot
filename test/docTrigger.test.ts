import {
  getCommentStyleForLang,
  formatDocComment,
  detectDeclaration,
  getPendingDocComment,
  clearPendingDocComment,
} from '../src/docTrigger';
import { makeDocument } from './helpers';

describe('getCommentStyleForLang', () => {
  it('maps known languages to their doc style', () => {
    expect(getCommentStyleForLang('typescript')).toBe('jsdoc');
    expect(getCommentStyleForLang('python')).toBe('pydoc');
    expect(getCommentStyleForLang('csharp')).toBe('xmldoc');
    expect(getCommentStyleForLang('rust')).toBe('rustdoc');
    expect(getCommentStyleForLang('go')).toBe('singleline');
    expect(getCommentStyleForLang('java')).toBe('javadoc');
  });

  it('falls back to jsdoc for unknown languages', () => {
    expect(getCommentStyleForLang('brainfuck')).toBe('jsdoc');
  });
});

describe('formatDocComment', () => {
  it('renders a jsdoc block', () => {
    const out = formatDocComment('Adds two numbers together', 'jsdoc', '', 'function');
    expect(out).toBe('/**\n * Adds two numbers together\n */');
  });

  it('renders a single-line python comment', () => {
    expect(formatDocComment('Adds numbers', 'pydoc', '', 'function')).toBe('# Adds numbers');
  });

  it('renders rustdoc /// comments', () => {
    expect(formatDocComment('Adds numbers', 'rustdoc', '', 'function')).toBe('/// Adds numbers');
  });

  it('strips comment markers the model already applied (no double markers)', () => {
    expect(formatDocComment('/// Adds numbers', 'rustdoc', '', 'function')).toBe('/// Adds numbers');
    expect(formatDocComment('// Adds numbers', 'singleline', '', 'function')).toBe('// Adds numbers');
  });

  it('applies the indentation prefix', () => {
    const out = formatDocComment('text', 'jsdoc', '  ', 'function');
    expect(out.startsWith('  /**')).toBe(true);
  });

  it('wraps prose longer than 15 words onto multiple lines', () => {
    const twentyWords = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const out = formatDocComment(twentyWords, 'jsdoc', '', 'function');
    const bodyLines = out.split('\n').filter(l => l.trimStart().startsWith('* '));
    expect(bodyLines.length).toBeGreaterThanOrEqual(2);
  });
});

describe('detectDeclaration', () => {
  it('detects a TypeScript function declaration', () => {
    const doc = makeDocument('function calculateSum(a, b) {', 'typescript');
    const decl = detectDeclaration(doc as any, 0);
    expect(decl).not.toBeNull();
    expect(decl!.kind).toBe('function');
    expect(decl!.name).toBe('calculateSum');
    expect(decl!.language).toBe('typescript');
  });

  it('detects an exported class declaration', () => {
    const doc = makeDocument('export class Widget {', 'typescript');
    const decl = detectDeclaration(doc as any, 0);
    expect(decl!.kind).toBe('class');
    expect(decl!.name).toBe('Widget');
  });

  it('detects a Python function and captures indentation', () => {
    const doc = makeDocument('    def process_data(items):', 'python');
    const decl = detectDeclaration(doc as any, 0);
    expect(decl!.kind).toBe('function');
    expect(decl!.name).toBe('process_data');
    expect(decl!.indentPrefix).toBe('    ');
  });

  it('returns null when nothing recognisable is on the line', () => {
    const doc = makeDocument('   ', 'typescript');
    expect(detectDeclaration(doc as any, 0)).toBeNull();
  });
});

describe('pending doc-comment state', () => {
  it('starts null and stays null after clearing', () => {
    clearPendingDocComment();
    expect(getPendingDocComment()).toBeNull();
  });
});
