import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/line-diff.js';

describe('saved-song line differences', () => {
  it('shows additions and removals with their original line numbers', () => {
    expect(diffLines('alpha\nbeta\ngamma', 'alpha\nchanged\ngamma')).toEqual([
      { type: 'same', text: 'alpha', oldLine: 1, newLine: 1 },
      { type: 'remove', text: 'beta', oldLine: 2, newLine: null },
      { type: 'add', text: 'changed', oldLine: null, newLine: 2 },
      { type: 'same', text: 'gamma', oldLine: 3, newLine: 3 },
    ]);
  });

  it('collapses distant unchanged sections while retaining nearby context', () => {
    const saved = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const current = [...saved];
    current[1] = 'first change';
    current[10] = 'second change';
    const result = diffLines(saved.join('\n'), current.join('\n'), { context: 1 });

    expect(result.filter(({ type }) => type === 'skip')).toEqual([{ type: 'skip', count: 6 }]);
    expect(result.filter(({ type }) => type === 'remove').map(({ oldLine }) => oldLine)).toEqual([2, 11]);
    expect(result.filter(({ type }) => type === 'add').map(({ newLine }) => newLine)).toEqual([2, 11]);
  });

  it('returns no rows when the current song matches the saved copy', () => {
    expect(diffLines('same\nsource', 'same\nsource')).toEqual([]);
  });

  it('keeps line numbers correct on the large-input fallback path', () => {
    const saved = Array.from({ length: 1300 }, (_, index) => `line ${index + 1}`);
    const current = [...saved];
    current[700] = 'changed middle';
    const result = diffLines(saved.join('\n'), current.join('\n'), { context: 1 });

    expect(result.filter(({ type }) => type === 'remove')).toEqual([
      { type: 'remove', text: 'line 701', oldLine: 701, newLine: null },
    ]);
    expect(result.filter(({ type }) => type === 'add')).toEqual([
      { type: 'add', text: 'changed middle', oldLine: null, newLine: 701 },
    ]);
    expect(result.filter(({ type }) => type === 'same').map(({ oldLine }) => oldLine)).toEqual([700, 702]);
  });
});
