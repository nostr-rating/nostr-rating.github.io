import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { repoDataFile } from '../src/repoData.js';

const REPO = resolve('/work/repo');

describe('repoDataFile', () => {
  test('finds a file under snapshots/ and configs/', () => {
    expect(repoDataFile(REPO, '/snapshots/smash/2026-10-01.json?t=1')).toBe(join(REPO, 'snapshots/smash/2026-10-01.json'));
    expect(repoDataFile(REPO, '/configs/smash.json')).toBe(join(REPO, 'configs/smash.json'));
  });

  test('accepts the path under the base of the site', () => {
    expect(repoDataFile(REPO, '/nostr-rating/snapshots/a.json')).toBe(join(REPO, 'snapshots/a.json'));
  });

  test('ignores other paths', () => {
    expect(repoDataFile(REPO, '/index.html')).toBeNull();
    expect(repoDataFile(REPO, '/snapshotsx/a.json')).toBeNull();
  });

  test('does not climb out of snapshots/ or configs/', () => {
    expect(repoDataFile(REPO, '/snapshots/../.env')).toBeNull();
    expect(repoDataFile(REPO, '/snapshots/%2e%2e/.env')).toBeNull();
    expect(repoDataFile(REPO, '/configs/..%2f..%2frepo-other/x')).toBeNull();
    expect(repoDataFile(REPO, '/x/snapshots/../../.git/config')).toBeNull();
    expect(repoDataFile(REPO, '/snapshots/../configs/smash.json')).toBeNull();
  });

  test('ignores a broken escape', () => {
    expect(repoDataFile(REPO, '/snapshots/%E0%A4%A')).toBeNull();
  });
});
