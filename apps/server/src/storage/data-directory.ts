import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './database.js';

export function dataDirectory(environment: NodeJS.ProcessEnv = process.env) {
  const root = environment.TMC_DATA_DIR ?? join(homedir(), '.teach-me-coding');
  if (!isAbsolute(root)) throw new Error('TMC_DATA_DIR must be an absolute path. Keep learning data outside the source checkout.');
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
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO task_events(space_id,run_id,seq,value)
          SELECT a.space_id,a.id,COALESCE((SELECT MAX(seq) FROM task_events e WHERE e.space_id=a.space_id AND e.run_id=a.id),0)+1,
            '{"type":"state","state":"interrupted","error":"服务重启，任务已中断；未自动重放。"}'
          FROM task_runs a JOIN tasks t ON t.space_id=a.space_id AND t.id=a.id WHERE t.state IN ('pending','running')`).run();
        db.prepare(`UPDATE task_runs SET error='服务重启，任务已中断；未自动重放。'
          WHERE (space_id,id) IN (SELECT space_id,id FROM tasks WHERE state IN ('pending','running'))`).run();
        db.prepare(`INSERT INTO agent_events(space_id,run_id,seq,value)
          SELECT a.space_id,a.id,COALESCE((SELECT MAX(seq) FROM agent_events e WHERE e.space_id=a.space_id AND e.run_id=a.id),0)+1,
            '{"type":"state","state":"interrupted","error":"服务重启，运行已中断；未自动重放。"}'
          FROM agent_runs a JOIN runs r ON r.space_id=a.space_id AND r.id=a.id WHERE r.state IN ('pending','running')`).run();
        db.prepare(`UPDATE agent_runs SET error='服务重启，运行已中断；未自动重放。'
          WHERE (space_id,id) IN (SELECT space_id,id FROM runs WHERE state IN ('pending','running'))`).run();
        db.prepare("UPDATE runs SET state='interrupted' WHERE state IN ('pending','running')").run();
        db.prepare("UPDATE tasks SET state='interrupted' WHERE state IN ('pending','running')").run();
      })();
    } catch (error) { db.close(); throw error; }
    let closed = false;
    return { root, db, close() {
      if (closed) return;
      closed = true;
      try { db.close(); } finally { lock.close(); }
    } };
  } catch (error) { lock.close(); throw error; }
}
