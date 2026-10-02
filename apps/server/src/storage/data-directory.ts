import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './database.js';

export function dataDirectory(environment: NodeJS.ProcessEnv = process.env) {
  const root = environment.TMC_DATA_DIR ?? join(homedir(), '.teach-me-coding');
  if (!isAbsolute(root)) throw new Error('TMC_DATA_DIR must be an absolute path outside the source checkout.');
  return root;
}

export function openDataDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = realpathSync(directory);
  for (const name of ['app.db', 'app.db-wal', 'app.db-shm', 'app.db-journal', 'app.lock', 'app.lock-journal']) {
    const info = lstatSync(join(root, name), { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('Data files must be regular files, not links.');
  }
  // A separate SQLite exclusive lock is released by the OS even after SIGKILL.
  // It covers migrations and the full lifetime, not just individual app.db writes.
  const lock = new Database(join(root, 'app.lock'), { timeout: 0 });
  try { lock.exec('BEGIN EXCLUSIVE'); }
  catch { lock.close(); throw new Error('Data directory is already in use. Stop the other instance or choose another TMC_DATA_DIR.'); }
  try {
    const db = openDatabase(join(root, 'app.db'));
    let closed = false;
    return { root, db, close() {
      if (closed) return;
      closed = true;
      try { db.close(); } finally { lock.close(); }
    } };
  } catch (error) { lock.close(); throw error; }
}
