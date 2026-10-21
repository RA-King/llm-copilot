import { EditHistory, TextChange } from '../src/editHistory';

/** A change replacing `find` (first occurrence) in the history's current text. */
function replace(history: EditHistory, find: string, text: string): TextChange {
  const rangeOffset = history.current.indexOf(find);
  if (rangeOffset < 0) { throw new Error(`no ${find}`); }
  return { rangeOffset, rangeLength: find.length, text };
}

function typeAt(history: EditHistory, offset: number, chars: string): void {
  for (const ch of chars) {
    history.apply([{ rangeOffset: offset, rangeLength: 0, text: ch }]);
    offset++;
  }
}

describe('EditHistory', () => {
  const source = 'function load(user) {\n  return fetch(user.id);\n}\n\nsave(user);\n';

  it('records a change as whole before and after lines', () => {
    const h = new EditHistory();
    h.reset(source);
    h.apply([replace(h, 'load(user)', 'load(account)')]);
    expect(h.edits()).toEqual([
      { startLine: 0, before: ['function load(user) {'], after: ['function load(account) {'] },
    ]);
  });

  it('merges keystrokes in the same place into one edit', () => {
    const h = new EditHistory();
    h.reset('const a = 1;\n');
    typeAt(h, 12, ' // one');
    expect(h.edits()).toHaveLength(1);
    expect(h.edits()[0].after).toEqual(['const a = 1; // one']);
  });

  it('forgets an edit that was typed and then deleted', () => {
    const h = new EditHistory();
    h.reset('x\n');
    h.apply([{ rangeOffset: 1, rangeLength: 0, text: 'yz' }]);
    h.apply([{ rangeOffset: 1, rangeLength: 2, text: '' }]);
    expect(h.edits()).toEqual([]);
  });

  it('keeps separate places separate and renders only what changed', () => {
    const h = new EditHistory();
    h.reset(source);
    h.apply([replace(h, 'load(user)', 'load(account)')]);
    h.apply([replace(h, 'save(user)', 'save(account)')]);
    expect(h.render()).toBe([
      '@@ line 1', '- function load(user) {', '+ function load(account) {',
      '@@ line 5', '- save(user);', '+ save(account);',
    ].join('\n'));
  });

  it('merges an edit on the adjacent line into the previous one', () => {
    const h = new EditHistory();
    h.reset('a\nb\nc\n');
    h.apply([replace(h, 'a', 'A')]);
    h.apply([replace(h, 'b', 'B')]);
    expect(h.edits()).toEqual([{ startLine: 0, before: ['a', 'b'], after: ['A', 'B'] }]);
  });

  it('moves older edits down when lines are inserted above them', () => {
    const h = new EditHistory();
    h.reset('one\ntwo\nthree\nfour\nfive\n');
    h.apply([replace(h, 'five', 'FIVE')]);
    h.apply([{ rangeOffset: 0, rangeLength: 0, text: 'zero\n' }]);
    const five = h.edits().find(e => e.after[0] === 'FIVE');
    expect(five?.startLine).toBe(5);
  });

  it('applies a batch of changes from the end backwards', () => {
    const h = new EditHistory();
    h.reset('aa bb aa\n');
    h.apply([
      { rangeOffset: 0, rangeLength: 2, text: 'cc' },
      { rangeOffset: 6, rangeLength: 2, text: 'cc' },
    ]);
    expect(h.current).toBe('cc bb cc\n');
  });

  it('keeps only the most recent edits', () => {
    const h = new EditHistory(2);
    h.reset('a\n\nb\n\nc\n');
    h.apply([replace(h, 'a', 'A')]);
    h.apply([replace(h, 'b', 'B')]);
    h.apply([replace(h, 'c', 'C')]);
    expect(h.edits().map(e => e.after[0])).toEqual(['B', 'C']);
  });
});
