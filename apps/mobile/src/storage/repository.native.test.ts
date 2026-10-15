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

const recoverySql = nativeSource.match(/`(INSERT OR IGNORE INTO local_pending_bookmarks[\s\S]*?WHERE EXISTS \(SELECT 1 FROM bookmarks WHERE id = \? AND data = \?\))`/)?.[1];
assert.ok(recoverySql);
test('native recovery checks exact durable row and preserves newer queue operations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE bookmarks (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE local_pending_bookmarks (local_id TEXT PRIMARY KEY, remote_id TEXT, operation TEXT,
      payload TEXT, sync_status TEXT, retry_count INTEGER, last_error TEXT, last_error_kind TEXT,
      health_escalated_at TEXT, created_at TEXT, updated_at TEXT, last_attempt_at TEXT, changes TEXT)`);
    const expected = JSON.stringify({ id: 'id', title: 'captured' });
    const recover = () => db.prepare(recoverySql).run('id', null, 'create', '{}', 'pending', 0,
      null, null, null, 'created', 'updated', null, null, 'id', expected).changes;
    assert.equal(recover(), 0);
    db.prepare('INSERT INTO bookmarks VALUES (?, ?)').run('id', expected);
    assert.equal(recover(), 1);
    for (const operation of ['create', 'update', 'delete']) {
      db.prepare('UPDATE local_pending_bookmarks SET operation = ?, updated_at = ?').run(operation, 'newer');
      assert.equal(recover(), 0);
      assert.equal(db.prepare('SELECT updated_at FROM local_pending_bookmarks').get()?.updated_at, 'newer');
      assert.equal(db.prepare('SELECT operation FROM local_pending_bookmarks').get()?.operation, operation);
    }
    db.exec('DELETE FROM local_pending_bookmarks');
    db.prepare('UPDATE bookmarks SET data = ?').run(JSON.stringify({ id: 'id', title: 'edited' }));
    assert.equal(recover(), 0);
    db.exec('DELETE FROM bookmarks');
    assert.equal(recover(), 0);
  } finally { db.close(); }
});

const retirementSql = nativeSource.match(
  /`(DELETE FROM local_pending_bookmarks\s+WHERE local_id = \? AND operation = \? AND updated_at = \? AND payload = \?)`/,
)?.[1];
assert.ok(retirementSql, 'native repository must retire the expected version atomically');

test('native retirement preserves newer work committed ahead of it on the actor', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE local_pending_bookmarks (
      local_id TEXT PRIMARY KEY, operation TEXT, updated_at TEXT, payload TEXT
    )`);
    const insert = db.prepare('INSERT OR REPLACE INTO local_pending_bookmarks VALUES (?, ?, ?, ?)');
    const retire = db.prepare(retirementSql);
    for (const operation of ['create', 'update', 'delete']) {
      for (const replacement of ['create', 'update', 'delete']) {
        insert.run('id', replacement, 'version-2', 'new payload');
        assert.equal(retire.run('id', operation, 'version-1', 'old payload').changes, 0);
        assert.equal(db.prepare('SELECT operation FROM local_pending_bookmarks').get()?.operation, replacement);
      }
      insert.run('id', operation, 'version-1', 'same-clock edit');
      assert.equal(retire.run('id', operation, 'version-1', 'old payload').changes, 0);
      insert.run('id', operation, 'version-1', 'old payload');
      assert.equal(retire.run('id', operation, 'version-1', 'old payload').changes, 1);
      assert.equal(retire.run('id', operation, 'version-1', 'old payload').changes, 0);
    }
  } finally {
    db.close();
  }
});
