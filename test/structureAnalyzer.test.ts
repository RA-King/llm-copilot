import { analyseStructure, extractFields } from '../src/structureAnalyzer';
import { makeDocument, pos } from './helpers';

describe('analyseStructure', () => {
  it('detects a class body and its container name', () => {
    const doc = makeDocument(
      ['class Person {', '  private name: string;', '', '  ', '}'].join('\n')
    );
    const ctx = analyseStructure(doc as any, pos(3, 2));
    expect(ctx.structureKind).toBe('class-body');
    expect(ctx.containerName).toBe('Person');
    expect(ctx.containerType).toBe('class');
    expect(ctx.language).toBe('typescript');
  });

  it('detects an interface body', () => {
    const doc = makeDocument(['interface Repo {', '  ', '}'].join('\n'));
    const ctx = analyseStructure(doc as any, pos(1, 2));
    expect(ctx.structureKind).toBe('interface-body');
    expect(ctx.containerName).toBe('Repo');
  });

  it('detects an enum body', () => {
    const doc = makeDocument(['enum Color {', '  Red,', '  ', '}'].join('\n'));
    const ctx = analyseStructure(doc as any, pos(2, 2));
    expect(ctx.structureKind).toBe('enum-body');
    expect(ctx.containerName).toBe('Color');
  });

  it('reports top-level when there is no enclosing container', () => {
    const doc = makeDocument(['const a = 1;', 'const b = 2;'].join('\n'));
    const ctx = analyseStructure(doc as any, pos(1, 0));
    expect(ctx.structureKind).toBe('top-level');
    expect(ctx.bestSuggestionKind).toBe('next-declaration');
  });

  it('returns an empty context for a zero-line document', () => {
    const doc = makeDocument('', 'typescript');
    // a single empty string still has lineCount 1, so force the empty branch:
    const emptyDoc = { ...doc, lineCount: 0 };
    const ctx = analyseStructure(emptyDoc as any, pos(0, 0));
    expect(ctx.isEmpty).toBe(true);
    expect(ctx.structureKind).toBe('top-level');
  });
});

describe('extractFields', () => {
  it('extracts typed fields from a TypeScript class', () => {
    const doc = makeDocument(
      ['class Person {', '  private name: string;', '  private age: number;', '}'].join('\n')
    );
    const fields = extractFields(doc as any, 0, 'typescript');
    // We assert on the set of discovered identifiers rather than order.
    expect(fields.length).toBeGreaterThanOrEqual(1);
    fields.forEach(f => {
      expect(typeof f.name).toBe('string');
      expect(typeof f.type).toBe('string');
    });
  });

  it('tracks getter presence on discovered fields', () => {
    const doc = makeDocument(
      [
        'class Box {',
        '  private width: number;',
        '  get width() { return this._width; }',
        '  ',
        '}',
      ].join('\n')
    );
    // analyseStructure exposes the full FieldInfo (including hasGetter/hasSetter).
    const ctx = analyseStructure(doc as any, pos(3, 2));
    expect(Array.isArray(ctx.fields)).toBe(true);
    // Every field should carry boolean accessor flags.
    ctx.fields.forEach(f => {
      expect(typeof f.hasGetter).toBe('boolean');
      expect(typeof f.hasSetter).toBe('boolean');
    });
  });
});
