import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startupEnvironment } from '@teach-me-coding/contracts/startup';
import { dataDirectory } from '../storage/data-directory.js';
import { FileCredentialStore } from '../models/credentials.js';
import { ModelService } from '../models/service.js';

/** Paid checks share saved auth, never the learning database's write/recovery path. */
export async function openSavedModel(root = dataDirectory(startupEnvironment())) {
  for (const name of ['app.lock', 'app.db', 'credentials.json']) {
    const info = lstatSync(join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Saved model files must be regular files.');
  }
  const lock = new Database(join(root, 'app.lock'), { timeout: 0, fileMustExist: true });
  let db: Database.Database | undefined, models: ModelService | undefined;
  try {
    try { lock.exec('BEGIN EXCLUSIVE'); }
    catch { throw new Error('Stop the instance using this data directory before running a provider check.'); }
    db = new Database(join(root, 'app.db'), { readonly: true, fileMustExist: true });
    models = new ModelService(db, { credentials: new FileCredentialStore(join(root, 'credentials.json')) });
    await models.refresh();
    const choice = models.current();
    if (!choice) throw new Error('Save a model selection and credentials in this instance before running a provider check.');
    return { models, ...choice, close() { models!.close(); db!.close(); lock.close(); } };
  } catch (error) { models?.close(); db?.close(); lock.close(); throw error; }
}
