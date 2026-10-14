import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// Execute the repository's actual conditional UPDATE against SQLite rather
// than a mock that cannot detect the actor-wait replacement race.
const nativeSource = readFileSync(new URL('./repository.native.ts', import.meta.url), 'utf8');
const checkpointSql = nativeSource.match(
  /`(UPDATE local_pending_bookmarks SET payload = \?[\s\S]*?AND payload = \?)`/,
)?.[1];
assert.ok(checkpointSql, 'native repository must provide a conditional payload update');

test('native payload checkpoint cannot overwrite a mutation that wins the actor queue', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE local_pending_bookmarks (
      local_id TEXT PRIMARY KEY, operation TEXT, updated_at TEXT, payload TEXT,
      retry_count INTEGER, last_error TEXT, changes TEXT
    )`);
    const before = JSON.stringify({ title: 'old draft', notes: 'preserve' });
    const next = JSON.stringify({ title: 'upload attempt', notes: 'preserve' });
    const insert = db.prepare('INSERT OR REPLACE INTO local_pending_bookmarks VALUES (?, ?, ?, ?, ?, ?, ?)');
    const checkpoint = db.prepare(checkpointSql);
    insert.run('id', 'create', 'version-1', before, 4, 'DNS failure', 'audit');
    assert.equal(checkpoint.run(next, 'id', 'version-1', before).changes, 1);
    assert.deepEqual({ ...db.prepare('SELECT * FROM local_pending_bookmarks').get() }, {
      local_id: 'id', operation: 'create', updated_at: 'version-1', payload: next,
      retry_count: 4, last_error: 'DNS failure', changes: 'audit',
    });
    assert.equal(checkpoint.run(before, 'id', 'version-1', before).changes, 0);
    insert.run('id', 'create', 'version-2', before, 0, null, 'new edit');
    assert.equal(checkpoint.run(next, 'id', 'version-1', before).changes, 0);
    for (const operation of ['update', 'delete']) {
      // These commands may have committed while checkpoint waited on the actor.
      insert.run('id', operation, 'version-1', before, 0, null, 'new mutation');
      assert.equal(checkpoint.run(next, 'id', 'version-1', before).changes, 0);
      assert.equal(db.prepare('SELECT operation FROM local_pending_bookmarks').get()?.operation, operation);
    }
    db.exec('DELETE FROM local_pending_bookmarks');
    assert.equal(checkpoint.run(next, 'id', 'version-1', before).changes, 0);
  } finally {
    db.close();
  }
});
