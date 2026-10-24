/** Read-only #996 evidence. Never prints SQL or generates repair statements. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = (sql) => createHash('sha256').update(sql.trim().replace(/;$/, '')).digest('hex');

export function auditMigrationLedger(ledger, files) {
  if (!Array.isArray(ledger) || ledger.some((row) =>
    !row || typeof row.version !== 'string' || !/^\d+$/.test(row.version) ||
    typeof row.name !== 'string' || !row.name || !Array.isArray(row.statements) ||
    row.statements.length === 0 || row.statements.some((sql) => typeof sql !== 'string' || !sql.trim())
  )) throw new Error('Expected a nonempty SQL statement array on each versioned ledger row');
  const versions = new Set();
  const local = files.map(({ name, sql }) => {
    const match = /^(\d+)_(.+)\.sql$/.exec(name);
    if (!match || versions.has(match[1])) throw new Error(`Invalid or duplicate local version: ${name}`);
    versions.add(match[1]);
    return { file: name, version: match[1], slug: match[2], sha256: digest(sql) };
  });
  const remoteVersions = new Set();
  const rows = ledger.map((row) => {
    if (remoteVersions.has(row.version)) throw new Error(`Duplicate ledger version: ${row.version}`);
    remoteVersions.add(row.version);
    const sha256 = digest(row.statements.join('\n'));
    const candidates = local.filter((file) => file.slug === row.name);
    return {
      version: row.version,
      name: row.name,
      sha256,
      statementCount: row.statements.length,
      versionPresentLocally: versions.has(row.version),
      candidates: candidates.map((file) => ({
        file: file.file, sha256: file.sha256, contentMatches: file.sha256 === sha256,
      })),
    };
  });
  return {
    localFileCount: local.length,
    ledgerRowCount: rows.length,
    orphanVersionCount: rows.filter((row) => !row.versionPresentLocally).length,
    contentMatchedRows: rows.filter((row) => row.candidates.some((file) => file.contentMatches)).length,
    noSlugCandidateRows: rows.filter((row) => row.candidates.length === 0).length,
    // Matching hashes cover SQL text only (outer whitespace/final semicolon
    // ignored). A mismatch is not a semantic difference; neither result proves
    // current catalog state or authorizes a repair.
    rows,
  };
}

function main() {
  const snapshot = process.argv[2];
  if (!snapshot) throw new Error('Usage: node scripts/audit-migration-ledger.mjs /private/ledger-snapshot.json');
  const migrations = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const files = readdirSync(migrations).filter((name) => name.endsWith('.sql'))
    .sort().map((name) => ({ name, sql: readFileSync(path.join(migrations, name), 'utf8') }));
  const ledger = JSON.parse(readFileSync(snapshot, 'utf8'));
  console.log(JSON.stringify(auditMigrationLedger(ledger, files), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
