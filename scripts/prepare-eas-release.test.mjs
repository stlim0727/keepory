// scripts/prepare-eas-release.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSemVer,
  compareSemVer,
  collectKnownVersions,
  resolveVersionWithGuard,
  formatPlayStoreReleaseNotes,
} from './prepare-eas-release.mjs';

test('parseSemVer: parses standard and prerelease versions', () => {
  assert.deepEqual(parseSemVer('1.2.5'), {
    raw: '1.2.5',
    major: 1,
    minor: 2,
    patch: 5,
    prerelease: null,
  });

  assert.deepEqual(parseSemVer('v1.2.5-rc1'), {
    raw: '1.2.5-rc1',
    major: 1,
    minor: 2,
    patch: 5,
    prerelease: 'rc1',
  });

  assert.equal(parseSemVer('invalid-version'), null);
  assert.equal(parseSemVer(''), null);
});

test('compareSemVer: compares versions correctly', () => {
  assert.equal(compareSemVer('1.2.5', '1.2.4'), 1);
  assert.equal(compareSemVer('1.2.4', '1.2.5'), -1);
  assert.equal(compareSemVer('1.2.5', '1.2.5'), 0);

  // Stable releases are greater than prereleases
  assert.equal(compareSemVer('1.2.5', '1.2.5-rc1'), 1);
  assert.equal(compareSemVer('1.2.5-rc1', '1.2.5'), -1);

  // Prereleases compared numerically
  assert.equal(compareSemVer('1.2.5-rc2', '1.2.5-rc1'), 1);
  assert.equal(compareSemVer('1.2.5-rc10', '1.2.5-rc2'), 1);
  assert.equal(compareSemVer('1.2.5-rc2', '1.2.5-rc10'), -1);

  // Major and minor differences
  assert.equal(compareSemVer('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemVer('1.3.0', '1.2.9'), 1);
});

test('collectKnownVersions: aggregates and sorts all sources', () => {
  const result = collectKnownVersions({
    gitTags: ['v1.2.3', 'v1.2.5', 'invalid-tag'],
    githubReleases: ['v1.2.0', 'v1.2.4'],
    appVersion: '1.2.4',
    devReleaseBody: 'rc-state: v1.2.5-rc2\nrun-id: 1234',
  });

  assert.deepEqual(result, ['1.2.0', '1.2.3', '1.2.4', '1.2.5-rc2', '1.2.5']);
});

test('resolveVersionWithGuard: auto-resolves to latest known version when input is blank', () => {
  const result = resolveVersionWithGuard({
    inputVersion: '',
    appVersion: '1.2.4',
    knownVersions: ['1.2.3', '1.2.5'],
  });

  assert.equal(result.version, '1.2.5');
  assert.equal(result.isAutoResolved, true);
  assert.equal(result.latestKnown, '1.2.5');
});

test('resolveVersionWithGuard: auto-resolves to app.json version if higher than known releases', () => {
  const result = resolveVersionWithGuard({
    inputVersion: '',
    appVersion: '1.3.0',
    knownVersions: ['1.2.5'],
  });

  assert.equal(result.version, '1.3.0');
  assert.equal(result.isAutoResolved, true);
});

test('resolveVersionWithGuard: accepts valid version >= latest known version', () => {
  const result = resolveVersionWithGuard({
    inputVersion: 'v1.2.5',
    appVersion: '1.2.4',
    knownVersions: ['1.2.4', '1.2.5'],
  });

  assert.equal(result.version, '1.2.5');
  assert.equal(result.isAutoResolved, false);

  const higherResult = resolveVersionWithGuard({
    inputVersion: '1.2.6',
    appVersion: '1.2.4',
    knownVersions: ['1.2.5'],
  });
  assert.equal(higherResult.version, '1.2.6');
});

test('resolveVersionWithGuard: rejects version lower than latest known version (version regression)', () => {
  assert.throws(
    () => {
      resolveVersionWithGuard({
        inputVersion: '1.2.4',
        appVersion: '1.2.4',
        knownVersions: ['1.2.5'],
      });
    },
    {
      name: 'Error',
      message: /Version regression rejected! Requested version '1.2.4' is lower than latest known released\/built version '1.2.5'/,
    }
  );
});

test('formatPlayStoreReleaseNotes: formats markdown into bullet items within 500 chars', () => {
  const markdown = `
# v1.2.5

## Highlights

- [ ] Tap preview image to open external browser [link](https://example.com)
- [x] Streamlined **Card View** and \`List View\` modes
- Normal bullet item with important feature

## Fixes

- [ ] Android 15 startup crash fix
`;

  const notes = formatPlayStoreReleaseNotes({ rawMarkdown: markdown, maxLength: 500 });
  assert.ok(notes.includes('• Tap preview image to open external browser link'));
  assert.ok(notes.includes('• Streamlined Card View and List View modes'));
  assert.ok(notes.includes('• Normal bullet item with important feature'));
  assert.ok(notes.includes('• Android 15 startup crash fix'));
  assert.ok(notes.length <= 500);
});

test('formatPlayStoreReleaseNotes: falls back to git commits when markdown has no items', () => {
  const commits = [
    'abc1234 feat: add preview image quick-open (#560)',
    'def5678 fix: resolve inbox search header collapse (#561)',
    '7890abc chore: update dependencies',
  ];

  const notes = formatPlayStoreReleaseNotes({ rawMarkdown: '', gitCommits: commits, maxLength: 500 });
  assert.ok(notes.includes('• feat: add preview image quick-open'));
  assert.ok(notes.includes('• fix: resolve inbox search header collapse'));
  assert.ok(!notes.includes('chore:'));
  assert.ok(notes.length <= 500);
});

test('formatPlayStoreReleaseNotes: falls back to default text when empty', () => {
  const notes = formatPlayStoreReleaseNotes({ rawMarkdown: '', gitCommits: [], maxLength: 500 });
  assert.ok(notes.includes('• 앱 안정성 향상 및 버그 수정'));
  assert.ok(notes.length <= 500);
});
