/**
 * Latency behaviour of the prefetch layer.
 *
 * `semanticContext` and `workspaceContext` are mocked with controllable delays
 * so we can assert the two properties that matter: the gather overlaps the
 * debounce instead of following it, and keystrokes within a line share one
 * gather rather than each starting their own.
 */
let gatherCalls = 0;
let workspaceCalls = 0;
let gatherDelayMs = 100;
let lsAvailable = true;

jest.mock('../src/semanticContext', () => {
  const actual = jest.requireActual('../src/semanticContext');
  return {
    ...actual,
    hasLanguageServer: () => lsAvailable,
    gatherSemanticContext: jest.fn(async () => {
      gatherCalls++;
      await new Promise(r => setTimeout(r, gatherDelayMs));
      const ctx = actual.emptySemanticContext();
      ctx.symbolPath = 'A.run';
      ctx.languageServerAvailable = true;
      return ctx;
    }),
  };
});

jest.mock('../src/workspaceContext', () => ({
  gatherWorkspaceSignatures: jest.fn(async () => {
    workspaceCalls++;
    await new Promise(r => setTimeout(r, 300));
    return { context: '// sigs', sources: ['a.ts'] };
  }),
  clearWorkspaceCaches: jest.fn(),
}));

import { prepareContext, prefetchContext, clearPrefetchCache, prefetchStats, invalidateDocument } from '../src/contextPrefetch';
import { makeDocument, pos } from './helpers';

const SRC = [
  'class A {',
  '  private repo: Repo;',
  '  run(id: string): number {',
  '    const x = 1;',
  '    ',
  '  }',
  '}',
].join('\n');

function fakeDoc(text = SRC, uri = 'file:///a.ts') {
  const d: any = makeDocument(text);
  d.uri = { toString: () => uri, fsPath: uri.replace('file://', '') };
  d.fileName = uri.replace('file://', '');
  d.version = 1;
  return d;
}

const OPTS = {
  semanticEnabled: true, semanticBudgetMs: 600,
  maxSymbols: 30, maxDeclarations: 4, workspaceBudgetMs: 700,
};

beforeEach(() => {
  clearPrefetchCache();
  gatherCalls = 0;
  workspaceCalls = 0;
  gatherDelayMs = 100;
  lsAvailable = true;
});

describe('prefetch', () => {
  it('makes the context free when it overlapped the debounce', async () => {
    const doc = fakeDoc();
    gatherDelayMs = 200;

    // The debouncer warms the cache the moment its timer is set…
    prefetchContext(doc, pos(4, 4), '    ', OPTS);
    // …and the user keeps typing for the length of the debounce window.
    await new Promise(r => setTimeout(r, 250));

    // By the time the provider asks, the answer is already there.
    const t0 = Date.now();
    const ctx = await prepareContext(doc, pos(4, 4), '    ', OPTS).promise;
    const waited = Date.now() - t0;

    expect(ctx.semantic.symbolPath).toBe('A.run');
    expect(waited).toBeLessThan(30);
    expect(gatherCalls).toBe(1);
  });

  it('shares one gather across the keystrokes of a line', async () => {
    const doc = fakeDoc();
    for (const prefix of ['    c', '    co', '    con', '    cons', '    const']) {
      prefetchContext(doc, pos(4, prefix.length), prefix, OPTS);
    }
    await prepareContext(doc, pos(4, 9), '    const', OPTS).promise;
    expect(gatherCalls).toBe(1);
  });

  it('starts a new gather when the member-access receiver changes', async () => {
    const doc = fakeDoc();
    await prepareContext(doc, pos(4, 4), '    this.', OPTS).promise;
    await prepareContext(doc, pos(4, 4), '    repo.', OPTS).promise;
    expect(gatherCalls).toBe(2);
  });

  it('starts a new gather on a different line', async () => {
    const doc = fakeDoc();
    await prepareContext(doc, pos(4, 4), '    ', OPTS).promise;
    await prepareContext(doc, pos(3, 4), '    ', OPTS).promise;
    expect(gatherCalls).toBe(2);
  });

  it('reports a cache hit without re-gathering', async () => {
    const doc = fakeDoc();
    const first = prepareContext(doc, pos(4, 4), '    ', OPTS);
    expect(first.cached).toBe(false);
    await first.promise;

    const second = prepareContext(doc, pos(4, 4), '    ', OPTS);
    expect(second.cached).toBe(true);
    await second.promise;

    expect(gatherCalls).toBe(1);
    expect(prefetchStats().hits).toBe(1);
  });

  it('pairs a cached gather with freshly-read surrounding context', async () => {
    const doc = fakeDoc();
    await prepareContext(doc, pos(4, 4), '    ', OPTS).promise;

    // Same enclosing signature, but a local was added since.
    const edited = fakeDoc(SRC.replace('const x = 1;', 'const x = 1;\n    const y = 2;'));
    const ctx = await prepareContext(edited, pos(5, 4), '    ', OPTS).promise;

    expect(ctx.surrounding.bindings.map(b => b.name)).toContain('y');
    expect(ctx.semantic.symbolPath).toBe('A.run');   // resolved work was reused
  });

  it('skips the workspace sweep once a language server has answered', async () => {
    lsAvailable = true;
    await prepareContext(fakeDoc(), pos(4, 4), '    ', OPTS).promise;
    expect(workspaceCalls).toBe(0);
  });

  it('falls back to the workspace sweep when there is no language server', async () => {
    lsAvailable = false;
    await prepareContext(fakeDoc(), pos(4, 4), '    ', OPTS).promise;
    expect(workspaceCalls).toBe(1);
  });

  it('invalidates a document when it changes structurally', async () => {
    const doc = fakeDoc();
    await prepareContext(doc, pos(4, 4), '    ', OPTS).promise;
    invalidateDocument(doc.uri);
    await prepareContext(doc, pos(4, 4), '    ', OPTS).promise;
    expect(gatherCalls).toBe(2);
  });

  it('never rejects, even when the gather throws', async () => {
    const sem = require('../src/semanticContext');
    sem.gatherSemanticContext.mockImplementationOnce(async () => { throw new Error('LS died'); });
    const ctx = await prepareContext(fakeDoc(), pos(4, 4), '    ', OPTS).promise;
    expect(ctx.semantic.languageServerAvailable).toBe(false);
    expect(ctx.surrounding.enclosing?.name).toBe('run');   // source layer still works
  });
});
