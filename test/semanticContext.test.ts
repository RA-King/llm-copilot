import { selectNamesToResolve, typeNames, renderSemanticForPrompt, emptySemanticContext } from '../src/semanticContext';
import { extractSurroundingContext } from '../src/signatureExtractor';
import { makeDocument, pos } from './helpers';

const doc = (text: string, lang = 'typescript') => makeDocument(text, lang) as any;

describe('typeNames', () => {
  it('pulls the named types out of a generic type expression', () => {
    expect(typeNames('Map<string, OrderLine[]>')).toEqual(['Map', 'OrderLine']);
  });

  it('drops primitives', () => {
    expect(typeNames('number')).toEqual([]);
    expect(typeNames('Promise<void>')).toEqual(['Promise']);
  });

  it('handles an empty type', () => {
    expect(typeNames('')).toEqual([]);
  });
});

describe('selectNamesToResolve', () => {
  const src = [
    'import { OrderRepository } from "./repo";',
    '',
    'export class OrderService {',
    '  private readonly repo: OrderRepository;',
    '',
    '  async total(orderId: string): Promise<Money> {',
    '    ',
    '  }',
    '}',
  ].join('\n');
  const ctx = extractSurroundingContext(doc(src), pos(6, 4));

  it('prioritises the return type and the enclosing types', () => {
    const names = selectNamesToResolve(ctx, '');
    expect(names).toContain('Money');
    expect(names).toContain('OrderRepository');
    expect(names).not.toContain('string');
  });

  it('ranks the receiver of a member access being typed above everything else', () => {
    const names = selectNamesToResolve(ctx, '    const lines = this.repo.');
    expect(names[0]).toBe('repo');
  });

  it('returns nothing surprising for an empty context', () => {
    const empty = extractSurroundingContext(doc(''), pos(0, 0));
    expect(selectNamesToResolve(empty, '')).toEqual([]);
  });
});

describe('renderSemanticForPrompt', () => {
  it('renders nothing for an empty context', () => {
    expect(renderSemanticForPrompt(emptySemanticContext())).toBe('');
  });

  it('renders resolved declarations, scope and diagnostics', () => {
    const sem = emptySemanticContext();
    sem.symbolPath = 'OrderService.total';
    sem.enclosingDetail = 'method total(orderId: string): Promise<Money>';
    sem.symbolsInScope = [{ name: 'repo', kind: 'field', detail: 'OrderRepository' }];
    sem.declarations = [{ file: 'src/repo.ts', symbol: 'OrderRepository', code: 'interface OrderRepository {\n  find(id: string): Promise<Order>;\n}' }];
    sem.nearbyDiagnostics = ['line 12: Cannot find name "foo"'];
    sem.activeSignature = 'find(id: string): Promise<Order>   (currently filling: id)';

    const out = renderSemanticForPrompt(sem);
    expect(out).toContain('OrderService.total');
    expect(out).toContain('Promise<Money>');
    expect(out).toContain('repo (field) OrderRepository');
    expect(out).toContain('src/repo.ts');
    expect(out).toContain('find(id: string): Promise<Order>;');
    expect(out).toContain('currently filling: id');
    expect(out).toContain('Cannot find name');
  });
});

// ─── Latency behaviour ────────────────────────────────────────────────────────

import { gatherSemanticContext, effectiveBudget, hasLanguageServer, __resetSemanticHealth } from '../src/semanticContext';
import { __setCommand, __resetCommands, Position } from './__mocks__/vscode';

function vscodeDoc(text: string, uri = 'file:///a.ts') {
  const d: any = makeDocument(text);
  d.uri = { toString: () => uri, fsPath: uri.replace('file://', '') };
  d.fileName = uri.replace('file://', '');
  return d;
}

const SRC = 'class A {\n  run(id: string): number {\n    \n  }\n}';
const surrounding = () => extractSurroundingContext(vscodeDoc(SRC), pos(2, 4));

describe('language-server health tracking', () => {
  beforeEach(() => { __resetSemanticHealth(); __resetCommands(); });
  afterEach(() => __resetCommands());

  it('uses the configured ceiling before anything is known', () => {
    expect(effectiveBudget('typescript', 600)).toBe(600);
  });

  it('adapts the timeout down to the observed latency', async () => {
    __setCommand('vscode.executeCompletionItemProvider', async () => ({
      items: [{ label: 'repo', kind: 4, detail: 'Repo' }],
    }));

    const doc = vscodeDoc(SRC);
    await gatherSemanticContext(doc, new Position(2, 4) as any, surrounding(), '    ', undefined, { budgetMs: 600 });

    // A server that answers in ~1ms should not still be given 600ms to reply.
    expect(effectiveBudget('typescript', 600)).toBeLessThan(600);
    expect(effectiveBudget('typescript', 600)).toBeGreaterThanOrEqual(150);
    expect(hasLanguageServer('typescript')).toBe(true);
  });

  it('stops paying for a language with no server after repeated empty answers', async () => {
    // No commands registered — every provider returns undefined.
    const doc = vscodeDoc(SRC, 'file:///a.xyz');
    doc.languageId = 'nolang';

    for (let i = 0; i < 3; i++) {
      await gatherSemanticContext(doc, new Position(2, 4) as any, surrounding(), '', undefined, { budgetMs: 300 });
    }

    // Cooled down: the next completion skips the language server entirely.
    expect(effectiveBudget('nolang', 300)).toBe(0);
    expect(hasLanguageServer('nolang')).toBe(false);

    const ctx = await gatherSemanticContext(doc, new Position(2, 4) as any, surrounding(), '', undefined, { budgetMs: 300 });
    expect(ctx.languageServerAvailable).toBe(false);
    expect(ctx.symbolsInScope).toEqual([]);
  });

  it('returns immediately when the token is already cancelled', async () => {
    const doc = vscodeDoc(SRC);
    const t0 = Date.now();
    const ctx = await gatherSemanticContext(
      doc, new Position(2, 4) as any, surrounding(), '',
      { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) } as any,
      { budgetMs: 600 }
    );
    expect(Date.now() - t0).toBeLessThan(20);
    expect(ctx.languageServerAvailable).toBe(false);
  });

  it('honours the budget when a provider hangs', async () => {
    __setCommand('vscode.executeCompletionItemProvider',
      () => new Promise(() => { /* never resolves */ }));
    __setCommand('vscode.executeDocumentSymbolProvider',
      () => new Promise(() => { /* never resolves */ }));

    const doc = vscodeDoc(SRC);
    const t0 = Date.now();
    await gatherSemanticContext(doc, new Position(2, 4) as any, surrounding(), '', undefined, { budgetMs: 300 });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(500);
  });
});
