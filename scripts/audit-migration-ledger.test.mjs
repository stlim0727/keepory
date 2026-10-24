import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditMigrationLedger } from './audit-migration-ledger.mjs';

const file = (name, sql) => ({ name, sql });
const row = (version, name, sql) => ({ version, name, statements: [sql] });

test('exact slugs distinguish api_keys from revoke_all_api_keys and expose every duplicate candidate', () => {
  const result = auditMigrationLedger([row('9', 'api_keys', 'select 1;')], [
    file('1_api_keys.sql', 'select 1;'), file('2_api_keys.sql', 'select 2;'),
    file('3_revoke_all_api_keys.sql', 'select 1;'),
  ]);
  assert.equal(result.orphanVersionCount, 1);
  assert.equal(result.contentMatchedRows, 1);
  assert.deepEqual(result.rows[0].candidates.map((item) => item.contentMatches), [true, false]);
  assert.equal(result.rows[0].candidates.length, 2);
});

test('same version is not proof of matching name or SQL and misnamed rows remain unmatched', () => {
  const result = auditMigrationLedger([row('1', 'wrong_slug', 'select 1;')], [file('1_expected.sql', 'select 1;')]);
  assert.equal(result.orphanVersionCount, 0);
  assert.equal(result.noSlugCandidateRows, 1);
  assert.equal(result.contentMatchedRows, 0);
});

test('outer whitespace/final semicolon are ignored but literal content changes are preserved', () => {
  const result = auditMigrationLedger([row('9', 'a', " select 'a b';\n")], [
    file('1_a.sql', "select 'a b'"), file('2_a.sql', "select 'ab';"),
  ]);
  assert.deepEqual(result.rows[0].candidates.map((item) => item.contentMatches), [true, false]);
  assert.doesNotMatch(JSON.stringify(result), /select /);
});

test('malformed/incomplete snapshots and duplicate versions fail closed', () => {
  for (const ledger of [null, {}, [{ version: '1', name: 'a' }], [row('1', 'a', '')],
    [row('1', 'a', 'select 1'), row('1', 'b', 'select 2')]]) {
    assert.throws(() => auditMigrationLedger(ledger, []));
  }
  assert.throws(() => auditMigrationLedger([], [file('1_a.sql', 'select 1'), file('1_b.sql', 'select 2')]));
});
