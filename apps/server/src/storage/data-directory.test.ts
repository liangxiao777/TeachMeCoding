import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { dataDirectory, openDataDirectory } from './data-directory.js';
import { migrate, migrations, openDatabase } from './database.js';

test('data root configuration and instance lock are independent of source/cwd and close is idempotent', () => {
  assert.equal(dataDirectory({}), join(homedir(), '.teach-me-coding'));
  assert.equal(dataDirectory({ TMC_DATA_DIR: '/tmp/tmc-test' }), '/tmp/tmc-test');
  assert.throws(() => dataDirectory({ TMC_DATA_DIR: './relative' }), /absolute/);
  assert.throws(() => dataDirectory({ TMC_DATA_DIR: '' }), /absolute/);
  const root = mkdtempSync(join(tmpdir(), 'tmc-data-'));
  try {
    const first = openDataDirectory(root);
    try { assert.throws(() => openDataDirectory(root), /already in use/); }
    finally { first.close(); first.close(); }
    const second = openDataDirectory(root); second.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('versioned migrations preserve existing data and roll back failed schema and version together', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-migration-'));
  const path = join(root, 'app.db');
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE prior_data(value TEXT); INSERT INTO prior_data VALUES ('keep this exact value')");
    migrate(db);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.throws(() => migrate(db, [...migrations, "CREATE TABLE partial(value TEXT); INSERT INTO missing VALUES (1)"]), /migration 2 failed.*preserved/);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM prior_data').all(), [{ value: 'keep this exact value' }]);
    migrate(db, [...migrations, 'CREATE INDEX space_names ON spaces(name)']);
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    assert.deepEqual(db.prepare('SELECT * FROM prior_data').all(), [{ value: 'keep this exact value' }]);
  } finally { db.close(); }
  try {
    const before = readFileSync(path);
    assert.throws(() => openDatabase(path), /newer application/);
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed databases and linked data files fail without replacement and release the startup lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-invalid-data-'));
  try {
    const bytes = Buffer.from('this is valuable non-sqlite test data');
    writeFileSync(join(root, 'app.db'), bytes);
    assert.throws(() => openDataDirectory(root), /not a database/);
    assert.deepEqual(readFileSync(join(root, 'app.db')), bytes);
    rmSync(join(root, 'app.db'));
    const data = openDataDirectory(root); data.close();
    rmSync(join(root, 'app.db'));
    writeFileSync(join(root, 'outside'), 'do not touch');
    symlinkSync(join(root, 'outside'), join(root, 'app.db'));
    assert.throws(() => openDataDirectory(root), /not links/);
    assert.equal(readFileSync(join(root, 'outside'), 'utf8'), 'do not touch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
