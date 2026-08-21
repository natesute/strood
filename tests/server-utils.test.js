import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeName, safeFile, versionOf } from '../src/server-utils.js';

describe('local file boundaries', () => {
  const root = path.resolve('/workspace/strood/songs');

  it('accepts readable song names', () => {
    expect(isSafeName('ms jackson')).toBe(true);
    expect(isSafeName('acid-bass_2')).toBe(true);
    expect(safeFile(root, 'ms jackson', '.strudel')).toBe(path.join(root, 'ms jackson.strudel'));
  });

  it('rejects traversal and sibling-prefix paths', () => {
    expect(safeFile(root, '../songs-backup/demo', '.strudel')).toBeNull();
    expect(safeFile(root, '../../outside', '.strudel')).toBeNull();
    expect(safeFile(root, '/absolute', '.strudel')).toBeNull();
    expect(safeFile(root, 'bad/name', '.strudel')).toBeNull();
  });

  it('produces stable content versions', () => {
    expect(versionOf('same')).toBe(versionOf('same'));
    expect(versionOf('same')).not.toBe(versionOf('different'));
  });
});
