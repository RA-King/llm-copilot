import { parseSolutions } from '../src/errorAssist';

describe('parseSolutions', () => {
  it('reads the numbered list the prompt asks for', () => {
    const reply = [
      '1. Guard the basket before totalling',
      '   `basket` is undefined when the cart is empty, so `.items` throws.',
      '   Return 0 early when there is nothing in it.',
      '2. Load the basket before calling total',
      '   The fetch on line 30 is not awaited, so total runs on a promise.',
    ].join('\n');

    expect(parseSolutions(reply)).toEqual([
      {
        title: 'Guard the basket before totalling',
        detail: 'basket is undefined when the cart is empty, so .items throws. Return 0 early when there is nothing in it.',
      },
      {
        title: 'Load the basket before calling total',
        detail: 'The fetch on line 30 is not awaited, so total runs on a promise.',
      },
    ]);
  });

  it('reads bullets and bolded headings, which models produce anyway', () => {
    const reply = [
      '- **Await the fetch**',
      '  The call returns a promise.',
      '* Check the config path',
      '  The file is read relative to the process cwd.',
      '**Rebuild the native module**',
      'The binary was built for another node version.',
    ].join('\n');

    expect(parseSolutions(reply).map(s => s.title)).toEqual([
      'Await the fetch', 'Check the config path', 'Rebuild the native module',
    ]);
  });

  it('reads a "Fix 1:" style list', () => {
    const reply = 'Fix 1: Pin the dependency\nIt resolved to a new major.\nFix 2: Clear the cache';
    expect(parseSolutions(reply).map(s => s.title)).toEqual(['Pin the dependency', 'Clear the cache']);
  });

  it('moves the tail of an over-long title into the detail', () => {
    const reply =
      '1. The basket is undefined because the fetch on line 30 is never awaited. ' +
      'Add await, or return early when the cart is empty.';

    const [solution] = parseSolutions(reply);
    expect(solution.title).toBe('The basket is undefined because the fetch on line 30 is never awaited');
    expect(solution.detail).toContain('Add await');
    expect(solution.title.length).toBeLessThanOrEqual(80);
  });

  it('skips code fences, which belong in the answer rather than the list', () => {
    const reply = [
      '1. Await the fetch',
      '```ts',
      'const basket = await load();',
      '```',
      '2. Return early',
    ].join('\n');

    expect(parseSolutions(reply).map(s => s.title)).toEqual(['Await the fetch', 'Return early']);
  });

  it('honours the limit it is given', () => {
    const reply = ['1. One', '2. Two', '3. Three', '4. Four'].join('\n');
    expect(parseSolutions(reply, 2)).toHaveLength(2);
  });

  it('returns nothing for a reply with no list in it', () => {
    expect(parseSolutions('')).toEqual([]);
    expect(parseSolutions('I could not work out what went wrong.')).toEqual([]);
  });
});
